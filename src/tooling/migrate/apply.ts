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

import { open } from "../../adapters/pg/postgresjs.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { startupHash } from "../../contracts/catalog/document.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { hasError, lintMigrationDirectory, lintPlan, lintRefusal } from "./lint.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { assertCreateRole, currentUser, roleExists } from "../../dialects/pg/role/check.js";
import { changesRole } from "../../dialects/pg/role/sql.js";
import { introspectSchema } from "../../dialects/pg/introspect.js";
import { sealViews } from "../../dialects/pg/view/scratch.js";
import { batchSizeField } from "./backfill.js";
import {
  assumeRole,
  grantAppMeta,
  runTarget,
  statementOutsideTransaction,
  type BackfillBatch,
} from "./runner.js";
import { assertExtensionsAvailable } from "./extensions.js";
import { assertUuidV7Available } from "./engine.js";
import { assertSnapshots } from "./export.js";
import { asProject, projectPath, type ProjectContext } from "./paths.js";
import { loadBuiltSchema, loadConfig, projectHead } from "./project.js";
import { loadHeadSnapshot, loadMigrations } from "./files.js";
import { readReference, referenceInserts, type ReferenceTable } from "./reference.js";
import { expandProvisioned, installSnapshot, provisionMark } from "./snapshot.js";
import { planStatements, type PlanStep } from "./plan.js";
import type { StoredMigration } from "./files.js";
import { finishQuiet } from "./lost.js";
import type { StepBoundary } from "./step-engine.js";
import {
  catalogQuery,
  invalidIndexReport,
  managedRoleOptions,
  sealStoredChecks,
  sealTriggerWhens,
} from "./drift.js";
import {
  assertDirectConnection,
  assertStoreTerminal,
  assertTargetPolicy,
  policySubject,
  selectTarget,
  type InvokeFlags,
  type ProtectionMatch,
} from "./policy.js";
import { probeStableBackend } from "./pooler-probe.js";
import { driverUrl } from "./driver-url.js";
import type { DeclaredRename } from "../../dialects/pg/declarations.js";
import postgres from "postgres";

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
  readonly protection?: ProtectionMatch;
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
   * Application role.
   *
   * After the plan, this role receives `SELECT` on `okm_meta` and nothing
   * else. `connect()` can then read the stored hash. Check scratch paths
   * leave this unset.
   */
  readonly appRole?: string;
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
  /**
   * Catalog hash `okm_meta` must record when this run finishes.
   *
   * When the plan (or pending units) leave the database matching the schema
   * but `okm_meta` still holds an older hash — for example an external table
   * gained a column and the dependent exported a new snapshot — the runner
   * re-stamps `okm_meta` and `okm_history` under a fresh id. File apply only
   * enables that path when `defineConfig({ external })` is set; a foreign or
   * legacy hash without external snapshots is left for connect or the pre-D208
   * restamp.
   */
  readonly headHash?: string;
  /** When true, an empty apply may re-stamp `okm_meta` to {@link headHash}. */
  readonly restampHead?: boolean;
  /**
   * Stops a committed step at one crash boundary.
   *
   * Tests use this. A stop does not write `failed`. The next apply resumes.
   */
  readonly failAt?: StepBoundary;
};

/** Migrations that ran at least one step in this invocation. */
export type ApplyReport = {
  readonly target: string;
  readonly applied: readonly string[];
  /** Migrations whose stored hash moved from the pre-D208 hash to the startup hash. */
  readonly restamped?: readonly string[];
  /** Set when the runner issued `SET ROLE` at session start. */
  readonly setRole?: string;
};

/** `lock_timeout` apply sets when neither a flag nor `timeouts.lock` names one. */
export const DEFAULT_LOCK_MS = 5_000;
/** `statement_timeout` apply sets when neither a flag nor `timeouts.statement` names one. */
export const DEFAULT_STATEMENT_MS = 30_000;
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

