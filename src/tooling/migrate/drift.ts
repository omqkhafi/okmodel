/**
 * Live drift for `okm check`.
 *
 * A database that has never been pushed has no `okm_meta` and is left alone.
 * After push, the introspected catalog is planned back to the schema. Each
 * view is reprinted on this server first, so a `pg_get_viewdef` spelling is
 * not drift. Any remaining statement is OKM1520. `okm_meta`, `okm_history`,
 * and `okm_backfill` are omitted by the planner.
 */

import postgres, { type Sql } from "postgres";

import { OkmError } from "../../contracts/error.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { isDomain } from "../../contracts/catalog/enum.js";
import type { CatalogObject } from "../../contracts/catalog/types.js";
import {
  introspectSchema,
  invalidIndexNames,
  reprintCheck,
  reprintDomainCheck,
  reprintGenerated,
  reprintTriggerWhen,
  type CatalogQuery,
  type IntrospectOptions,
  type ReprintCheckColumn,
  type ReprintType,
} from "../../dialects/pg/introspect.js";
import { sealViews } from "../../dialects/pg/view/scratch.js";
import type { RolesInput } from "../../dialects/pg/role/index.js";
import { planMigration } from "./plan.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { driverUrl } from "./driver-url.js";
import { assertDirectConnection } from "./policy.js";
import { probeStableBackend } from "./pooler-probe.js";

/**
 * Refuses when the connected database differs from the schema.
 *
 * @param url - Target URL
 * @param author - Schema catalog, including roles when the config names them
 * @param roles - `defineConfig({ roles })`, when set
 */
export async function assertAuthorDrift(
  url: string,
  author: Catalog,
  roles?: RolesInput,
  allowPooler = false,
): Promise<void> {
  assertDirectConnection(url, allowPooler);
  const schema = authorSchema(author);
  // pg_get_viewdef qualifies a table that is not on the search path, so a
  // namespace's views would read back as `appns.tasks` and never match.
  const sql = postgres(driverUrl(url), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
    ...(schema !== "public" ? { connection: { search_path: quoteIdent(schema) } } : {}),
  });
  try {
    await probeStableBackend(
      url,
      async () => {
        const rows = await sql<{ pid: string }[]>`select pg_backend_pid()::text as pid`;
        return rows[0]?.pid ?? "";
      },
      allowPooler,
    );
    const present = await sql<{ reg: string | null }[]>`
      select to_regclass(${metaReg(schema)})::text as reg
    `;
    if (present[0]?.reg == null) return;
    const runner = catalogQuery(sql);
    const authorOnServer = await sealTriggerWhens(
      runner,
      await sealStoredChecks(runner, await sealViews(runner, author)),
    );
    const live = await sealStoredChecks(
      runner,
      await introspectSchema(runner, schema, schema, managedRoleOptions(roles)),
    );
    const invalid = await invalidIndexReport(runner, schema);
    const plan = planMigration({ before: live, after: authorOnServer, name: "check", schema });
    if (invalid.length === 0 && plan.steps.length === 0) return;
    const weaker = unvalidatedNotNull(live, authorOnServer);
    const sqlText = plan.steps.map((step) => step.sql).join("\n");
    throw new OkmError(
      "OKM1520",
      `The database differs from the schema.\n${[...invalid, sqlText].filter((line) => line.length > 0).join("\n")}${weaker}`,
      {
        fix: {
          summary:
            invalid.length > 0
              ? "Drop the INVALID index with DROP INDEX CONCURRENTLY, then run apply again."
              : "Change the schema or the database so okm check reports no difference.",
        },
      },
    );
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
}

/**
 * Lines for indexes a killed concurrent build left behind, and started steps.
 *
 * An invalid index is omitted from the catalog, so a plan would otherwise
 * try to create it again. The lines name the index and any `okm_steps` row
 * still in `started`.
 *
 * @param runner - Database connection
 * @param schema - Concrete schema the live catalog was read from
 * @returns Empty when every index is valid
 */
export async function invalidIndexReport(
  runner: CatalogQuery,
  schema: string,
): Promise<readonly string[]> {
  const names = await invalidIndexNames(runner, schema);
  if (names.length === 0) return [];
  const lines = names.map((name) => `Index ${name} is INVALID (pg_index.indisvalid is false).`);
  const present = await runner.query(`select to_regclass('okm_steps')::text as reg`);
  if (present[0]?.["reg"] == null) return lines;
  const steps = await runner.query(
    `select migration_id, step_index::text as step_index
     from okm_steps
     where state = 'started'
     order by migration_id, step_index`,
  );
  for (const row of steps) {
    const id = row["migration_id"];
    const index = row["step_index"];
    if (typeof id !== "string" || (typeof index !== "string" && typeof index !== "number")) {
      continue;
    }
    lines.push(`okm_steps ${id} step ${String(index)} is started.`);
  }
  return lines;
}

