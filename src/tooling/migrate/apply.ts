/**
 * Applies migrations on one target.
 *
 * A run holds a session advisory lock. Transactional steps of one migration
 * share a transaction. Steps Postgres cannot run there (`CREATE INDEX
 * CONCURRENTLY`, `ADD VALUE`, `VACUUM`) are their own steps. Each finished
 * step is a history row. A later apply skips those rows.
 */

import { join } from "node:path";

import { open } from "../../adapters/pg/postgresjs.js";
import { catalogHash } from "../../contracts/catalog/document.js";
import { hasError, lintMigrationDirectory, lintRefusal } from "./lint.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { assertCreateRole, currentUser, roleExists } from "../../dialects/pg/role/check.js";
import { changesRole, createdRoleName } from "../../dialects/pg/role/sql.js";
import { assertExtensionsAvailable } from "./extensions.js";
import { assertUuidV7Available } from "./engine.js";
import { loadConfig, projectHead } from "./project.js";
import { planMigration, type PlanStep } from "./plan.js";
import type { StoredMigration } from "./files.js";
import { loadMigrations } from "./files.js";
import {
  assertDirectConnection,
  assertTargetPolicy,
  selectTarget,
  type InvokeFlags,
  type PolicyOperation,
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
const BACKOFF_MS = 50;

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
    if (item.step.transactional && !outsideTransaction(item.step.sql)) {
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
 * session-scoped. Lock timeout retries that step. Any other failure stops
 * at that step.
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
    const session: { setRole?: string } = {};
    await prepareMigrationRole(connection, request, session);
    await assertExtensionsAvailable(connection, request.migrations);
    await assertUuidV7Available(connection, request.migrations);
    await connection.execute(META);
    await connection.execute(HISTORY);
    const done = await readDone(connection);
    const applied: string[] = [];
    for (const migration of request.migrations) {
      const units = applyUnits(migration, done);
      if (units.length === 0) continue;
      for (const unit of units) {
        assertUnitPolicy(request, unit);
        await runUnit(connection, unit, request, session);
        for (const item of unit.steps) done.add(`${unit.migrationId}:${String(item.index)}`);
      }
      applied.push(migration.id);
    }
    return {
      target: request.target,
      applied,
      ...(session.setRole !== undefined ? { setRole: session.setRole } : {}),
    };
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
 * @param cwd - Project directory
 * @param flags - `--target`, protection, pooler, and timeouts
 * @returns Text for stdout, including the target name
 */
export async function applyProject(cwd: string, flags: InvokeFlags): Promise<string> {
  const config = await loadConfig(cwd);
  const target = selectTarget(config, flags.target);
  const directory = joinMigrations(cwd, config.migrations);
  const migrations = loadMigrations(directory);
  const findings = lintMigrationDirectory(directory);
  if (hasError(findings)) throw lintRefusal(findings);
  if (migrations.length === 0) return `target ${target.name}\nnothing to apply\n`;
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
    migrations,
    ...(config.roles !== undefined ? { migrationRole: config.roles.migration } : {}),
  });
  return formatReport(report);
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
  });
  if (plan.steps.length === 0) return `target ${target.name}\nno changes\n`;
  const report = await applyTarget({
    url: target.url,
    target: target.name,
    protected: target.protected,
    allowProtected: flags.allowProtected,
    allowPooler: flags.allowPooler || config.allowPooler === true,
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

function formatReport(report: ApplyReport): string {
  const role = report.setRole !== undefined ? `set role ${report.setRole}\n` : "";
  if (report.applied.length === 0) return `target ${report.target}\n${role}nothing to apply\n`;
  return `target ${report.target}\n${role}${report.applied.map((id) => `applied ${id}`).join("\n")}\n`;
}

function joinMigrations(cwd: string, migrations: string | undefined): string {
  return join(cwd, migrations ?? "migrations");
}

function assertUnitPolicy(request: ApplyRequest, unit: ApplyUnit): void {
  let operation: PolicyOperation = "expand";
  for (const item of unit.steps) {
    if (item.step.action === "backfill") {
      operation = "backfill";
      break;
    }
    if (item.step.class === "contract" || item.step.class === "unclassified")
      operation = item.step.class;
  }
  assertTargetPolicy(
    { name: request.target, protected: request.protected },
    operation,
    request.allowProtected === true,
  );
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

async function readDone(connection: DriverConnection): Promise<Set<string>> {
  const result = await connection.execute("select migration_id, step_index::text from okm_history");
  const done = new Set<string>();
  for (const row of result.rows) {
    const id = row[0];
    const step = row[1];
    if (id !== null && step !== null) done.add(`${id}:${step}`);
  }
  return done;
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

async function grantSchema(
  connection: DriverConnection,
  schema: string,
  role: string,
): Promise<void> {
  await connection.execute(
    `grant usage, create on schema ${quoteIdent(schema)} to ${quoteIdent(role)}`,
  );
}

async function assumeRole(
  connection: DriverConnection,
  role: string,
  session: { setRole?: string },
): Promise<void> {
  if (session.setRole === role) return;
  await connection.execute(`set role ${quoteIdent(role)}`);
  session.setRole = role;
}

async function runUnit(
  connection: DriverConnection,
  unit: ApplyUnit,
  request: ApplyRequest,
  session: { setRole?: string },
): Promise<void> {
  const retries = request.retries ?? DEFAULT_RETRIES;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let began = false;
    let current = unit.steps[0]?.index ?? 0;
    try {
      if (unit.transactional) {
        await connection.execute("begin");
        began = true;
      }
      for (const item of unit.steps) {
        current = item.index;
        await rebuildInvalidIndex(connection, item.step.sql);
        const created = createdRoleName(item.step.sql);
        const existed = created !== undefined && (await roleExists(connection, created));
        if (created === undefined || !existed) await connection.execute(item.step.sql);
        if (created !== undefined && created === request.migrationRole) {
          if (!existed) {
            await grantSchema(connection, request.schema ?? "public", created);
            await connection.execute(
              `grant select, insert, update on okm_meta, okm_history to ${quoteIdent(created)}`,
            );
          }
          await assumeRole(connection, created, session);
        }
        if (!unit.transactional) {
          await connection.execute("begin");
          began = true;
          await writeStep(connection, unit, item);
          if (unit.finishes) await writeMeta(connection, unit);
          await connection.execute("commit");
          began = false;
        }
      }
      if (unit.transactional) {
        for (const item of unit.steps) await writeStep(connection, unit, item);
        if (unit.finishes) await writeMeta(connection, unit);
        await connection.execute("commit");
        began = false;
      }
      return;
    } catch (error) {
      if (began) await connection.execute("rollback").catch(() => undefined);
      if (!isLockTimeout(error) || attempt === retries) throw failStep(unit, current, error);
      await delay(BACKOFF_MS * 2 ** attempt);
    }
  }
}

async function writeStep(
  connection: DriverConnection,
  unit: ApplyUnit,
  item: IndexedStep,
): Promise<void> {
  await connection.execute(
    "insert into okm_history (migration_id, step_index, class, catalog_hash) values ($1, $2, $3, $4)",
    [unit.migrationId, String(item.index), item.step.class, unit.catalogHash],
  );
}

async function writeMeta(connection: DriverConnection, unit: ApplyUnit): Promise<void> {
  await connection.execute(
    `insert into okm_meta (id, catalog_hash, migration_id) values ('head', $1, $2)
     on conflict (id) do update set catalog_hash = excluded.catalog_hash, migration_id = excluded.migration_id`,
    [unit.catalogHash, unit.migrationId],
  );
}

async function rebuildInvalidIndex(connection: DriverConnection, sql: string): Promise<void> {
  const name = concurrentIndexName(sql);
  if (name === undefined) return;
  const found = await connection.execute(
    `select i.indisvalid
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_index i on i.indexrelid = c.oid
     where c.relname = $1 and n.nspname = current_schema()`,
    [name],
  );
  const valid = found.rows[0]?.[0];
  if (valid === undefined || wireTrue(valid)) return;
  await connection.execute(`drop index concurrently if exists ${quoteIdent(name)}`);
}

function concurrentIndexName(sql: string): string | undefined {
  const match =
    /^create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/i.exec(
      sql.trim(),
    );
  return match?.[1] ?? match?.[2];
}

function outsideTransaction(sql: string): boolean {
  const text = sql.trim().toLowerCase();
  if (text.startsWith("vacuum")) return true;
  if (/^alter\s+type\b/.test(text) && /\badd\s+value\b/.test(text)) return true;
  if (/^create\s+(?:unique\s+)?index\s+concurrently\b/.test(text)) return true;
  return false;
}

function failStep(unit: ApplyUnit, index: number, error: unknown): OkmError {
  if (error instanceof OkmError) return error;
  const message = error instanceof Error ? error.message : "The step failed.";
  return new OkmError(
    "invalid",
    `Migration ${unit.migrationId} failed at step ${String(index)}: ${message}`,
    {
      cause: error,
      fix: { summary: "Fix the step and run apply again. Finished steps are not repeated." },
    },
  );
}

function isLockTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("sqlstate" in error && error.sqlstate === "55P03") return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("lock timeout");
}

function wireTrue(value: string | null | undefined): boolean {
  return value === "t" || value === "true";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