const STEPS = `create table if not exists okm_steps (
  migration_id text not null,
  step_index integer not null,
  kind text not null,
  sql_hash text not null,
  state text not null,
  attempt integer not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  runner text,
  error_code text,
  error_text text,
  primary key (migration_id, step_index),
  constraint okm_steps_state check (state in ('started', 'failed', 'retry'))
)`;

/**
 * Creates `okm_meta`, `okm_history`, `okm_backfill`, and `okm_steps` when they are absent.
 *
 * @param execute - Runs one statement on the apply or check connection
 */
export async function ensureMigrationTables(
  execute: (sql: string) => Promise<unknown>,
): Promise<void> {
  await execute(META);
  await execute(HISTORY);
  await execute(BACKFILL);
  await execute(STEPS);
}

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
 * a concurrent index create or drop. A committed step writes `okm_steps`
 * before its statement and deletes that row in the same transaction as its
 * history row. The next apply probes. When cleanup of an INVALID index
 * fails, the error names the index and `DROP INDEX CONCURRENTLY`. Any other
 * failure stops at that step.
 *
 * @param request - Target, flags, and the migrations to consider
 * @returns The target and the migration ids that ran
 */
export async function applyTarget(request: ApplyRequest): Promise<ApplyReport> {
  assertDirectConnection(request.url, request.allowPooler === true);
  const url = driverUrl(request.url);
  const pool = open({
    url,
    max: 1,
    ...(request.searchPath !== undefined ? { searchPath: request.searchPath } : {}),
  });
  if (pool.reserve === undefined) {
    await pool.close();
    throw new OkmError("invalid", "The driver cannot reserve a connection.", {
      fix: { summary: "Apply needs a driver with interactive transactions." },
    });
  }
  const reserved = await pool.reserve();
  const connection = reserved;
  let locked = false;
  try {
    await probeStableBackend(
      request.url,
      () => backendPid(connection),
      request.allowPooler === true,
    );
    await assertStandardStrings(connection);
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
    await enterCatalogSchema(connection, request.schema ?? "public");
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
    await ensureMigrationTables((sql) => connection.execute(sql));
    const restamped = await restampLegacy(connection, request);
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
        ...(request.failAt !== undefined ? { failAt: request.failAt } : {}),
      },
      session,
    );
    if (request.snapshot !== undefined) {
      await insertReference(connection, request);
    }
    const desiredHash = request.headHash;
    const headStamp =
      desiredHash === undefined || request.restampHead !== true
        ? []
        : await restampHeadHash(
            connection,
            request,
            nextSequenceId("restamp", history.ids),
            desiredHash,
          );
    await grantAppMeta(connection, request.appRole, session);
    const stamped = [...restamped, ...headStamp];
    return stamped.length === 0 ? report : { ...report, restamped: stamped };
  } finally {
    if (locked) {
      await finishQuiet(() =>
        connection.execute("select pg_advisory_unlock(hashtext($1))", [lockKey(request.target)]),
      );
    }
    await finishQuiet(() => connection.release());
    await finishQuiet(() => pool.close());
  }
}

/**
 * Applies the migrations in the project to the selected target.
 *
 * Pending migrations are linted after `okm_history` is read and before any
 * DDL. A migration the target already applied is left as it ran.
 *
 * @param project - Project directory or {@link ProjectContext}
 * @param flags - `--target`, protection, pooler, and timeouts
 * @param write - Receives each backfill progress line, including the newline
 * @returns Text for stdout, including the target name
 */
export async function applyProject(
  project: string | ProjectContext,
  flags: InvokeFlags,
  write?: (text: string) => void,
): Promise<string> {
  return (await applyProjectResult(project, flags, write)).text;
}

/**
 * Applies pending migrations and returns the report plus CLI text (D298).
 *
 * @param project - Project directory or {@link ProjectContext}
 * @param flags - Target, protection, pooler, and timeouts
 * @param write - Optional progress sink (each line already ends with `\n` when used from the CLI)
 * @returns Target name, applied migration ids, and stdout text
 */