/**
 * Lines naming each column the schema declares NOT NULL while the database
 * holds the constraint unvalidated (PostgreSQL 18 `NOT NULL … NOT VALID`).
 * Rows with NULL may exist, so the database is weaker than the schema even
 * though `attnotnull` is set. Empty when there is no such column.
 */
function unvalidatedNotNull(live: Catalog, author: Catalog): string {
  const required = new Set<string>();
  for (const object of author.objects) {
    if (object.kind !== "column" || object.definition.nullable) continue;
    required.add(`${object.identity.parent.name}.${object.identity.name}`);
  }
  const lines: string[] = [];
  for (const object of live.objects) {
    if (object.kind !== "column" || object.definition.unvalidatedNotNull === undefined) continue;
    const label = `${object.identity.parent.name}.${object.identity.name}`;
    if (!required.has(label)) continue;
    lines.push(
      `\n${label} is NOT NULL NOT VALID (${object.definition.unvalidatedNotNull}) in the database; rows with NULL may exist.`,
    );
  }
  return lines.join("");
}

/**
 * Reprints each domain check the way this server stores it.
 *
 * Author spellings such as `VALUE > 0` become `((VALUE > 0))`, so a plan
 * against a live catalog does not treat the reprint as a permanent change.
 * The catalog hash still uses the author text (B-37).
 *
 * @param runner - Database connection
 * @param source - Catalog whose domain checks may still be author SQL
 * @returns A catalog whose domain checks carry the server reprint
 */
export async function sealDomainChecks(runner: CatalogQuery, source: Catalog): Promise<Catalog> {
  const types = reprintTypes(source);
  const objects: CatalogObject[] = [];
  let changed = false;
  for (const object of source.objects) {
    if (object.kind !== "type" || !isDomain(object.definition)) {
      objects.push(object);
      continue;
    }
    const reprinted = await reprintDomainCheck(
      runner,
      object.definition.base,
      object.definition.check,
      types,
    );
    if (reprinted === object.definition.check) {
      objects.push(object);
      continue;
    }
    changed = true;
    objects.push({
      ...object,
      definition: { ...object.definition, check: reprinted },
    });
  }
  return changed ? { version: source.version, objects } : source;
}

/**
 * Reprints table and domain checks to the text Postgres stores.
 *
 * Author and live catalogs both go through this before they are planned
 * against each other. A check or generated expression applied from author SQL
 * and the same text applied from an earlier reprint then compare equal. The
 * catalog hash still uses the author text.
 *
 * @param runner - Database connection
 * @param source - Catalog whose checks may still be author SQL or one reprint
 * @returns A catalog whose check expressions carry the stable server text
 */
export async function sealStoredChecks(runner: CatalogQuery, source: Catalog): Promise<Catalog> {
  return sealGeneratedColumns(
    runner,
    await sealTableChecks(runner, await sealDomainChecks(runner, source)),
  );
}

/**
 * Reprints each generated expression the way this server stores it.
 *
 * `("a" + 1)` becomes `(a + 1)`. A plan against a live catalog does not
 * treat that reprint as a permanent change. The catalog hash still uses the
 * author text.
 *
 * @param runner - Database connection
 * @param source - Catalog whose generated expressions may still be author SQL
 * @returns A catalog whose generated expressions carry the server reprint
 */
export async function sealGeneratedColumns(
  runner: CatalogQuery,
  source: Catalog,
): Promise<Catalog> {
  const columnsByTable = tableColumns(source);
  const types = reprintTypes(source);
  const objects: CatalogObject[] = [];
  let changed = false;
  for (const object of source.objects) {
    if (object.kind !== "column" || object.definition.generated === undefined) {
      objects.push(object);
      continue;
    }
    const parent = object.identity.parent.name;
    const siblings = (columnsByTable.get(parent) ?? []).filter(
      (column) => column.name !== object.identity.name,
    );
    const reprinted = await reprintGenerated(
      runner,
      object.definition.generated.expression,
      { name: object.identity.name, dataType: object.definition.dataType },
      siblings,
      types,
    );
    if (reprinted === object.definition.generated.expression) {
      objects.push(object);
      continue;
    }
    changed = true;
    objects.push({
      ...object,
      definition: {
        ...object.definition,
        generated: { ...object.definition.generated, expression: reprinted },
      },
    });
  }
  return changed ? { version: source.version, objects } : source;
}

/**
 * Reprints each table check the way this server stores it.
 *
 * Picklists and `IN (...)` checks become `= ANY (ARRAY[...])` (and
 * `varchar(n)` adds its casts). The reprint is the text Postgres stores when
 * that statement is applied, not the first printer pass, so push and check
 * agree. The catalog hash still uses the author text (D128, §19.3).
 *
 * @param runner - Database connection
 * @param source - Catalog whose table checks may still be author SQL
 * @returns A catalog whose table-check expressions carry the server reprint
 */
