/**
 * Applies migrations on one target.
 *
 * A run holds a session advisory lock. Transactional steps of one migration
 * share a transaction. Steps Postgres cannot run there (`CREATE INDEX
 * CONCURRENTLY`, `ADD VALUE`, `VACUUM`) and backfill steps are their own
 * units. {@link runTarget} runs those units. Each finished step is a history
 * row. A later apply skips those rows. A backfill records each committed
 * batch in `okm_backfill` and resumes from that boundary.
 */

import { join } from "node:path";

import { open } from "../../adapters/pg/postgresjs.js";
import { catalogHash } from "../../contracts/catalog/document.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { hasError, lintMigrationDirectory, lintRefusal } from "./lint.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { assertCreateRole, currentUser, roleExists } from "../../dialects/pg/role/check.js";
import { changesRole } from "../../dialects/pg/role/sql.js";
import { batchSizeField } from "./backfill.js";
import {
  assumeRole,
  runTarget,
  statementOutsideTransaction,
  type BackfillBatch,
} from "./runner.js";
import { assertExtensionsAvailable } from "./extensions.js";
import { assertUuidV7Available } from "./engine.js";
import { loadBuiltSchema, loadConfig, projectHead } from "./project.js";
import { loadHeadSnapshot, loadMigrations } from "./files.js";
import { readReference, referenceInserts, type ReferenceTable } from "./reference.js";
import { expandProvisioned, installSnapshot, provisionMark } from "./snapshot.js";
import { planMigration, type PlanStep } from "./plan.js";
import type { StoredMigration } from "./files.js";
import {
  assertDirectConnection,
  assertTargetPolicy,
  selectTarget,
  type InvokeFlags,
} from "./policy.js";

/** One step with its index in the migration file. */
export type IndexedStep = {
  readonly index: number;
  readonly step: PlanStep;
};

/** Steps that commit together, or one step that cannot. */
export type ApplyUnit = {
  readonly migrationId: string;
  readonly catalogHash: string;
  /** True when this unit is the last step of its migration. */
  readonly finishes: boolean;
  readonly transactional: boolean;
  readonly steps: readonly IndexedStep[];
};

/** What {@link applyTarget} needs. The URL is resolved by the caller. */
export type ApplyRequest = {
  readonly url: string;
  readonly target: string;
  readonly protected: boolean;
  readonly allowProtected?: boolean;
  readonly allowPooler?: boolean;
  readonly searchPath?: string;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly retries?: number;
  readonly migrations: readonly StoredMigration[];
  /** Runs after the advisory lock is held and before the first step. */
  readonly onLocked?: () => void;
  /**
   * Role that runs the migration.
   *
   * When it already exists and is not `current_user`, the runner issues one
   * `SET ROLE` before any statement. That statement is not a plan step.
   */
  readonly migrationRole?: string;
  /**
   * Schema the migration role may create in.
   *
   * When this run creates that role, the runner grants `USAGE` and `CREATE`
   * on this schema before `SET ROLE`. The default is `public`.
   */
  readonly schema?: string;
  /** Milliseconds to wait after each committed backfill batch. */
  readonly backfillPauseMs?: number;
  /** `statement_timeout` for one backfill batch. Falls back to {@link ApplyRequest.statementTimeoutMs}. */
  readonly backfillStatementTimeoutMs?: number;
  /** One line after each committed backfill batch. */
  readonly onProgress?: (line: string) => void;
  /** Runs after each committed backfill batch, before the pause. */
  readonly afterBatch?: (batch: BackfillBatch) => void | Promise<void>;
  /**
   * Migrations directory to lint before any DDL.
   *
   * Only a migration with a step missing from `okm_history` is checked.
   * `push` omits this: its steps are not files.
   */
  readonly lintDirectory?: string;
  /**
   * Head snapshot.
   *
   * Set by `okm migrate apply` and `provision()`. An empty target installs
   * this catalog instead of replaying files. `only` refuses a target that
   * is not empty (OKM1851) and does not fall through to replay.
   */
  readonly snapshot?: {
    readonly catalog: Catalog;
    readonly migrationId: string;
    readonly catalogHash: string;
    readonly reference: readonly ReferenceTable[];
    readonly only?: boolean;
  };
};