export async function applyProjectResult(
  project: string | ProjectContext,
  flags: InvokeFlags,
  write?: (text: string) => void,
): Promise<{ readonly report: ApplyReport; readonly text: string }> {
  const result = await runApply(project, flags, write);
  if (result.kind === "empty") {
    return {
      report: { target: result.target, applied: [] },
      text: `target ${result.target}\nnothing to apply\n`,
    };
  }
  const summary = formatApplyText(result.report);
  const text =
    write !== undefined || result.progress.length === 0
      ? summary
      : `${result.progress.join("\n")}\n${summary}`;
  return { report: result.report, text };
}

async function runApply(
  project: string | ProjectContext,
  flags: InvokeFlags,
  write?: (text: string) => void,
): Promise<
  | { readonly kind: "empty"; readonly target: string }
  | {
      readonly kind: "ran";
      readonly report: ApplyReport;
      readonly progress: readonly string[];
    }
> {
  const { cwd } = asProject(project);
  const config = await loadConfig(project);
  const target = selectTarget(config, flags.target);
  assertStoreTerminal(target, "contract");
  const directory = joinMigrations(cwd, config.migrations);
  const migrations = loadMigrations(directory);
  const head = loadHeadSnapshot(directory);
  if (migrations.length === 0 || head === undefined) return { kind: "empty", target: target.name };
  const built = await loadBuiltSchema(cwd, config).catch((error: unknown) => {
    if (error instanceof OkmError && error.message.endsWith("must export a schema()."))
      return undefined;
    throw error;
  });
  if (built !== undefined) assertSnapshots(cwd, config, built.catalog);
  const progress: string[] = [];
  const externalConfigured = (config.external ?? []).length > 0;
  const report = await applyTarget({
    url: target.url,
    target: target.name,
    protected: target.protected,
    protection: target.protection,
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
    ...(built !== undefined ? { headHash: startupHash(built.catalog) } : {}),
    ...(externalConfigured ? { restampHead: true } : {}),
    ...(config.roles !== undefined
      ? { migrationRole: config.roles.migration, appRole: config.roles.app }
      : {}),
    ...catalogSchema(config.namespace),
    lintDirectory: directory,
    onProgress: (line) => {
      if (write !== undefined) write(`${line}\n`);
      else progress.push(line);
    },
  });
  return { kind: "ran", report, progress };
}

/**
 * Prototype sync. Blocked on a protected target.
 *
 * Plans from the live catalog on the target (not the last migration file),
 * applies under a fresh `push-<n>` id from `okm_history`, and re-stamps
 * `okm_meta` when the schema hash moved with no DDL (B-29, B-21).
 *
 * @param project - Project directory or {@link ProjectContext}
 * @param flags - Target and protection flags
 * @returns Text for stdout
 */
export async function pushProject(
  project: string | ProjectContext,
  flags: InvokeFlags,
): Promise<string> {
  const { cwd } = asProject(project);
  const config = await loadConfig(project);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "push", flags.allowProtected);
  const head = await projectHead(project);
  assertSnapshots(cwd, config, head.catalog);
  const catalogHash = startupHash(head.catalog);
  const report = await pushTarget({
    url: target.url,
    target: target.name,
    protected: target.protected,
    protection: target.protection,
    allowProtected: flags.allowProtected,
    allowPooler: flags.allowPooler || config.allowPooler === true,
    ...backfillTiming(config.backfill),
    after: head.catalog,
    renames: head.renames,
    catalogHash,
    ...(config.roles !== undefined
      ? { migrationRole: config.roles.migration, appRole: config.roles.app, roles: config.roles }
      : {}),
    ...catalogSchema(config.namespace),
    ...batchSizeField(config.backfill?.batchSize),
  });
  if (report.applied.length === 0 && (report.restamped ?? []).length === 0) {
    return `target ${target.name}\nno changes\n`;
  }
  return formatApplyText(report);
}

const PUSH_RLS_FIX =
  "okm push does not weaken row-level security. Run okm generate, review the migration, then okm migrate apply it with `-- okm-allow OKM1550: <reason>` on the step.";

