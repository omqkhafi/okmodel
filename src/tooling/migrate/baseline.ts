/**
 * `okm migrate baseline` records the head snapshot as applied history on an
 * existing database without running schema changes (D299).
 *
 * The live catalog is introspected and planned against the head. A difference
 * on managed objects is refused. Objects the model does not name are reported
 * as unmanaged and are left alone. The write is only `okm_meta` and
 * `okm_history`. A protected target needs `--allow-protected` (history-repair).
 */

import postgres from "postgres";

import { open } from "../../adapters/pg/postgresjs.js";
import { startupCatalog } from "../../contracts/catalog/document.js";
import { identityKey, identityLabel } from "../../contracts/catalog/identity.js";
import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { attachCliDetail } from "../errors/shape.js";
import { untrustedText } from "../untrusted.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { introspectSchema } from "../../dialects/pg/introspect.js";
import { sealViews } from "../../dialects/pg/view/scratch.js";
import type { RolesInput } from "../../dialects/pg/role/index.js";
import { ensureMigrationTables } from "./apply.js";
import { driverUrl } from "./driver-url.js";
import {
  catalogQuery,
  invalidIndexReport,
  managedRoleOptions,
  sealStoredChecks,
  sealTriggerWhens,
} from "./drift.js";
import { catalogNamespace } from "./export.js";
import { loadHeadSnapshot } from "./files.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { omitManagedObjects } from "./managed.js";
import { projectContext, projectPath, type ProjectContext } from "./paths.js";
import { formatPlan, planMigration } from "./plan.js";
import {
  assertDirectConnection,
  assertTargetPolicy,
  selectTarget,
  type InvokeFlags,
} from "./policy.js";
import { probeStableBackend } from "./pooler-probe.js";
import { loadConfig } from "./project.js";
import { grantAppMeta } from "./runner.js";
import { baselineMark } from "./snapshot.js";

/** One object present in the database and absent from the model. */
export type BaselineUnmanaged = {
  readonly kind: CatalogObject["kind"];
  readonly name: string;
};

/** Outcome of {@link baselineProject} / {@link baseline}. */
export type BaselineReport = {
  readonly target: string;
  /** History id that was or would be written (`baselined@<id>`). */
  readonly migrationId: string;
  readonly catalogHash: string;
  readonly status: "baselined" | "already-baselined" | "dry-run";
  readonly unmanaged: readonly BaselineUnmanaged[];
};

/** Flags {@link baselineProject} reads beyond the shared invoke set. */
export type BaselineFlags = InvokeFlags & {
  readonly dryRun?: boolean;
  readonly json?: boolean;
};

/**
 * Records the head snapshot as applied on one configured target.
 *
 * Same rules as `okm migrate baseline`. `default` is the `database` target.
 *
 * @param target - Configured target name
 * @param project - Project directory or context. Defaults to the process cwd
 * @returns The same text the CLI prints for a successful write
 */
export async function baseline(
  target: string,
  project: string | ProjectContext = process.cwd(),
): Promise<string> {
  return formatBaseline(
    await runBaseline(project, {
      target,
      allowProtected: false,
      allowPooler: false,
    }),
  );
}

/**
 * Runs `okm migrate baseline` for the selected target.
 *
 * @param project - Project directory or context (supports `--config`)
 * @param flags - Target, protection, pooler, dry-run, and json
 * @returns Text for stdout, including the trailing newline
 */
export async function baselineProject(
  project: string | ProjectContext,
  flags: BaselineFlags,
): Promise<string> {
  const report = await runBaseline(project, flags);
  if (flags.json === true) return `${JSON.stringify(reportJson(report), null, 2)}\n`;
  return formatBaseline(report);
}

