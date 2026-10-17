/**
 * Replays `okm migrate check` inside one transaction and rolls it back.
 *
 * The scratch schema is created in that transaction. Nothing here updates a
 * system catalog or a real ACL. A step that cannot run in a transaction is
 * rewritten to the transactional form, or skipped and named.
 */

import postgres, { type Sql } from "postgres";

import { watchReserved } from "../../adapters/pg/postgres-extra.js";
import { catalog } from "../../contracts/catalog/build.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { isConnectionLost } from "../../contracts/connection.js";
import type { DriverConnection, ExecuteResult, WireValue } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { introspectSchema } from "../../dialects/pg/introspect.js";
import { roleExists } from "../../dialects/pg/role/check.js";
import { changesRole, createdRoleName, createRoleOnce } from "../../dialects/pg/role/sql.js";
import { sealViews } from "../../dialects/pg/view/scratch.js";
import { ensureMigrationTables } from "./apply.js";
import type { MigrateConfig } from "./config.js";
import { catalogQuery, managedRoleOptions } from "./drift.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { lintReprints, type Finding } from "./lint.js";
import { planMigration, type MigrationPlan, type PlanStep } from "./plan.js";
import { driverUrl } from "./driver-url.js";
import { probeStableBackend } from "./pooler-probe.js";
import { assumeRole, assertSchemaUsageLanded, grantSchema, ownSchema } from "./runner.js";
import { snapshotDifference } from "./snapshot.js";
import { sqlStatements } from "./sql-lex.js";

/** One migration the check replays. */
export type CheckMigration = {
  readonly id: string;
  readonly catalog: Catalog;
  readonly steps: readonly PlanStep[];
};

/** The first migration whose replay does not match its catalog. */
export type ReplayStop = {
  readonly index: number;
  readonly back: MigrationPlan;
};

/** Replay result. `skips` are statements check did not execute. */
export type ReplayOutcome = {
  readonly skips: readonly string[];
  readonly reprints: readonly Finding[];
  readonly stop?: ReplayStop;
};

type Session = { setRole?: string };

/**
 * Replays `history` in one transaction and rolls it back.
 *
 * @param url - Target URL
 * @param scratch - Schema created inside the transaction
 * @param config - Roles and timeouts
 * @param allowPooler - Passed through to the pooler guard
 * @param history - Migrations in apply order
 * @returns Skipped statements, and the first catalog mismatch
 */
export async function replayCheckHistory(
  url: string,
  scratch: string,
  config: MigrateConfig,
  allowPooler: boolean,
  history: readonly CheckMigration[],
): Promise<ReplayOutcome> {
  const skips: string[] = [];
  const reprints: Finding[] = [];
  let stop: ReplayStop | undefined;
  await inCheckTransaction(url, scratch, config, allowPooler, async (sql) => {
    const connection = driverOf(sql);
    const session: Session = {};
    for (let index = 0; index < history.length; index += 1) {
      const migration = history[index];
      if (migration === undefined) continue;
      await replayMigration(sql, connection, scratch, config, migration, session, skips);
      await restoreSession(sql, session);
      const runner = catalogQuery(sql);
      const live = await introspectSchema(
        runner,
        scratch,
        config.namespace ?? "public",
        managedRoleOptions(config.roles),
      );
      for (const item of lintReprints(migration.catalog, live, migration.steps)) {
        reprints.push({ ...item, place: `${migration.id} ${item.place}` });
      }
      const sealed = await sealViews(runner, migration.catalog);
      const back = planMigration({ before: live, after: sealed, name: migration.id });
      if (back.steps.length === 0) continue;
      stop = { index, back };
      return;
    }
  });
  return stop === undefined ? { skips, reprints } : { skips, reprints, stop };
}

/**
 * Compares a head snapshot with a full replay. Both run in rolled-back transactions.
 *
 * @param url - Target URL
 * @param provided - Scratch schema for the snapshot
 * @param replayed - Scratch schema for the history
 * @param config - Roles and timeouts
 * @param allowPooler - Passed through to the pooler guard
 * @param history - Migrations in apply order
 * @returns The difference, or `undefined` when the catalogs match
 */