type PushRequest = {
  readonly url: string;
  readonly target: string;
  readonly protected: boolean;
  readonly protection?: ProtectionMatch;
  readonly allowProtected?: boolean;
  readonly allowPooler?: boolean;
  readonly after: Catalog;
  readonly renames: readonly DeclaredRename[];
  readonly catalogHash: string;
  readonly migrationRole?: string;
  readonly appRole?: string;
  readonly roles?: import("../../dialects/pg/role/index.js").RolesInput;
  readonly schema?: string;
  readonly searchPath?: string;
  readonly backfillPauseMs?: number;
  readonly backfillStatementTimeoutMs?: number;
  readonly batchSize?: number;
};

/**
 * Plans from the connected catalog and applies or re-stamps under one lock.
 *
 * @param request - Target, schema catalog, and push options
 * @returns Apply report for {@link formatApplyText}
 */
async function pushTarget(request: PushRequest): Promise<ApplyReport> {
  assertDirectConnection(request.url, request.allowPooler === true);
  const url = driverUrl(request.url);
  const pool = open({
    url,
    max: 1,
    ...(request.searchPath !== undefined ? { searchPath: request.searchPath } : {}),
  });
  if (pool.reserve === undefined) {
    await pool.close();
    throw new OkmError("invalid", "The driver cannot reserve a connection.", {
      fix: { summary: "Push needs a driver with interactive transactions." },
    });
  }
  const connection = await pool.reserve();
  let locked = false;
  try {
    await probeStableBackend(
      request.url,
      () => backendPid(connection),
      request.allowPooler === true,
    );
    await assertStandardStrings(connection);
    await setTimeouts(connection, {
      url: request.url,
      target: request.target,
      protected: request.protected,
      migrations: [],
    });
    await lockTarget(connection, request.target);
    locked = true;
    const session: { setRole?: string } = {};
    const schema = request.schema ?? "public";
    await enterCatalogSchema(connection, schema);
    await ensureMigrationTables((sql) => connection.execute(sql));
    const history = await readHistory(connection);
    const pushId = nextSequenceId("push", history.ids);
    const sql = postgres(url, {
      max: 1,
      connect_timeout: 5,
      idle_timeout: 1,
      onnotice: () => {},
      ...(schema !== "public" ? { connection: { search_path: schema } } : {}),
    });
    let planSteps: readonly PlanStep[] = [];
    try {
      const runner = catalogQuery(sql);
      if (schema !== "public") {
        await sql.unsafe(`create schema if not exists ${quoteIdent(schema)}`);
        await sql.unsafe(`set search_path to ${quoteIdent(schema)}`);
      }
      const authorViews = await sealViews(runner, request.after);
      const author = await sealTriggerWhens(runner, await sealStoredChecks(runner, authorViews));
      const live = await sealStoredChecks(
        runner,
        await introspectSchema(runner, schema, schema, managedRoleOptions(request.roles)),
      );
      const invalid = await invalidIndexReport(runner, schema);
      if (invalid.length > 0) {
        throw new OkmError("OKM1520", invalid.join("\n"), {
          fix: {
            summary: "Drop the INVALID index with DROP INDEX CONCURRENTLY, then run apply again.",
          },
        });
      }
      const plan = planStatements({
        before: live,
        after: author,
        renames: request.renames,
        name: pushId,
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
        ...(request.batchSize !== undefined ? { batchSize: request.batchSize } : {}),
      });
      const weakened = lintPlan(plan, live, author).filter((item) => item.code === "OKM1550");
      if (weakened.length > 0) throw lintRefusal(weakened, PUSH_RLS_FIX);
      planSteps = plan.steps;
    } finally {
      await finishQuiet(() => sql.end({ timeout: 5 }));
    }
    if (planSteps.length === 0) {
      const stamped = await restampHeadHash(connection, request, pushId, request.catalogHash);
      await grantAppMeta(connection, request.appRole, session);
      if (stamped.length === 0) {
        return { target: request.target, applied: [] };
      }
      return { target: request.target, applied: [], restamped: stamped };
    }
    const migration: StoredMigration = {
      id: pushId,
      catalogHash: request.catalogHash,
      steps: planSteps,
    };
    await prepareMigrationRole(
      connection,
      {
        url: request.url,
        target: request.target,
        protected: request.protected,
        migrations: [migration],
        ...(request.migrationRole !== undefined ? { migrationRole: request.migrationRole } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
      },
      session,
    );
    await assertExtensionsAvailable(connection, [migration]);
    await assertUuidV7Available(connection, [migration]);
    const units = applyUnits(migration, new Set());
    const report = await runTarget(
      connection,
      {
        policy: {
          target: request.target,
          protected: request.protected,
          allowProtected: request.allowProtected === true,
          ...(request.protection !== undefined ? { protection: request.protection } : {}),
        },
        units,
        retries: DEFAULT_RETRIES,
        lockTimeoutMs: DEFAULT_LOCK_MS,
        statementTimeoutMs: DEFAULT_STATEMENT_MS,
        backfillStatementTimeoutMs: request.backfillStatementTimeoutMs ?? DEFAULT_STATEMENT_MS,
        ...(request.backfillPauseMs !== undefined
          ? { backfillPauseMs: request.backfillPauseMs }
          : {}),
        ...(request.migrationRole !== undefined ? { migrationRole: request.migrationRole } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
      },
      session,
    );
    await grantAppMeta(connection, request.appRole, session);
    return report;
  } finally {
    if (locked) {
      await finishQuiet(() =>
        connection.execute("select pg_advisory_unlock(hashtext($1))", [lockKey(request.target)]),
      );
    }
    await finishQuiet(() => connection.release());
    await finishQuiet(() => pool.close());
  }
}

/**
 * Re-stamps `okm_meta` and appends a history row when the stored hash drifted.
 *
 * @param connection - Locked apply connection
 * @param request - Target policy
 * @param migrationId - Fresh id for the history row
 * @param catalogHash - Hash the schema requires
 * @returns The id when a row was written, otherwise empty
 */
async function restampHeadHash(
  connection: DriverConnection,
  request: {
    readonly target: string;
    readonly protected: boolean;
    readonly protection?: ProtectionMatch;
    readonly allowProtected?: boolean;
  },
  migrationId: string,
  catalogHash: string,
): Promise<readonly string[]> {
  const present = await connection.execute("select to_regclass('okm_meta') is not null");
  if (!wireTrue(present.rows[0]?.[0])) return [];
  const current = await connection.execute("select catalog_hash from okm_meta where id = 'head'");
  const stored = current.rows[0]?.[0];
  if (typeof stored === "string" && stored === catalogHash) return [];
  assertTargetPolicy(
    policySubject({
      name: request.target,
      protected: request.protected,
      ...(request.protection !== undefined ? { protection: request.protection } : {}),
    }),
    "history-repair",
    request.allowProtected === true,
  );
  await connection.execute("begin");
  try {
    await connection.execute(
      "insert into okm_history (migration_id, step_index, class, catalog_hash) values ($1, 0, 'expand', $2)",
      [migrationId, catalogHash],
    );
    await connection.execute(
      `insert into okm_meta (id, catalog_hash, migration_id) values ('head', $1, $2)
       on conflict (id) do update set catalog_hash = excluded.catalog_hash, migration_id = excluded.migration_id`,
      [catalogHash, migrationId],
    );
    await connection.execute("commit");
  } catch (error) {
    await connection.execute("rollback").catch(() => undefined);
    throw error;
  }
  return [migrationId];
}

/**
 * Next `prefix-<n>` id that is not already in history.
 *
 * @param prefix - `push` or `restamp`
 * @param ids - Migration ids already recorded
 * @returns A fresh id
 */
function nextSequenceId(prefix: string, ids: readonly string[]): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match === null) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return `${prefix}-${String(max + 1)}`;
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

/**
 * The stdout `okm migrate apply` and {@link apply} share (D298).
 *
 * @param report - Target and the migrations that ran
 * @returns Text ending in a newline
 */
export function formatApplyText(report: ApplyReport): string {
  const role = report.setRole !== undefined ? `set role ${report.setRole}\n` : "";
  const restamped = (report.restamped ?? []).map((id) => `restamped ${id}\n`).join("");
  if (report.applied.length === 0) {
    return `target ${report.target}\n${role}${restamped}nothing to apply\n`;
  }
  return `target ${report.target}\n${role}${restamped}${report.applied.map((id) => `applied ${id}`).join("\n")}\n`;
}

/**
 * Moves a hash written before D208 to the startup hash.
 *
 * A row changes only when its migration is one of these files, already in
 * `okm_history`, and its stored hash is that file's pre-D208 hash. Any other
 * hash is left for the startup check to report as drift. The rewrite is a
 * history repair, so a protected target needs `--allow-protected`.
 *
 * @param connection - Reserved connection holding the advisory lock
 * @param request - Target, protection, and the migrations on disk
 * @returns Migration ids whose rows changed
 */
async function restampLegacy(
  connection: DriverConnection,
  request: ApplyRequest,
): Promise<readonly string[]> {
  const pairs: { id: string; mark: string; legacy: string; startup: string }[] = [];
  for (const migration of request.migrations) {
    if (migration.legacyHash === undefined) continue;
    pairs.push({
      id: migration.id,
      mark: provisionMark(migration.id),
      legacy: migration.legacyHash,
      startup: migration.catalogHash,
    });
  }
  if (pairs.length === 0) return [];
  await connection.execute("begin");
  try {
    const result = await connection.execute(RESTAMP, [JSON.stringify(pairs)]);
    const restamped = result.rows.flatMap((row) => (typeof row[0] === "string" ? [row[0]] : []));
    if (restamped.length > 0) {
      assertTargetPolicy(
        policySubject({
          name: request.target,
          protected: request.protected,
          ...(request.protection !== undefined ? { protection: request.protection } : {}),
        }),
        "history-repair",
        request.allowProtected === true,
      );
    }
    await connection.execute("commit");
    return restamped;
  } catch (error) {
    await connection.execute("rollback");
    throw error;
  }
}

const RESTAMP = `with pairs as (
  select * from json_to_recordset($1::json) as p(id text, mark text, legacy text, startup text)
), history as (
  update okm_history h set catalog_hash = p.startup from pairs p
   where h.migration_id in (p.id, p.mark) and h.catalog_hash = p.legacy
  returning p.id, h.migration_id
), meta as (
  update okm_meta m set catalog_hash = p.startup from pairs p
   where m.id = 'head' and m.migration_id in (p.id, p.mark) and m.catalog_hash = p.legacy
     and m.migration_id in (select migration_id from history)
  returning m.id
)
select distinct id from history order by id`;

function joinMigrations(cwd: string, migrations: string | undefined): string {
  return projectPath(cwd, migrations ?? "migrations");
}

async function backendPid(connection: DriverConnection): Promise<string> {
  const result = await connection.execute("select pg_backend_pid()::text");
  const cell = result.rows[0]?.[0];
  return cell === null || cell === undefined ? "" : String(cell);
}

async function assertStandardStrings(connection: DriverConnection): Promise<void> {
  const result = await connection.execute("show standard_conforming_strings");
  const value = result.rows[0]?.[0];
  if (value === "on") return;
  throw new OkmError(
    "invalid",
    `standard_conforming_strings is ${value === null || value === undefined ? "off" : String(value)}. Apply refuses to run.`,
    { fix: { summary: "Turn standard_conforming_strings on for this database." } },
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

export async function lockTarget(connection: DriverConnection, target: string): Promise<void> {
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

export function lockKey(target: string): string {
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
    policySubject({
      name: request.target,
      protected: request.protected,
      ...(request.protection !== undefined ? { protection: request.protection } : {}),
    }),
    "provision",
    request.allowProtected === true,
  );
  if (snapshot.reference.length > 0) {
    assertTargetPolicy(
      policySubject({
        name: request.target,
        protected: request.protected,
        ...(request.protection !== undefined ? { protection: request.protection } : {}),
      }),
      "reference",
      request.allowProtected === true,
    );
  }
  const schema = concreteSchema(request);
  await ensureMigrationTables((sql) => connection.execute(sql));
  try {
    await installSnapshot(
      connection,
      snapshot.catalog,
      schema,
      snapshot.reference,
      session,
      request.migrationRole,
    );
    await grantAppMeta(connection, request.appRole, session);
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
  } catch (error) {
    // Drop empty bootstrap tables so a retry starts clean. Roles are cluster
    // objects and stay; createRoleOnce and the ownership grants tolerate that.
    // RESET ROLE first: bootstrap tables were created as the connecting user.
    if (session.setRole !== undefined) {
      await connection.execute("reset role").catch(() => undefined);
      delete session.setRole;
    }
    await dropEmptyBootstrapTables(connection).catch(() => undefined);
    throw error;
  }
}

/**
 * Drops `okm_meta`, `okm_history`, `okm_backfill`, and `okm_steps` when they have no rows
 * and the schema has no other user objects.
 *
 * Used after a failed provision so a retry that left nothing behind sees an
 * empty target. When another object remains (for example a table from a
 * mid-provision failure), the bootstrap tables stay so the next apply reports
 * OKM1851 and names what was left.
 *
 * @param connection - Reserved connection
 */
async function dropEmptyBootstrapTables(connection: DriverConnection): Promise<void> {
  if ((await namespaceObject(connection)) !== undefined) return;
  for (const name of ["okm_meta", "okm_history", "okm_backfill", "okm_steps"] as const) {
    const present = await connection.execute(`select to_regclass('${name}') is not null`);
    if (!wireTrue(present.rows[0]?.[0])) continue;
    const counted = await connection.execute(`select count(*)::text from ${name}`);
    const text = counted.rows[0]?.[0];
    if (text !== "0") continue;
    await connection.execute(`drop table if exists ${name}`);
  }
}

async function insertReference(connection: DriverConnection, request: ApplyRequest): Promise<void> {
  const snapshot = request.snapshot;
  if (snapshot === undefined || snapshot.reference.length === 0) return;
  assertTargetPolicy(
    policySubject({
      name: request.target,
      protected: request.protected,
      ...(request.protection !== undefined ? { protection: request.protection } : {}),
    }),
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

function catalogSchema(namespace: string | undefined): { readonly schema: string } | undefined {
  if (namespace === undefined || namespace === "public") return undefined;
  return { schema: namespace };
}

/**
 * Creates a non-public schema and points this session at it.
 *
 * `okm_meta` is unqualified, so the search path is what gives each catalog
 * its own history during apply. `connect()` reads the namespace `okm build` stored.
 */
async function enterCatalogSchema(connection: DriverConnection, schema: string): Promise<void> {
  if (schema === "public") return;
  await connection.execute(`create schema if not exists ${quoteIdent(schema)}`);
  await connection.execute(`set search_path to ${quoteIdent(schema)}`);
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
         or to_regclass('okm_backfill') is not null
         or to_regclass('okm_steps') is not null`,
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
          and c.relname not in ('okm_meta', 'okm_history', 'okm_backfill', 'okm_steps')
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
  // Role DDL runs as the connecting user before SET ROLE (D293). The managed
  // migration role is NOSUPERUSER NOCREATEROLE, so never check it for CREATEROLE.
  if (role === undefined) {
    if (changes) await assertCreateRole(connection, await currentUser(connection));
    return;
  }
  const current = await currentUser(connection);
  const exists = await roleExists(connection, role);
  if (changes) await assertCreateRole(connection, current);
  // Defer SET ROLE while the plan still creates or alters roles; otherwise a
  // managed migration role (NOCREATEROLE) would refuse later CREATE ROLE steps.
  if (exists && current !== role && !changes) await assumeRole(connection, role, session);
}

function wireTrue(value: string | null | undefined): boolean {
  return value === "t" || value === "true";
}