export async function sealTableChecks(runner: CatalogQuery, source: Catalog): Promise<Catalog> {
  const columnsByTable = tableColumns(source);
  const types = reprintTypes(source);
  const objects: CatalogObject[] = [];
  let changed = false;
  for (const object of source.objects) {
    if (
      object.kind !== "constraint" ||
      object.definition.constraintKind !== "check" ||
      object.definition.expression === undefined
    ) {
      objects.push(object);
      continue;
    }
    const parent = object.identity.parent.name;
    const reprinted = await reprintCheck(
      runner,
      object.definition.expression,
      columnsByTable.get(parent) ?? [],
      types,
    );
    if (reprinted === object.definition.expression) {
      objects.push(object);
      continue;
    }
    changed = true;
    objects.push({
      ...object,
      definition: { ...object.definition, expression: reprinted },
    });
  }
  return changed ? { version: source.version, objects } : source;
}

/**
 * Reprints each trigger `WHEN` the way this server prints it.
 *
 * `OLD.n IS DISTINCT FROM NEW.n` in any keyword case, with or without outer
 * parentheses, becomes the text `pg_get_triggerdef` prints, so a plan against
 * a live catalog does not drop and recreate the trigger every time. The
 * catalog hash still uses the author text.
 *
 * @param runner - Database connection
 * @param source - Catalog whose trigger conditions may still be author SQL
 * @returns A catalog whose trigger `WHEN` text carries the server reprint
 */
export async function sealTriggerWhens(runner: CatalogQuery, source: Catalog): Promise<Catalog> {
  const columnsByTable = tableColumns(source);
  const types = reprintTypes(source);
  const objects: CatalogObject[] = [];
  let changed = false;
  for (const object of source.objects) {
    if (object.kind !== "trigger" || object.definition.when === undefined) {
      objects.push(object);
      continue;
    }
    const reprinted = await reprintTriggerWhen(
      runner,
      object.definition.when,
      object.definition,
      columnsByTable.get(object.identity.parent.name) ?? [],
      types,
    );
    if (reprinted === undefined || reprinted === object.definition.when) {
      objects.push(object);
      continue;
    }
    changed = true;
    objects.push({ ...object, definition: { ...object.definition, when: reprinted } });
  }
  return changed ? { version: source.version, objects } : source;
}

function reprintTypes(source: Catalog): readonly ReprintType[] {
  const types: ReprintType[] = [];
  for (const object of source.objects) {
    if (object.kind !== "type") continue;
    types.push(
      isDomain(object.definition)
        ? { name: object.identity.name, base: object.definition.base }
        : { name: object.identity.name, labels: object.definition.labels },
    );
  }
  return types;
}

function tableColumns(source: Catalog): ReadonlyMap<string, readonly ReprintCheckColumn[]> {
  const grouped = new Map<string, ReprintCheckColumn[]>();
  for (const object of source.objects) {
    if (object.kind !== "column") continue;
    const parent = object.identity.parent.name;
    const list = grouped.get(parent) ?? [];
    list.push({ name: object.identity.name, dataType: object.definition.dataType });
    grouped.set(parent, list);
  }
  return grouped;
}

/**
 * Turns a postgres.js handle into the query shape introspection uses.
 *
 * @param sql - One connection
 * @returns A {@link CatalogQuery}
 */
export function catalogQuery(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

/**
 * Role names introspection should read, when the config names them.
 *
 * @param roles - `defineConfig({ roles })`, when set
 * @returns The introspect option, or `undefined` when roles are not configured
 */
export function managedRoleOptions(roles: RolesInput | undefined): IntrospectOptions | undefined {
  const names = managedRoleNames(roles);
  return names === undefined
    ? undefined
    : {
        managedRoles: names,
        ...(roles?.reporting !== undefined ? { reportingRole: roles.reporting } : {}),
      };
}

function authorSchema(author: Catalog): string {
  for (const object of author.objects) {
    if (
      object.kind === "table" &&
      object.owner !== "external" &&
      object.identity.namespace.form === "static"
    ) {
      return object.identity.namespace.name;
    }
  }
  return "public";
}

function metaReg(schema: string): string {
  if (schema === "public") return "public.okm_meta";
  return `${quoteIdent(schema)}.okm_meta`;
}

function managedRoleNames(roles: RolesInput | undefined): readonly string[] | undefined {
  if (roles === undefined) return undefined;
  const names = new Set<string>([roles.migration, roles.app]);
  if (roles.reporting !== undefined) names.add(roles.reporting);
  for (const role of roles.managed ?? []) names.add(role.name);
  return [...names];
}