export async function proveCheckSnapshot(
  url: string,
  provided: string,
  replayed: string,
  config: MigrateConfig,
  allowPooler: boolean,
  history: readonly CheckMigration[],
): Promise<string | undefined> {
  const head = history.at(-1);
  if (head === undefined) return undefined;
  const installed = await inCheckTransaction(url, provided, config, allowPooler, async (sql) => {
    const connection = driverOf(sql);
    const session: Session = {};
    const planned = planMigration({
      before: catalog([]),
      after: head.catalog,
      schema: provided,
      name: "provision",
    });
    await runSteps(
      sql,
      connection,
      provided,
      config.roles?.migration,
      {
        id: "snapshot",
        catalog: head.catalog,
        steps: retargetSteps(planned.steps, provided, config.namespace ?? "public"),
      },
      session,
      [],
    );
    await restoreSession(sql, session);
    return introspectSchema(
      catalogQuery(sql),
      provided,
      config.namespace ?? "public",
      managedRoleOptions(config.roles),
    );
  });
  const again = await inCheckTransaction(url, replayed, config, allowPooler, async (sql) => {
    const connection = driverOf(sql);
    const session: Session = {};
    for (const migration of history) {
      await replayMigration(sql, connection, replayed, config, migration, session, []);
    }
    await restoreSession(sql, session);
    return introspectSchema(
      catalogQuery(sql),
      replayed,
      config.namespace ?? "public",
      managedRoleOptions(config.roles),
    );
  });
  return snapshotDifference(installed, again);
}

/**
 * Rewrites the catalog schema to the scratch schema.
 *
 * `source` defaults to `public`. A foreign key aimed at another schema is
 * left in place.
 *
 * @param steps - Plan steps
 * @param schema - Scratch schema
 * @param source - Schema the statements currently name
 * @returns The same steps, aimed at `schema`
 */
export function retargetSteps(
  steps: readonly PlanStep[],
  schema: string,
  source = "public",
): readonly PlanStep[] {
  const from = `${quoteIdent(source)}.`;
  const to = `${quoteIdent(schema)}.`;
  const fromDefaults = `in schema ${quoteIdent(source)} `;
  const toDefaults = `in schema ${quoteIdent(schema)} `;
  const fromSchema = `on schema ${quoteIdent(source)}`;
  const toSchema = `on schema ${quoteIdent(schema)}`;
  return steps.map((step) => ({
    ...step,
    sql: step.sql
      .replaceAll(from, to)
      .replaceAll(fromDefaults, toDefaults)
      .replaceAll(fromSchema, toSchema),
    ...(step.backfill === undefined
      ? {}
      : { backfill: { ...step.backfill, table: step.backfill.table.replaceAll(from, to) } }),
  }));
}