async function runBaseline(
  project: string | ProjectContext,
  flags: BaselineFlags,
): Promise<BaselineReport> {
  const { cwd } = typeof project === "string" ? projectContext(project) : project;
  const config = await loadConfig(project);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "history-repair", flags.allowProtected);
  const allowPooler = flags.allowPooler || config.allowPooler === true;
  assertDirectConnection(target.url, allowPooler);
  const directory = projectPath(cwd, config.migrations ?? "migrations");
  const head = loadHeadSnapshot(directory);
  if (head === undefined) {
    throw new OkmError("invalid", "There is no head snapshot to baseline.", {
      fix: { summary: "Run okm generate so the project has a migration and catalog snapshot." },
    });
  }
  const mark = baselineMark(head.id);
  const catalogHash = head.catalogHash;
  const model = startupCatalog(head.catalog);
  const namespace = catalogNamespace(config);
  const url = driverUrl(target.url);
  const pool = open({
    url,
    max: 1,
    ...(namespace === "public" ? {} : { searchPath: namespace }),
  });
  if (pool.reserve === undefined) {
    await pool.close();
    throw new OkmError("invalid", "The driver cannot reserve a connection.", {
      fix: { summary: "Baseline needs a driver with interactive transactions." },
    });
  }
  const connection = await pool.reserve();
  let locked = false;
  try {
    await probeStableBackend(target.url, () => backendPid(connection), allowPooler);
    await enterCatalogSchema(connection, namespace);
    await lockTarget(connection, target.name);
    locked = true;
    const existing = await readExisting(connection);
    if (existing !== undefined) {
      if (existing.migrationId === mark && existing.catalogHash === catalogHash) {
        const unmanaged = await listUnmanaged(url, model, namespace, config.roles);
        return {
          target: target.name,
          migrationId: mark,
          catalogHash,
          status: "already-baselined",
          unmanaged,
        };
      }
      throw attachCliDetail(
        new OkmError(
          "OKM1857",
          `Target ${target.name} already has OKModel history (${existing.migrationId}).`,
          {
            kind: "forbidden",
            fix: {
              summary:
                "Baseline is for a database with no OKModel history. Use okm migrate status, or point at another target.",
            },
          },
        ),
        { detail: untrustedText(existing.migrationId, "db.object-name") },
      );
    }
    const compared = await compareLive(url, model, namespace, config.roles);
    if (compared.mismatch.length > 0) {
      throw attachCliDetail(
        new OkmError(
          "OKM1858",
          `Target ${target.name} does not match the model snapshot.\n${compared.mismatch.join("\n")}`,
          {
            fix: {
              summary:
                "Change the schema or the database until they match, then run okm migrate baseline again.",
            },
          },
        ),
        { detail: untrustedText(compared.mismatch.join("\n"), "user.query") },
      );
    }
    const report: BaselineReport = {
      target: target.name,
      migrationId: mark,
      catalogHash,
      status: flags.dryRun === true ? "dry-run" : "baselined",
      unmanaged: compared.unmanaged,
    };
    if (flags.dryRun === true) return report;
    await ensureMigrationTables((sql) => connection.execute(sql));
    await connection.execute("begin");
    try {
      await connection.execute(
        "insert into okm_history (migration_id, step_index, class, catalog_hash) values ($1, 0, 'expand', $2)",
        [mark, catalogHash],
      );
      await connection.execute(
        `insert into okm_meta (id, catalog_hash, migration_id) values ('head', $1, $2)
         on conflict (id) do update set catalog_hash = excluded.catalog_hash, migration_id = excluded.migration_id`,
        [catalogHash, mark],
      );
      await connection.execute("commit");
    } catch (error) {
      await connection.execute("rollback").catch(() => undefined);
      throw error;
    }
    const session: { setRole?: string } = {};
    await grantAppMeta(connection, config.roles?.app, session);
    return report;
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    if (locked) {
      await finishQuiet(() =>
        connection.execute("select pg_advisory_unlock(hashtext($1))", [`okm:${target.name}`]),
      );
    }
    await finishQuiet(() => connection.release());
    await finishQuiet(() => pool.close());
  }
}

/**
 * Formats a baseline report for humans.
 *
 * @param report - Result of a baseline run
 * @returns Text including the trailing newline
 */