/** Migrations that ran at least one step in this invocation. */
export type ApplyReport = {
  readonly target: string;
  readonly applied: readonly string[];
  /** Set when the runner issued `SET ROLE` at session start. */
  readonly setRole?: string;
};

const DEFAULT_LOCK_MS = 5_000;
const DEFAULT_STATEMENT_MS = 30_000;
const DEFAULT_RETRIES = 3;

const META = `create table if not exists okm_meta (
  id text primary key,
  catalog_hash text not null,
  migration_id text not null
)`;

const HISTORY = `create table if not exists okm_history (
  migration_id text not null,
  step_index integer not null,
  class text not null,
  catalog_hash text not null,
  applied_at timestamptz not null default now(),
  primary key (migration_id, step_index)
)`;

const BACKFILL = `create table if not exists okm_backfill (
  migration_id text not null,
  step_index integer not null,
  last_key text,
  rows_touched bigint not null default 0,
  batches integer not null default 0,
  state text not null,
  updated_at timestamptz not null default now(),
  primary key (migration_id, step_index)
)`;

/**
 * Groups pending steps into the transactions apply will run.
 *
 * A step Postgres cannot run inside a transaction is its own unit even when
 * the plan marked it transactional.
 *
 * @param migration - One file
 * @param done - Keys `${migrationId}:${stepIndex}` already in history
 * @returns Units in apply order
 */
export function applyUnits(
  migration: StoredMigration,
  done: ReadonlySet<string>,
): readonly ApplyUnit[] {
  const pending: IndexedStep[] = [];
  for (let index = 0; index < migration.steps.length; index += 1) {
    if (done.has(`${migration.id}:${String(index)}`)) continue;
    const step = migration.steps[index];
    if (step !== undefined) pending.push({ index, step });
  }
  const units: ApplyUnit[] = [];
  let batch: IndexedStep[] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    const last = batch.at(-1);
    units.push({
      migrationId: migration.id,
      catalogHash: migration.catalogHash,
      finishes: last !== undefined && last.index === migration.steps.length - 1,
      transactional: true,
      steps: batch,
    });
    batch = [];
  };
  for (const item of pending) {
    if (
      item.step.backfill === undefined &&
      item.step.transactional &&
      !statementOutsideTransaction(item.step.sql)
    ) {
      batch.push(item);
      continue;
    }
    flush();
    units.push({
      migrationId: migration.id,
      catalogHash: migration.catalogHash,
      finishes: item.index === migration.steps.length - 1,
      transactional: false,
      steps: [item],
    });
  }
  flush();
  return units;
}

/**
 * Applies pending migrations on one target.
 *
 * The connection is reserved for the whole run so the advisory lock stays
 * session-scoped. Lock timeout retries that step, including `NOT VALID`,
 * `VALIDATE CONSTRAINT`, `SET NOT NULL`, `ADD CONSTRAINT … USING INDEX`, and
 * a concurrent index create or drop. Any other failure stops at that step.
 *
 * @param request - Target, flags, and the migrations to consider
 * @returns The target and the migration ids that ran
 */