async function inCheckTransaction<T>(
  url: string,
  scratch: string,
  config: MigrateConfig,
  allowPooler: boolean,
  run: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(driverUrl(url), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  const reserved = await sql.reserve();
  const lost = { on: false, stop: (): void => undefined };
  watchReserved(reserved, lost);
  refuseWhenLost(reserved, lost);
  let open = false;
  let failure: unknown;
  let value: T | undefined;
  let created = false;
  let sawCommit = false;
  // Set when ROLLBACK landed and the transaction id never changed. The schema
  // was created in that transaction, so nothing remains to drop.
  let rolledBack = false;
  let xid = "";
  try {
    await probeStableBackend(
      url,
      async () => {
        const rows = await reserved.unsafe("select pg_backend_pid()::text as pid");
        const pid = cell(rows[0], "pid");
        return pid ?? "";
      },
      allowPooler,
    );
    await reserved.unsafe("begin");
    open = true;
    xid = await readXid(reserved);
    await reserved.unsafe(`create schema ${quoteIdent(scratch)}`);
    created = true;
    await reserved.unsafe(`set local search_path to ${quoteIdent(scratch)}`);
    await setLocalTimeout(reserved, "lock_timeout", config.timeouts?.lock);
    await setLocalTimeout(reserved, "statement_timeout", config.timeouts?.statement);
    await ownScratch(reserved, scratch, config.roles?.migration);
    await ensureMigrationTables((text) => reserved.unsafe(text));
    value = await run(reserved);
    const after = await readXid(reserved).catch((error: unknown) => {
      if (isConnectionLost(error)) lost.on = true;
      return undefined;
    });
    if (!lost.on && after !== xid) {
      sawCommit = true;
      throw xidChanged();
    }
    if (!lost.on) {
      await reserved.unsafe("rollback");
      rolledBack = true;
    }
    open = false;
  } catch (error) {
    if (isConnectionLost(error)) lost.on = true;
    failure = error;
  } finally {
    if (open && !lost.on && !sawCommit) {
      const after = await readXid(reserved).catch((error: unknown) => {
        if (isConnectionLost(error)) lost.on = true;
        return undefined;
      });
      if (!lost.on && after !== xid) sawCommit = true;
    }
    if (open && !lost.on) {
      await reserved.unsafe("rollback").catch((error: unknown) => {
        if (isConnectionLost(error)) lost.on = true;
      });
      if (!lost.on && !sawCommit) rolledBack = true;
    }
    if (!lost.on) await reserved.unsafe("reset role").catch(() => undefined);
    if (!lost.on) {
      try {
        reserved.release();
      } catch {
        lost.on = true;
      }
    }
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
  if (!created || rolledBack) {
    if (failure !== undefined) throw sessionFailure(failure) ?? failure;
    return value as T;
  }
  const left = await dropScratch(url, scratch);
  if (left !== undefined) {
    const note = `Scratch schema ${left} is still present.`;
    failure =
      failure === undefined
        ? new OkmError("unavailable", note, { kind: "unavailable", fix: UNAVAILABLE_FIX })
        : noteOn(failure, note);
  }
  if (failure !== undefined) throw sessionFailure(failure) ?? failure;
  return value as T;
}

const UNAVAILABLE_FIX = {
  summary:
    "The connection to Postgres closed. Run the command again when the database is reachable.",
};

/**
 * Stops a later statement from writing after the reserved socket has closed.
 *
 * `watchReserved` records the close. This wrapper reads that flag before
 * `socket.write`, including the `setImmediate` write postgres.js queues.
 *
 * @param sql - Reserved connection
 * @param lost - Set when that socket closes
 */
function refuseWhenLost(sql: Sql, lost: { on: boolean }): void {
  const unsafe = sql.unsafe.bind(sql);
  sql.unsafe = ((text: string, params?: unknown, options?: object) => {
    if (lost.on) return Promise.reject(closedError());
    const pending =
      options !== undefined
        ? unsafe(text, params as never, options as never)
        : params !== undefined
          ? unsafe(text, params as never)
          : unsafe(text);
    return pending.catch((error: unknown) => {
      if (isConnectionLost(error)) lost.on = true;
      throw error;
    });
  }) as Sql["unsafe"];
}

function closedError(): Error {
  return Object.assign(new Error("CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" });
}

/**
 * Drops a scratch schema on a new connection.
 *
 * Called only when the replay did not roll back. A killed backend has already
 * aborted an uncommitted schema. A step that committed can leave it behind.
 *
 * @param url - Target URL
 * @param scratch - Schema name
 * @returns The name when it is still present, or when the drop could not be confirmed
 */
async function dropScratch(url: string, scratch: string): Promise<string | undefined> {
  const sql = postgres(driverUrl(url), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    await sql.unsafe(`drop schema if exists ${quoteIdent(scratch)} cascade`);
    const rows = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname = ${scratch}
    `;
    return rows.length > 0 ? scratch : undefined;
  } catch {
    return scratch;
  } finally {
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
}

function noteOn(error: unknown, note: string): unknown {
  if (error instanceof Error) {
    return new OkmError("unavailable", `${error.message} ${note}`, {
      kind: "unavailable",
      cause: error,
      fix: UNAVAILABLE_FIX,
    });
  }
  return new OkmError("unavailable", note, { kind: "unavailable", fix: UNAVAILABLE_FIX });
}

async function restoreSession(sql: Sql, session: Session): Promise<void> {
  if (session.setRole === undefined) return;
  await sql.unsafe("reset role");
  delete session.setRole;
}

async function replayMigration(
  sql: Sql,
  connection: DriverConnection,
  scratch: string,
  config: MigrateConfig,
  migration: CheckMigration,
  session: Session,
  skips: string[],
): Promise<void> {
  await runSteps(
    sql,
    connection,
    scratch,
    config.roles?.migration,
    { ...migration, steps: retargetSteps(migration.steps, scratch, config.namespace ?? "public") },
    session,
    skips,
  );
}

async function runSteps(
  sql: Sql,
  connection: DriverConnection,
  scratch: string,
  migrationRole: string | undefined,
  migration: CheckMigration,
  session: Session,
  skips: string[],
): Promise<void> {
  for (let index = 0; index < migration.steps.length; index += 1) {
    const step = migration.steps[index];
    if (step === undefined) continue;
    const prepared = prepareCheckSql(step.sql);
    if (prepared.skip !== undefined) {
      skips.push(`${migration.id} step ${String(index + 1)}: ${prepared.skip}`);
    }
    if (prepared.sql.length === 0) continue;
    try {
      if (
        migrationRole !== undefined &&
        !changesRole(step.sql) &&
        session.setRole !== migrationRole &&
        (await roleExists(connection, migrationRole))
      ) {
        await assumeRole(connection, migrationRole, session);
      }
      const created = createdRoleName(step.sql);
      const existed = created !== undefined && (await roleExists(connection, created));
      if (step.backfill !== undefined) {
        await sql.unsafe(prepared.sql, [null, null]);
      } else if (created === undefined) {
        await sql.unsafe(prepared.sql);
        await assertSchemaUsageLanded(connection, prepared.sql);
      } else if (!existed) {
        await sql.unsafe(createRoleOnce(prepared.sql.replace(/;\s*$/, "")));
      }
      if (created !== undefined && created === migrationRole && !existed) {
        await grantSchema(connection, scratch, created);
        await ownSchema(connection, scratch, created);
        await connection.execute(
          `grant select, insert, update on okm_meta, okm_history, okm_backfill to ${quoteIdent(created)}`,
        );
      }
    } catch (error) {
      throw failStep(migration.id, index, error);
    }
  }
  if (
    migrationRole !== undefined &&
    session.setRole !== migrationRole &&
    (await roleExists(connection, migrationRole))
  ) {
    await assumeRole(connection, migrationRole, session);
  }
}

function prepareCheckSql(sql: string): { readonly sql: string; readonly skip?: string } {
  const parts = sqlStatements(sql);
  const source = parts.length === 0 ? [sql] : parts;
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const statement of source) {
    const kind = skipKind(statement);
    if (kind !== undefined) {
      skipped.push(kind);
      continue;
    }
    kept.push(rewriteConcurrent(statement));
  }
  return {
    sql: kept.length === 0 ? "" : `${kept.join(";\n")};`,
    ...(skipped.length > 0 ? { skip: skipped.join(", ") } : {}),
  };
}

function skipKind(sql: string): string | undefined {
  const text = sql.trim().replace(/\s+/g, " ").toLowerCase();
  if (text.startsWith("vacuum")) return "VACUUM is not run inside the check transaction";
  if (/^(?:create|drop)\s+database\b/.test(text)) {
    return "CREATE or DROP DATABASE is not run inside the check transaction";
  }
  if (text.startsWith("alter system"))
    return "ALTER SYSTEM is not run inside the check transaction";
  return undefined;
}

function rewriteConcurrent(sql: string): string {
  const text = sql.trim().replace(/\s+/g, " ").toLowerCase();
  if (
    /^(?:create\s+(?:unique\s+)?index|drop\s+index|reindex|refresh\s+materialized\s+view)\b/.test(
      text,
    )
  ) {
    return sql.replace(/\s+concurrently\b/gi, "");
  }
  return sql;
}

async function ownScratch(sql: Sql, scratch: string, role: string | undefined): Promise<void> {
  if (role === undefined) return;
  const exists = await sql.unsafe(
    "select exists (select 1 from pg_roles where rolname = $1) as ok",
    [role],
  );
  const present = cell(exists[0], "ok");
  if (present === "t" || present === "true") {
    await sql.unsafe(`alter schema ${quoteIdent(scratch)} owner to ${quoteIdent(role)}`);
  }
}

async function setLocalTimeout(sql: Sql, name: string, ms: number | undefined): Promise<void> {
  if (ms === undefined) return;
  await sql.unsafe("select set_config($1, $2, true)", [name, String(ms)]);
}

async function readXid(sql: Sql): Promise<string> {
  const rows = await sql.unsafe("select pg_current_xact_id()::text as xid");
  return cell(rows[0], "xid") ?? "";
}

function cell(row: unknown, key: string): string | undefined {
  if (typeof row !== "object" || row === null || !(key in row)) return undefined;
  const value: unknown = Reflect.get(row, key);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

function xidChanged(): OkmError {
  return new OkmError(
    "invalid",
    "okm migrate check left its transaction. A step committed, so the replay did not stay in one transaction.",
    {
      kind: "invalid",
      fix: {
        summary:
          "Remove COMMIT, ROLLBACK, and other transaction control from the step. The check always rolls the replay back.",
      },
    },
  );
}

function failStep(id: string, index: number, error: unknown): OkmError {
  const lost = sessionFailure(error);
  if (lost !== undefined) {
    return new OkmError(
      lost.code,
      `Migration ${id} failed at step ${String(index + 1)}: ${lost.message}`,
      { kind: lost.kind, cause: error, fix: lost.fix },
    );
  }
  if (error instanceof OkmError) return error;
  const message = error instanceof Error ? error.message : "The step failed.";
  return new OkmError(
    "invalid",
    `Migration ${id} failed at step ${String(index + 1)}: ${message}`,
    {
      cause: error,
      fix: { summary: "Fix the step and run apply again. Finished steps are not repeated." },
    },
  );
}

function driverOf(sql: Sql): DriverConnection {
  return {
    async execute(text, params): Promise<ExecuteResult> {
      const query =
        params === undefined || params.length === 0
          ? sql.unsafe(text)
          : sql.unsafe(text, [...params] as string[]);
      const rows = await query;
      const wire = Array.from(rows, (row) => cells(row));
      return { rows: wire, count: rows.count ?? wire.length, notices: [] };
    },
    batch() {
      return Promise.reject(new Error("okm migrate check does not batch."));
    },
    release() {
      return Promise.resolve();
    },
  };
}

function cells(row: unknown): WireValue[] {
  const values = Array.isArray(row) ? row : Object.values(row as Record<string, unknown>);
  return values.map((value: unknown) => {
    if (value === null || value === undefined) return null;
    if (value === true) return "t";
    if (value === false) return "f";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    return null;
  });
}