export function formatBaseline(report: BaselineReport): string {
  const lines = [`target ${report.target}`];
  if (report.status === "already-baselined") {
    lines.push(`already baselined ${report.migrationId}`);
  } else if (report.status === "dry-run") {
    lines.push(`would baseline ${report.migrationId}`);
    lines.push(`catalog ${report.catalogHash}`);
  } else {
    lines.push(`baselined ${report.migrationId}`);
    lines.push(`catalog ${report.catalogHash}`);
  }
  if (report.unmanaged.length > 0) {
    lines.push("unmanaged");
    for (const item of report.unmanaged) {
      lines.push(`${item.kind}\t${item.name}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function reportJson(report: BaselineReport): Record<string, unknown> {
  return {
    target: report.target,
    migrationId: report.migrationId,
    catalogHash: report.catalogHash,
    status: report.status,
    unmanaged: report.unmanaged.map((item) => ({
      kind: item.kind,
      name: untrustedText(item.name, "db.object-name"),
    })),
  };
}

async function compareLive(
  url: string,
  model: Catalog,
  namespace: string,
  roles: RolesInput | undefined,
): Promise<{
  readonly unmanaged: readonly BaselineUnmanaged[];
  readonly mismatch: readonly string[];
}> {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
    ...(namespace !== "public" ? { connection: { search_path: namespace } } : {}),
  });
  try {
    if (namespace !== "public") {
      await sql.unsafe(`create schema if not exists ${quoteIdent(namespace)}`);
      await sql.unsafe(`set search_path to ${quoteIdent(namespace)}`);
    }
    const runner = catalogQuery(sql);
    const authorOnServer = await sealTriggerWhens(
      runner,
      await sealStoredChecks(runner, await sealViews(runner, model)),
    );
    const live = omitManagedObjects(
      await introspectSchema(runner, namespace, namespace, managedRoleOptions(roles)),
    );
    const modelKeys = new Set(authorOnServer.objects.map((object) => identityKey(object.identity)));
    const unmanagedObjects = live.objects.filter(
      (object) => !modelKeys.has(identityKey(object.identity)) && isUnmanagedKind(object),
    );
    const unmanagedKeys = new Set(unmanagedObjects.map((object) => identityKey(object.identity)));
    const managedLive: Catalog = {
      version: live.version,
      objects: live.objects.filter((object) => {
        const key = identityKey(object.identity);
        if (unmanagedKeys.has(key)) return false;
        return !childOfUnmanaged(object, unmanagedKeys);
      }),
    };
    const invalid = await invalidIndexReport(runner, namespace);
    const plan = planMigration({
      before: await sealStoredChecks(runner, managedLive),
      after: authorOnServer,
      name: "baseline",
      schema: namespace,
    });
    const unmanaged = unmanagedObjects
      .map((object) => ({
        kind: object.kind,
        name: identityLabel(object.identity),
      }))
      .sort((left, right) =>
        left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind.localeCompare(right.kind),
      );
    const planned =
      plan.steps.length === 0
        ? []
        : formatPlan(plan)
            .trimEnd()
            .split("\n")
            .filter((line) => line.length > 0);
    if (planned.length === 0 && invalid.length === 0) return { unmanaged, mismatch: [] };
    return { unmanaged, mismatch: [...invalid, ...planned] };
  } finally {
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
}

async function listUnmanaged(
  url: string,
  model: Catalog,
  namespace: string,
  roles: RolesInput | undefined,
): Promise<readonly BaselineUnmanaged[]> {
  const compared = await compareLive(url, model, namespace, roles);
  if (compared.mismatch.length > 0) {
    throw attachCliDetail(
      new OkmError(
        "OKM1858",
        `Target already baselined but no longer matches the model.\n${compared.mismatch.join("\n")}`,
        {
          fix: {
            summary:
              "Change the schema or the database until they match. Baseline does not rewrite history.",
          },
        },
      ),
      { detail: untrustedText(compared.mismatch.join("\n"), "user.query") },
    );
  }
  return compared.unmanaged;
}

function isUnmanagedKind(object: CatalogObject): boolean {
  switch (object.kind) {
    case "table":
    case "view":
    case "materializedView":
    case "function":
    case "trigger":
    case "extension":
    case "type":
    case "sequence":
    case "policy":
      return true;
    default:
      return false;
  }
}

function childOfUnmanaged(object: CatalogObject, unmanaged: ReadonlySet<string>): boolean {
  if (
    object.kind !== "column" &&
    object.kind !== "index" &&
    object.kind !== "constraint" &&
    object.kind !== "trigger" &&
    object.kind !== "policy"
  ) {
    return false;
  }
  const parent = object.identity.parent;
  return unmanaged.has(
    identityKey({ kind: "table", namespace: parent.namespace, name: parent.name }),
  );
}

async function readExisting(
  connection: DriverConnection,
): Promise<{ readonly migrationId: string; readonly catalogHash: string } | undefined> {
  const present = await connection.execute(
    "select (to_regclass('okm_meta') is not null), (to_regclass('okm_history') is not null)",
  );
  const hasMeta = wireTrue(present.rows[0]?.[0]);
  const hasHistory = wireTrue(present.rows[0]?.[1]);
  if (!hasMeta && !hasHistory) return undefined;
  if (hasMeta) {
    const meta = await connection.execute(
      "select catalog_hash, migration_id from okm_meta where id = 'head'",
    );
    const hash = meta.rows[0]?.[0];
    const id = meta.rows[0]?.[1];
    if (typeof hash === "string" && typeof id === "string") {
      return { catalogHash: hash, migrationId: id };
    }
  }
  if (hasHistory) {
    const rows = await connection.execute(
      "select migration_id, catalog_hash from okm_history order by migration_id, step_index limit 1",
    );
    const id = rows.rows[0]?.[0];
    const hash = rows.rows[0]?.[1];
    if (typeof id === "string" && typeof hash === "string") {
      return { catalogHash: hash, migrationId: id };
    }
    if (typeof id === "string") {
      return { catalogHash: "", migrationId: id };
    }
  }
  // Empty bootstrap tables: treat as no history so baseline can write.
  return undefined;
}

async function enterCatalogSchema(connection: DriverConnection, schema: string): Promise<void> {
  if (schema === "public") return;
  await connection.execute(`create schema if not exists ${quoteIdent(schema)}`);
  await connection.execute(`set search_path to ${quoteIdent(schema)}`);
}

async function lockTarget(connection: DriverConnection, target: string): Promise<void> {
  const result = await connection.execute("select pg_try_advisory_lock(hashtext($1))", [
    `okm:${target}`,
  ]);
  if (!wireTrue(result.rows[0]?.[0])) {
    throw new OkmError("OKM1522", `Another apply holds the lock for ${target}.`, {
      kind: "conflict",
      fix: {
        summary:
          "Wait for that apply to finish. Do not start a second baseline against the same target.",
      },
    });
  }
}

async function backendPid(connection: DriverConnection): Promise<string> {
  const result = await connection.execute("select pg_backend_pid()::text");
  const cell = result.rows[0]?.[0];
  return cell === null || cell === undefined ? "" : String(cell);
}

function wireTrue(value: string | boolean | null | undefined): boolean {
  return value === true || value === "t" || value === "true";
}