export async function applyTarget(request: ApplyRequest): Promise<ApplyReport> {
  assertDirectConnection(request.url, request.allowPooler === true);
  const pool = open({
    url: request.url,
    max: 1,
    ...(request.searchPath !== undefined ? { searchPath: request.searchPath } : {}),
  });
  if (pool.reserve === undefined) {
    await pool.close();
    throw new OkmError("invalid", "The driver cannot reserve a connection.", {
      fix: { summary: "Apply needs a driver with interactive transactions." },
    });
  }
  const connection = await pool.reserve();
  let locked = false;
  try {
    await setTimeouts(connection, request);
    await lockTarget(connection, request.target);
    locked = true;
    request.onLocked?.();
    if (request.lintDirectory !== undefined) {
      await refusePendingLint(connection, request.lintDirectory, request.migrations);
    }
    const session: { setRole?: string } = {};
    await prepareMigrationRole(connection, request, session);
    await assertExtensionsAvailable(connection, request.migrations);
    await assertUuidV7Available(connection, request.migrations);
    const state = request.snapshot === undefined ? undefined : await targetState(connection);
    if (request.snapshot !== undefined && state !== undefined) {
      if (state.kind === "empty") {
        return await provisionEmpty(connection, request, session);
      }
      if (state.kind === "interrupted") throw interruptedProvision(request.target, state.object);
      if (state.kind === "occupied" || request.snapshot.only === true) {
        throw notEmpty(request.target, state.kind === "occupied" ? state.object : "okm_meta");
      }
    }
    await connection.execute(META);
    await connection.execute(HISTORY);
    await connection.execute(BACKFILL);
    const history = await readHistory(connection);
    const done = expandProvisioned(request.migrations, history.done, history.ids);
    const units = request.migrations.flatMap((migration) => applyUnits(migration, done));
    const report = await runTarget(
      connection,
      {
        policy: request,
        units,
        retries: request.retries ?? DEFAULT_RETRIES,
        lockTimeoutMs: request.lockTimeoutMs ?? DEFAULT_LOCK_MS,
        statementTimeoutMs: request.statementTimeoutMs ?? DEFAULT_STATEMENT_MS,
        backfillStatementTimeoutMs:
          request.backfillStatementTimeoutMs ?? request.statementTimeoutMs ?? DEFAULT_STATEMENT_MS,
        ...(request.backfillPauseMs !== undefined
          ? { backfillPauseMs: request.backfillPauseMs }
          : {}),
        ...(request.migrationRole !== undefined ? { migrationRole: request.migrationRole } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
        ...(request.onProgress !== undefined ? { onProgress: request.onProgress } : {}),
        ...(request.afterBatch !== undefined ? { afterBatch: request.afterBatch } : {}),
      },
      session,
    );
    if (request.snapshot !== undefined) {
      await insertReference(connection, request);
    }
    return report;
  } finally {
    if (locked)
      await connection.execute("select pg_advisory_unlock(hashtext($1))", [
        lockKey(request.target),
      ]);
    await connection.release();
    await pool.close();
  }
}

/**
 * Applies the migrations in the project to the selected target.
 *
 * Pending migrations are linted after `okm_history` is read and before any
 * DDL. A migration the target already applied is left as it ran.
 *
 * @param cwd - Project directory
 * @param flags - `--target`, protection, pooler, and timeouts
 * @param write - Receives each backfill progress line, including the newline
 * @returns Text for stdout, including the target name
 */
export async function applyProject(
  cwd: string,
  flags: InvokeFlags,
  write?: (text: string) => void,
): Promise<string> {
  const config = await loadConfig(cwd);
  const target = selectTarget(config, flags.target);
  const directory = joinMigrations(cwd, config.migrations);
  const migrations = loadMigrations(directory);
  const head = loadHeadSnapshot(directory);
  if (migrations.length === 0 || head === undefined)
    return `target ${target.name}\nnothing to apply\n`;
  const built = await loadBuiltSchema(cwd, config).catch((error: unknown) => {
    if (error instanceof OkmError && error.message.endsWith("must export a schema()."))
      return undefined;
    throw error;
  });
  const progress: string[] = [];
  const report = await applyTarget({
    url: target.url,
    target: target.name,
    protected: target.protected,
    allowProtected: flags.allowProtected,
    allowPooler: flags.allowPooler || config.allowPooler === true,
    ...(flags.lockTimeoutMs !== undefined
      ? { lockTimeoutMs: flags.lockTimeoutMs }
      : config.timeouts?.lock !== undefined
        ? { lockTimeoutMs: config.timeouts.lock }
        : {}),
    ...(flags.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: flags.statementTimeoutMs }
      : config.timeouts?.statement !== undefined
        ? { statementTimeoutMs: config.timeouts.statement }
        : {}),
    ...backfillTiming(config.backfill),
    migrations,
    snapshot: {
      catalog: head.catalog,
      migrationId: head.id,
      catalogHash: head.catalogHash,
      reference: built === undefined ? [] : readReference(built.tables, built.casing, head.catalog),
    },
    ...(config.roles !== undefined ? { migrationRole: config.roles.migration } : {}),
    lintDirectory: directory,
    onProgress: (line) => {
      if (write !== undefined) write(`${line}\n`);
      else progress.push(line);
    },
  });
  const summary = formatReport(report);
  if (write !== undefined || progress.length === 0) return summary;
  return `${progress.join("\n")}\n${summary}`;
}

/**
 * Prototype sync. Blocked on a protected target.
 *
 * A target named production is not special. Protection is the `protected`
 * flag (spec §19.8). The plan's statements run as one migration.
 *
 * @param cwd - Project directory
 * @param flags - Target and protection flags
 * @returns Text for stdout
 */
export async function pushProject(cwd: string, flags: InvokeFlags): Promise<string> {
  const config = await loadConfig(cwd);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "push", flags.allowProtected);
  const head = await projectHead(cwd);
  const plan = planMigration({
    before: head.previous,
    after: head.catalog,
    renames: head.renames,
    name: "push",
    ...batchSizeField(config.backfill?.batchSize),
  });
  if (plan.steps.length === 0) return `target ${target.name}\nno changes\n`;
  const report = await applyTarget({
    url: target.url,
    target: target.name,
    protected: target.protected,
    allowProtected: flags.allowProtected,
    allowPooler: flags.allowPooler || config.allowPooler === true,
    ...backfillTiming(config.backfill),
    migrations: [
      {
        id: "push",
        catalogHash: catalogHash(head.catalog),
        steps: plan.steps,
      },
    ],
    ...(config.roles !== undefined ? { migrationRole: config.roles.migration } : {}),
  });
  return formatReport(report);
}

/**
 * Pause and statement timeout `defineConfig({ backfill })` sets for a run.
 *
 * Omitted fields stay unset so the runner uses its built-in defaults.
 *
 * @param backfill - Config block, when the project set one
 * @returns The fields {@link applyTarget} reads
 */
export function backfillTiming(
  backfill:
    | {
        readonly pauseMs?: number;
        readonly statementTimeoutMs?: number;
      }
    | undefined,
): {
  readonly backfillPauseMs?: number;
  readonly backfillStatementTimeoutMs?: number;
} {
  return {
    ...(backfill?.pauseMs !== undefined ? { backfillPauseMs: backfill.pauseMs } : {}),
    ...(backfill?.statementTimeoutMs !== undefined
      ? { backfillStatementTimeoutMs: backfill.statementTimeoutMs }
      : {}),
  };
}

function formatReport(report: ApplyReport): string {
  const role = report.setRole !== undefined ? `set role ${report.setRole}\n` : "";
  if (report.applied.length === 0) return `target ${report.target}\n${role}nothing to apply\n`;
  return `target ${report.target}\n${role}${report.applied.map((id) => `applied ${id}`).join("\n")}\n`;
}

function joinMigrations(cwd: string, migrations: string | undefined): string {
  return join(cwd, migrations ?? "migrations");
}

async function setTimeouts(connection: DriverConnection, request: ApplyRequest): Promise<void> {
  const lock = request.lockTimeoutMs ?? DEFAULT_LOCK_MS;
  const statement = request.statementTimeoutMs ?? DEFAULT_STATEMENT_MS;
  await connection.execute("select set_config('lock_timeout', $1, false)", [String(lock)]);
  await connection.execute("select set_config('statement_timeout', $1, false)", [
    String(statement),
  ]);
}

async function lockTarget(connection: DriverConnection, target: string): Promise<void> {
  const result = await connection.execute("select pg_try_advisory_lock(hashtext($1))", [
    lockKey(target),
  ]);
  if (!wireTrue(result.rows[0]?.[0])) {
    throw new OkmError("OKM1522", `Another apply holds the lock for ${target}.`, {
      kind: "conflict",
      fix: {
        summary:
          "Wait for that apply to finish. Do not start a second apply against the same target.",
      },
    });
  }
}

function lockKey(target: string): string {
  return `okm:${target}`;
}

/**
 * Refuses when a migration that still has a step to run has an error finding.
 *
 * `okm_history` is read first. When that table does not exist, every
 * migration is pending. The throw happens before any DDL or data statement.
 *
 * @param connection - Reserved connection, after the advisory lock
 * @param directory - Migrations directory, walked from the first file
 * @param migrations - Files apply loaded, in apply order
 */
async function refusePendingLint(
  connection: DriverConnection,
  directory: string,
  migrations: readonly StoredMigration[],
): Promise<void> {
  const pending = await pendingMigrationIds(connection, migrations);
  const findings = lintMigrationDirectory(directory, pending);
  if (hasError(findings)) throw lintRefusal(findings);
}

/**
 * Migration ids with at least one step absent from `okm_history`.
 *
 * @param connection - Reserved connection
 * @param migrations - Files in apply order
 * @returns Every id when `okm_history` does not exist yet
 */
async function pendingMigrationIds(
  connection: DriverConnection,
  migrations: readonly StoredMigration[],
): Promise<ReadonlySet<string>> {
  const present = await connection.execute("select to_regclass('okm_history') is not null");
  if (!wireTrue(present.rows[0]?.[0])) return new Set(migrations.map((migration) => migration.id));
  const history = await readHistory(connection);
  const done = expandProvisioned(migrations, history.done, history.ids);
  const pending = new Set<string>();
  for (const migration of migrations) {
    for (let index = 0; index < migration.steps.length; index += 1) {
      if (!done.has(`${migration.id}:${String(index)}`)) {
        pending.add(migration.id);
        break;
      }
    }
  }
  return pending;
}

async function readHistory(
  connection: DriverConnection,
): Promise<{ readonly done: Set<string>; readonly ids: string[] }> {
  const result = await connection.execute("select migration_id, step_index::text from okm_history");
  const done = new Set<string>();
  const ids: string[] = [];
  for (const row of result.rows) {
    const id = row[0];
    const step = row[1];
    if (id === null || id === undefined || step === null || step === undefined) continue;
    done.add(`${id}:${step}`);
    ids.push(id);
  }
  return { done, ids };
}

async function provisionEmpty(
  connection: DriverConnection,
  request: ApplyRequest,
  session: { setRole?: string },
): Promise<ApplyReport> {
  const snapshot = request.snapshot;
  if (snapshot === undefined) throw new Error("provision requires a snapshot");
  assertTargetPolicy(
    { name: request.target, protected: request.protected },
    "provision",
    request.allowProtected === true,
  );
  if (snapshot.reference.length > 0) {
    assertTargetPolicy(
      { name: request.target, protected: request.protected },
      "reference",
      request.allowProtected === true,
    );
  }
  const schema = concreteSchema(request);
  await connection.execute(META);
  await connection.execute(HISTORY);
  await connection.execute(BACKFILL);
  await installSnapshot(
    connection,
    snapshot.catalog,
    schema,
    snapshot.reference,
    session,
    request.migrationRole,
  );
  const mark = provisionMark(snapshot.migrationId);
  await connection.execute("begin");
  try {
    await connection.execute(
      "insert into okm_history (migration_id, step_index, class, catalog_hash) values ($1, 0, 'expand', $2)",
      [mark, snapshot.catalogHash],
    );
    await connection.execute(
      `insert into okm_meta (id, catalog_hash, migration_id) values ('head', $1, $2)
       on conflict (id) do update set catalog_hash = excluded.catalog_hash, migration_id = excluded.migration_id`,
      [snapshot.catalogHash, mark],
    );
    await connection.execute("commit");
  } catch (error) {
    await connection.execute("rollback").catch(() => undefined);
    throw error;
  }
  return {
    target: request.target,
    applied: [mark],
    ...(session.setRole !== undefined ? { setRole: session.setRole } : {}),
  };
}

async function insertReference(connection: DriverConnection, request: ApplyRequest): Promise<void> {
  const snapshot = request.snapshot;
  if (snapshot === undefined || snapshot.reference.length === 0) return;
  assertTargetPolicy(
    { name: request.target, protected: request.protected },
    "reference",
    request.allowProtected === true,
  );
  const statements = referenceInserts(snapshot.reference, concreteSchema(request));
  if (statements.length === 0) return;
  await connection.execute("begin");
  try {
    for (const sql of statements) await connection.execute(sql);
    await connection.execute("commit");
  } catch (error) {
    await connection.execute("rollback").catch(() => undefined);
    throw error;
  }
}

function concreteSchema(request: ApplyRequest): string {
  return request.searchPath ?? request.schema ?? "public";
}

type TargetShape =
  | { readonly kind: "empty" }
  | { readonly kind: "tracked" }
  | { readonly kind: "occupied"; readonly object: string }
  | { readonly kind: "interrupted"; readonly object: string };

async function targetState(connection: DriverConnection): Promise<TargetShape> {
  const meta = await connection.execute(
    `select to_regclass('okm_meta') is not null
         or to_regclass('okm_history') is not null
         or to_regclass('okm_backfill') is not null`,
  );
  if (wireTrue(meta.rows[0]?.[0])) {
    const historyRows = await tableRows(connection, "okm_history");
    const metaRows = await tableRows(connection, "okm_meta");
    if (historyRows === 0 && metaRows === 0) {
      const object = await namespaceObject(connection);
      if (object === undefined) return { kind: "empty" };
      return { kind: "interrupted", object };
    }
    return { kind: "tracked" };
  }
  const object = await namespaceObject(connection);
  if (object === undefined) return { kind: "empty" };
  return { kind: "occupied", object };
}

async function tableRows(
  connection: DriverConnection,
  name: "okm_history" | "okm_meta",
): Promise<number> {
  const present = await connection.execute(`select to_regclass('${name}') is not null`);
  if (!wireTrue(present.rows[0]?.[0])) return 0;
  const counted = await connection.execute(`select count(*)::text from ${name}`);
  const text = counted.rows[0]?.[0];
  if (text === null || text === undefined) return 0;
  return Number(text);
}

async function namespaceObject(connection: DriverConnection): Promise<string | undefined> {
  const current = await connection.execute("select current_schema()");
  const schema = current.rows[0]?.[0];
  if (schema === null || schema === undefined) return undefined;
  const found = await connection.execute(
    `select name from (
       select c.relname as name from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and c.relname not in ('okm_meta', 'okm_history', 'okm_backfill')
       union all
       select t.typname from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = $1 and t.typtype in ('e', 'd')
       union all
       select e.extname from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace
        where n.nspname = $1
     ) objects limit 1`,
    [schema],
  );
  const object = found.rows[0]?.[0];
  if (object === null || object === undefined) return undefined;
  return object;
}

function interruptedProvision(target: string, object: string): OkmError {
  return new OkmError(
    "OKM1851",
    `Target ${target} is not empty (${object}): a previous provision stopped part-way; drop the schema or database and run again`,
    {
      kind: "forbidden",
      fix: {
        summary: "Drop the schema or database and run again. A partial provision is not repaired.",
      },
    },
  );
}

function notEmpty(target: string, object: string): OkmError {
  const message =
    object === "okm_meta"
      ? `Target ${target} already has migration history and cannot be provisioned.`
      : `Target ${target} is not empty (${object}) and has no migration history.`;
  return new OkmError("OKM1851", message, {
    kind: "forbidden",
    fix: {
      summary: "Provision an empty schema or an empty database. A non-empty target is refused.",
    },
  });
}

async function prepareMigrationRole(
  connection: DriverConnection,
  request: ApplyRequest,
  session: { setRole?: string },
): Promise<void> {
  const role = request.migrationRole;
  const changes = request.migrations.some((migration) =>
    migration.steps.some((step) => changesRole(step.sql)),
  );
  if (role === undefined) {
    if (changes) await assertCreateRole(connection, await currentUser(connection));
    return;
  }
  const current = await currentUser(connection);
  const exists = await roleExists(connection, role);
  if (changes) await assertCreateRole(connection, exists && current !== role ? role : current);
  if (exists && current !== role) await assumeRole(connection, role, session);
}

function wireTrue(value: string | null | undefined): boolean {
  return value === "t" || value === "true";
}
