/**
 * One-target apply runner (D195).
 *
 * `okm migrate apply` calls {@link runTarget} with the units of one target.
 * Bounded concurrency, several targets, canaries, and class flags are M5.
 * A backfill step is one transaction per batch, with a checkpoint in
 * `okm_backfill` after each commit.
 */

import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { roleExists } from "../../dialects/pg/role/check.js";
import { changesRole, createdRoleName, createRoleOnce } from "../../dialects/pg/role/sql.js";
import {
  boundaryQuery,
  checkedCast,
  DEFAULT_BACKFILL_PAUSE_MS,
  DEFAULT_BACKFILL_STATEMENT_TIMEOUT_MS,
  type BackfillColumn,
  type BackfillSpec,
} from "./backfill.js";
import type { PlanStep } from "./plan.js";
import { ensureExtensionSchemaSql, rememberExtensionSchema } from "./extensions.js";
import { sessionFailure } from "./lost.js";
import { migrationJournalGrants } from "./managed.js";
import { postgresStepEngine } from "./pg-probe.js";
import {
  assertTargetPolicy,
  policySubject,
  type PolicyOperation,
  type ProtectionMatch,
} from "./policy.js";
import { postgresStepJournal } from "./step-journal.js";
import {
  isLockTimeout,
  lockFailure,
  lockWaiter,
  readLock,
  type LockObserver,
  type LockTally,
  type LockWaiter,
} from "./lock-wait.js";
import {
  resumeCommittedStep,
  StepBoundaryStop,
  stepSqlHash,
  unitMode,
  type CommittedStep,
  type StepBoundary,
} from "./step-engine.js";

/** One step with its index in the migration file. */
export type RunnableStep = {
  readonly index: number;
  readonly step: PlanStep;
};

/** Steps that commit together, or one step that cannot. */
export type RunnableUnit = {
  readonly migrationId: string;
  readonly catalogHash: string;
  /** True when this unit is the last step of its migration. */
  readonly finishes: boolean;
  readonly transactional: boolean;
  readonly steps: readonly RunnableStep[];
};

/** What one committed backfill batch recorded. */
export type BackfillBatch = {
  readonly migrationId: string;
  readonly stepIndex: number;
  readonly batch: number;
  readonly rows: number;
  readonly lastKey: string | null;
};

/**
 * Protection and timeouts the runner reads on every batch.
 *
 * `protected` is read again at each batch, so a caller can change it between
 * batches.
 */
export type RunPolicy = {
  readonly target: string;
  readonly protected: boolean;
  readonly allowProtected?: boolean;
  readonly protection?: ProtectionMatch;
};

/** One target's units, lock wait, and checkpoints. */
export type TargetRun = {
  readonly policy: RunPolicy;
  readonly units: readonly RunnableUnit[];
  /** `--lock-wait`: how long a blocked step keeps retrying. 0 is one attempt. */
  readonly lockWaitMs: number;
  /** `lock_timeout` for one attempt. */
  readonly lockTimeoutMs: number;
  /**
   * Backend pid of a connection proven direct. Unset when a pooler signal
   * matched or the pid probe did not prove a direct session. A step outside
   * a transaction is refused there.
   */
  readonly directPid?: string;
  /** Which pooler signal blocked the session setting. No URL and no secret. */
  readonly poolerReason?: string;
  /** Names who holds a lock a step gave up on. Unset when the connection is not direct. */
  readonly observer?: LockObserver;
  readonly statementTimeoutMs: number;
  readonly backfillPauseMs?: number;
  readonly backfillStatementTimeoutMs?: number;
  readonly migrationRole?: string;
  readonly schema?: string;
  readonly onProgress?: (line: string) => void;
  readonly afterBatch?: (batch: BackfillBatch) => void | Promise<void>;
  /** Test failpoint. A stop leaves the committed step where a crash would. */
  readonly failAt?: StepBoundary;
  /**
   * Runs after `begin` and before the unit's statements.
   *
   * `okm push` probes live rows here so the answer shares the transaction
   * that would drop them. A throw rolls the unit back.
   */
  readonly beforeStatements?: (connection: DriverConnection, unit: RunnableUnit) => Promise<void>;
};

/** What {@link runTarget} finished on this target. */
export type TargetRunReport = {
  readonly target: string;
  readonly applied: readonly string[];
  readonly setRole?: string;
  /** Present when a step had to wait for a lock. */
  readonly lock?: LockTally;
};

/** Where the run's lock waits are counted, and what counts as already committed. */
type LockRun = {
  readonly tally: LockTally;
  readonly done: () => number;
  readonly waiter: (label: string, earlier?: () => boolean) => LockWaiter;
};

/** Role and extension schemas remembered for one apply connection. */
type RunSession = { setRole?: string; extensionSchemas?: Set<string> };

const KEY_TYPES = `select a.attname, format_type(a.atttypid, a.atttypmod)
 from pg_attribute a
 where a.attrelid = $1::regclass
   and a.attnum > 0
   and not a.attisdropped`;

/**
 * Runs one target's units in order.
 *
 * A finished step is skipped by the caller before it is placed in `units`.
 * A lock timeout retries that step in a new transaction until `lockWaitMs`
 * is spent. A backfill retries the current batch only and resumes from
 * `okm_backfill`.
 *
 * @param connection - Reserved connection. The caller holds the advisory lock
 * @param run - Units, lock wait, and the protection flag
 * @param session - Role assumed for the rest of the connection
 * @returns The target and the migration ids that ran at least one unit
 */
export async function runTarget(
  connection: DriverConnection,
  run: TargetRun,
  session: RunSession,
): Promise<TargetRunReport> {
  const applied: string[] = [];
  const tally: LockTally = { attempts: 0, waitedMs: 0 };
  let done = 0;
  const lock: LockRun = {
    tally,
    done: () => done,
    waiter: (label, earlier = () => done > 0) =>
      lockWaiter(
        {
          waitMs: run.lockWaitMs,
          lockTimeoutMs: run.lockTimeoutMs,
          ...(run.directPid !== undefined ? { pid: run.directPid } : {}),
          ...(run.observer !== undefined ? { observer: run.observer } : {}),
          ...(run.onProgress !== undefined ? { note: run.onProgress } : {}),
          earlier: () => done > 0 || earlier(),
          tally,
        },
        label,
      ),
  };
  for (let index = 0; index < run.units.length; index += 1) {
    const unit = run.units[index];
    if (unit === undefined) continue;
    assertUnitPolicy(run.policy, unit);
    await runUnit(connection, unit, run, session, lock);
    done += 1;
    const next = run.units[index + 1];
    if (next === undefined || next.migrationId !== unit.migrationId) applied.push(unit.migrationId);
  }
  return {
    target: run.policy.target,
    applied,
    ...(session.setRole !== undefined ? { setRole: session.setRole } : {}),
    ...(tally.attempts > 0 ? { lock: tally } : {}),
  };
}

/**
 * Assumes `role` for the rest of this connection.
 *
 * A second call with the same role does nothing. A non-superuser that created
 * the role with `CREATEROLE` is granted membership first: Postgres 15 creates
 * no membership row, and Postgres 16+ grants `ADMIN` without `SET`.
 *
 * @param connection - Reserved connection
 * @param role - Migration role
 * @param session - Remembers the role already assumed
 */
export async function assumeRole(
  connection: DriverConnection,
  role: string,
  session: { setRole?: string },
): Promise<void> {
  if (session.setRole === role) return;
  await ensureSetOption(connection, role);
  await connection.execute(`set role ${quoteIdent(role)}`);
  session.setRole = role;
}

/**
 * Grants the connecting role membership that can `SET ROLE` to `role`.
 *
 * Superusers skip the grant. A role that is already `current_user` skips it.
 * On Postgres 16+ the grant uses `WITH SET TRUE`. On Postgres 15 and earlier
 * `CREATE ROLE` leaves no membership, so a plain `GRANT` is enough.
 *
 * @param connection - Reserved connection, before `SET ROLE`
 * @param role - Role to assume
 */
async function ensureSetOption(connection: DriverConnection, role: string): Promise<void> {
  const who = await connection.execute(
    "select current_user, rolsuper from pg_roles where rolname = current_user",
  );
  const current = who.rows[0]?.[0];
  if (typeof current !== "string" || current === role) return;
  if (roleFlag(who.rows[0]?.[1])) return;
  const version = await connection.execute("show server_version_num");
  const versionNum = Number(version.rows[0]?.[0] ?? 0);
  // `pg_auth_members.set_option` and `GRANT … WITH SET` are Postgres 16+.
  if (Number.isFinite(versionNum) && versionNum >= 160_000) {
    const option = await connection.execute(
      `select am.set_option
         from pg_auth_members am
         join pg_roles r on r.oid = am.roleid
         join pg_roles m on m.oid = am.member
        where r.rolname = $1 and m.rolname = $2`,
      [role, current],
    );
    if (roleFlag(option.rows[0]?.[0])) return;
    await connection.execute(`grant ${quoteIdent(role)} to ${quoteIdent(current)} with set true`);
    return;
  }
  const member = await connection.execute("select pg_has_role($1, $2, 'MEMBER')", [current, role]);
  if (roleFlag(member.rows[0]?.[0])) return;
  await connection.execute(`grant ${quoteIdent(role)} to ${quoteIdent(current)}`);
}

/**
 * Maps a Postgres role-privilege refusal to a clear `OkmError`.
 *
 * @param error - Driver failure
 * @param role - Role named in the step, when known
 * @returns A forbidden error that names CREATEROLE or the SET option, or
 *   `undefined` when the failure is something else
 */
export function rolePrivilegeError(error: unknown, role?: string): OkmError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied to create role/i.test(message)) {
    return new OkmError(
      "forbidden",
      "CREATEROLE is required to create roles. Nothing was changed.",
      {
        kind: "forbidden",
        cause: error,
        fix: {
          summary: "Grant CREATEROLE to the connecting role, or connect as a superuser.",
        },
      },
    );
  }
  if (/permission denied to set role/i.test(message)) {
    const name = role ?? "the migration role";
    return new OkmError(
      "forbidden",
      `Cannot SET ROLE ${name}: the connecting role lacks the SET option on that membership.`,
      {
        kind: "forbidden",
        cause: error,
        fix: {
          summary: `Grant ${name} to the connecting role (WITH SET TRUE on Postgres 16+), or connect as a superuser.`,
        },
      },
    );
  }
  if (/must be able to SET ROLE|not a member/i.test(message)) {
    const name = role ?? "the migration role";
    return new OkmError(
      "forbidden",
      `Cannot SET ROLE ${name}: the connecting role is not a member with the SET option.`,
      {
        kind: "forbidden",
        cause: error,
        fix: {
          summary: `Grant ${name} to the connecting role (WITH SET TRUE on Postgres 16+), or connect as a superuser.`,
        },
      },
    );
  }
  return undefined;
}

/**
 * Lets a new migration role create objects in `schema`.
 *
 * @param connection - Reserved connection, before `SET ROLE`
 * @param schema - Schema the migration writes
 * @param role - Role that was just created
 */
/**
 * Grants the application role `SELECT` on `okm_meta`.
 *
 * No other privilege. When the session has `SET ROLE`, the grant runs as
 * the session user and the role is restored. A second apply grants the
 * same privilege again.
 *
 * @param connection - Reserved connection
 * @param role - Application role. Omitted when the config names none
 * @param session - Role the runner already assumed
 */
export async function grantAppMeta(
  connection: DriverConnection,
  role: string | undefined,
  session: { setRole?: string },
): Promise<void> {
  if (role === undefined) return;
  const previous = session.setRole;
  if (previous !== undefined) await connection.execute("reset role");
  await connection.execute(`grant select on okm_meta to ${quoteIdent(role)}`);
  if (previous !== undefined) await connection.execute(`set role ${quoteIdent(previous)}`);
}

export async function grantSchema(
  connection: DriverConnection,
  schema: string,
  role: string,
): Promise<void> {
  await connection.execute(
    `grant usage, create on schema ${quoteIdent(schema)} to ${quoteIdent(role)}`,
  );
}

/**
 * Makes `role` the owner of `schema` when the connecting role can.
 *
 * Grants on the schema to reporting and other roles need the migration role
 * to own it. A connecting role that is not the owner leaves the schema as is.
 *
 * @param connection - Reserved connection, before `SET ROLE`
 * @param schema - Schema the migration writes
 * @param role - Migration role that was just created
 */
export async function ownSchema(
  connection: DriverConnection,
  schema: string,
  role: string,
): Promise<void> {
  // Postgres 16+ requires SET on the new owner before OWNER TO. The new
  // owner also needs CREATE on the database.
  await ensureSetOption(connection, role);
  const database = await databaseName(connection);
  const attempt = async (): Promise<void> => {
    await connection.execute(
      `grant create on database ${quoteIdent(database)} to ${quoteIdent(role)}`,
    );
    await connection.execute(`alter schema ${quoteIdent(schema)} owner to ${quoteIdent(role)}`);
  };
  // Provision commits CREATE ROLE before this call (installSnapshot flush), so
  // there may be no open transaction. SAVEPOINT only works inside one; outside,
  // a failed GRANT/ALTER does not poison later statements.
  try {
    await connection.execute("savepoint okm_own_schema");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/savepoint can only be used in transaction blocks/i.test(message)) throw error;
    try {
      await attempt();
    } catch {
      // Connecting role cannot own the schema (or grant on the database).
    }
    return;
  }
  try {
    await attempt();
    await connection.execute("release savepoint okm_own_schema");
  } catch {
    // The connecting role is not the owner (or cannot grant on the database).
    // Roll back only this attempt so the surrounding unit transaction stays
    // open. Grants that need ownership fail later with OKM1825 and the same fix.
    await connection.execute("rollback to savepoint okm_own_schema");
  }
}

async function databaseName(connection: DriverConnection): Promise<string> {
  const result = await connection.execute("select current_database()");
  const name = result.rows[0]?.[0];
  return typeof name === "string" ? name : "postgres";
}

async function runUnit(
  connection: DriverConnection,
  unit: RunnableUnit,
  run: TargetRun,
  session: RunSession,
  lock: LockRun,
): Promise<void> {
  const only = unit.steps.length === 1 ? unit.steps[0] : undefined;
  if (only?.step.backfill !== undefined) {
    await runBackfill(connection, unit, only, only.step.backfill, run, lock);
    return;
  }
  if (unitMode(unit) === "committed") {
    if (only === undefined) return;
    await runCommitted(connection, unit, only, run, session, lock);
    return;
  }
  let current = unit.steps[0]?.index ?? 0;
  const label = `${unit.migrationId} step ${String(current + 1)}`;
  try {
    await lock.waiter(label).run(async () => {
      let began = false;
      try {
        await connection.execute("begin");
        began = true;
        await scopeTimeouts(connection, run.lockTimeoutMs, run.statementTimeoutMs);
        if (run.beforeStatements !== undefined) await run.beforeStatements(connection, unit);
        for (const item of unit.steps) {
          current = item.index;
          await executePlanStep(connection, item, run, session);
        }
        if (
          run.migrationRole !== undefined &&
          session.setRole !== run.migrationRole &&
          (await roleExists(connection, run.migrationRole))
        ) {
          await assumeRole(connection, run.migrationRole, session);
        }
        for (const item of unit.steps) await writeStep(connection, unit, item);
        if (unit.finishes) await writeMeta(connection, unit);
        await connection.execute("commit");
      } catch (error) {
        if (began) await connection.execute("rollback").catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    throw failStep(unit, current, error);
  }
}

/**
 * Sets both timeouts for the transaction that just began.
 *
 * `set_config(…, true)` is `SET LOCAL`: it ends with the transaction, so it
 * cannot reach another client behind a pooler.
 *
 * @param connection - Reserved connection, inside a transaction
 * @param lockMs - `lock_timeout` for this attempt
 * @param statementMs - `statement_timeout` for this attempt
 */
async function scopeTimeouts(
  connection: DriverConnection,
  lockMs: number,
  statementMs: number,
): Promise<void> {
  await connection.execute(
    "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
    [String(lockMs), String(statementMs)],
  );
}

async function runCommitted(
  connection: DriverConnection,
  unit: RunnableUnit,
  item: RunnableStep,
  run: TargetRun,
  session: RunSession,
  lock: LockRun,
): Promise<void> {
  if (run.directPid === undefined) throw outsideTransaction(unit, item.index, run.poolerReason);
  const step = committedOf(unit, item);
  await resumeCommittedStep(
    step,
    postgresStepJournal(connection),
    postgresStepEngine(
      connection,
      {
        kind: step.kind,
        sql: item.step.sql,
        ...(item.step.probe !== undefined ? { probe: item.step.probe } : {}),
      },
      () => executePlanStep(connection, item, run, session),
    ),
    {
      wait: lock.waiter(`${unit.migrationId} step ${String(item.index + 1)}`),
      ...(run.failAt !== undefined ? { failAt: run.failAt } : {}),
      wrap: (error) => failStep(unit, item.index, error),
    },
  );
}

function committedOf(unit: RunnableUnit, item: RunnableStep): CommittedStep {
  return {
    migrationId: unit.migrationId,
    stepIndex: item.index,
    kind: item.step.kind ?? "raw-sql",
    sql: item.step.sql,
    sqlHash: stepSqlHash(item.step.sql),
    stepClass: item.step.class,
    catalogHash: unit.catalogHash,
    finishes: unit.finishes,
  };
}

/**
 * Runs one statement, including role creation and the migration-role grants.
 *
 * @param connection - Reserved connection
 * @param item - The step
 * @param run - Role and schema for this target
 * @param session - Role already assumed
 */
async function executePlanStep(
  connection: DriverConnection,
  item: RunnableStep,
  run: TargetRun,
  session: RunSession,
): Promise<void> {
  // Create every managed role as the connecting user first. SET ROLE to
  // the migration role waits until a later non-role step so a second
  // CREATE ROLE is not refused (the migration role has NOCREATEROLE).
  if (
    run.migrationRole !== undefined &&
    !changesRole(item.step.sql) &&
    session.setRole !== run.migrationRole &&
    (await roleExists(connection, run.migrationRole))
  ) {
    await assumeRole(connection, run.migrationRole, session);
  }
  const created = createdRoleName(item.step.sql);
  const existed = created !== undefined && (await roleExists(connection, created));
  if (created === undefined) {
    const ensure = ensureExtensionSchemaSql(item.step.sql, run.schema ?? "public");
    if (ensure !== undefined) await connection.execute(ensure);
    assertPublicGrant(item.step.sql, run.policy.allowProtected === true);
    await connection.execute(item.step.sql);
    await assertRevokeLanded(connection, item.step.sql);
    await rememberExtensionSchema(
      connection,
      item.step.sql,
      run.schema ?? "public",
      (session.extensionSchemas ??= new Set()),
    );
    await assertSchemaUsageLanded(connection, item.step.sql);
  } else if (!existed) await connection.execute(createRoleOnce(item.step.sql));
  if (created !== undefined && created === run.migrationRole && !existed) {
    await grantSchema(connection, run.schema ?? "public", created);
    await ownSchema(connection, run.schema ?? "public", created);
    for (const sql of migrationJournalGrants(created)) await connection.execute(sql);
  }
}

async function runBackfill(
  connection: DriverConnection,
  unit: RunnableUnit,
  item: RunnableStep,
  spec: BackfillSpec,
  run: TargetRun,
  lock: LockRun,
): Promise<void> {
  const columns = await keyColumns(connection, spec);
  const query = boundaryQuery(spec.table, columns);
  const stored = await readCheckpoint(connection, unit.migrationId, item.index);
  if (stored?.state === "done") {
    await connection.execute("begin");
    await connection.execute(
      `insert into okm_history (migration_id, step_index, class, catalog_hash) values ($1, $2, $3, $4)
       on conflict (migration_id, step_index) do nothing`,
      [unit.migrationId, String(item.index), item.step.class, unit.catalogHash],
    );
    if (unit.finishes) await writeMeta(connection, unit);
    await connection.execute("commit");
    return;
  }
  let last = stored?.lastKey ?? null;
  let rows = stored?.rows ?? 0;
  let batches = stored?.batches ?? 0;
  const pause = run.backfillPauseMs ?? DEFAULT_BACKFILL_PAUSE_MS;
  const statementMs =
    run.backfillStatementTimeoutMs ??
    run.statementTimeoutMs ??
    DEFAULT_BACKFILL_STATEMENT_TIMEOUT_MS;
  for (;;) {
    assertTargetPolicy(
      policySubject({
        name: run.policy.target,
        protected: run.policy.protected,
        ...(run.policy.protection !== undefined ? { protection: run.policy.protection } : {}),
      }),
      "backfill",
      run.policy.allowProtected === true,
    );
    const committed = await oneBatch(
      connection,
      unit,
      item,
      spec,
      run,
      query,
      { last, rows, batches, statementMs },
      lock,
    );
    rows = committed.rows;
    batches = committed.batches;
    const note: BackfillBatch = {
      migrationId: unit.migrationId,
      stepIndex: item.index,
      batch: batches,
      rows,
      lastKey: committed.lastKey,
    };
    run.onProgress?.(
      `backfill ${unit.migrationId} step ${String(item.index + 1)} batch ${String(batches)} rows ${String(rows)} key ${committed.lastKey ?? "-"}`,
    );
    await run.afterBatch?.(note);
    if (committed.final) return;
    last = committed.lastKey;
    if (pause > 0) await delay(pause);
  }
}

type BatchState = {
  readonly last: string | null;
  readonly rows: number;
  readonly batches: number;
  readonly statementMs: number;
};

type CommittedBatch = {
  readonly rows: number;
  readonly batches: number;
  readonly lastKey: string | null;
  readonly final: boolean;
};

async function oneBatch(
  connection: DriverConnection,
  unit: RunnableUnit,
  item: RunnableStep,
  spec: BackfillSpec,
  run: TargetRun,
  query: string,
  state: BatchState,
  lock: LockRun,
): Promise<CommittedBatch> {
  const wait = lock.waiter(
    `${unit.migrationId} step ${String(item.index + 1)}`,
    () => state.batches > 0,
  );
  try {
    return await wait.run(async () => {
      let began = false;
      try {
        await connection.execute("begin");
        began = true;
        await scopeTimeouts(connection, run.lockTimeoutMs, state.statementMs);
        const boundary = await connection.execute(query, [state.last, String(spec.batch - 1)]);
        const upper = boundary.rows[0]?.[0] ?? null;
        const final = upper === null;
        const updated = await connection.execute(item.step.sql, [state.last, upper]);
        const rows = state.rows + updated.count;
        const batches = state.batches + 1;
        const lastKey = upper ?? state.last;
        await writeCheckpoint(connection, unit.migrationId, item.index, {
          lastKey,
          rows,
          batches,
          state: final ? "done" : "running",
        });
        if (final) {
          await writeStep(connection, unit, item);
          if (unit.finishes) await writeMeta(connection, unit);
        }
        await connection.execute("commit");
        if (run.failAt === "after-ddl") throw new StepBoundaryStop("after-ddl");
        return { rows, batches, lastKey, final };
      } catch (error) {
        if (began && !(error instanceof StepBoundaryStop)) {
          await connection.execute("rollback").catch(() => undefined);
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof StepBoundaryStop) throw error;
    throw failStep(unit, item.index, error);
  }
}

async function keyColumns(
  connection: DriverConnection,
  spec: BackfillSpec,
): Promise<readonly BackfillColumn[]> {
  const found = await connection.execute(KEY_TYPES, [spec.table]);
  const types = new Map<string, string>();
  for (const row of found.rows) {
    const name = row[0];
    const dataType = row[1];
    if (typeof name === "string" && typeof dataType === "string") types.set(name, dataType);
  }
  return spec.key.map((quoted) => {
    const name = unquote(quoted);
    const dataType = types.get(name);
    if (dataType === undefined) {
      throw new OkmError("OKM1546", `Backfill key ${name} is not a column of ${spec.table}.`, {
        fix: { summary: "Name a primary key column that exists on the table." },
      });
    }
    return { quoted, dataType: checkedCast(dataType) };
  });
}

type Checkpoint = {
  readonly lastKey: string | null;
  readonly rows: number;
  readonly batches: number;
  readonly state: string;
};

async function readCheckpoint(
  connection: DriverConnection,
  migrationId: string,
  stepIndex: number,
): Promise<Checkpoint | undefined> {
  const result = await connection.execute(
    `select last_key, rows_touched::text, batches::text, state
     from okm_backfill
     where migration_id = $1 and step_index = $2`,
    [migrationId, String(stepIndex)],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    lastKey: row[0] ?? null,
    rows: Number(row[1] ?? "0"),
    batches: Number(row[2] ?? "0"),
    state: row[3] ?? "running",
  };
}

async function writeCheckpoint(
  connection: DriverConnection,
  migrationId: string,
  stepIndex: number,
  checkpoint: {
    readonly lastKey: string | null;
    readonly rows: number;
    readonly batches: number;
    readonly state: string;
  },
): Promise<void> {
  await connection.execute(
    `insert into okm_backfill (migration_id, step_index, last_key, rows_touched, batches, state)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (migration_id, step_index) do update set
       last_key = excluded.last_key,
       rows_touched = excluded.rows_touched,
       batches = excluded.batches,
       state = excluded.state,
       updated_at = now()`,
    [
      migrationId,
      String(stepIndex),
      checkpoint.lastKey,
      String(checkpoint.rows),
      String(checkpoint.batches),
      checkpoint.state,
    ],
  );
}

async function writeStep(
  connection: DriverConnection,
  unit: RunnableUnit,
  item: RunnableStep,
): Promise<void> {
  await connection.execute(
    "insert into okm_history (migration_id, step_index, class, catalog_hash) values ($1, $2, $3, $4)",
    [unit.migrationId, String(item.index), item.step.class, unit.catalogHash],
  );
}

async function writeMeta(connection: DriverConnection, unit: RunnableUnit): Promise<void> {
  await connection.execute(
    `insert into okm_meta (id, catalog_hash, migration_id) values ('head', $1, $2)
     on conflict (id) do update set catalog_hash = excluded.catalog_hash, migration_id = excluded.migration_id`,
    [unit.catalogHash, unit.migrationId],
  );
}

const SCHEMA_USAGE =
  /^\s*grant\s+usage\s+on\s+schema\s+(?:"((?:[^"]|"")*)"|([A-Za-z_][\w$]*))\s+to\s+(?:"((?:[^"]|"")*)"|([A-Za-z_][\w$]*))\s*;?\s*$/i;

/**
 * Fails when `GRANT USAGE ON SCHEMA` did not add the role.
 *
 * Postgres warns and changes nothing when the acting role does not own the
 * schema. A later check then reports the grant forever. The migration role
 * has to own the schema first.
 *
 * @param connection - Reserved connection, in the grant's transaction
 * @param sql - The statement that just ran
 */
export async function assertSchemaUsageLanded(
  connection: DriverConnection,
  sql: string,
): Promise<void> {
  const match = SCHEMA_USAGE.exec(sql.trim());
  if (match === null) return;
  const schema = (match[1] ?? match[2] ?? "").replaceAll('""', '"');
  const role = (match[3] ?? match[4] ?? "").replaceAll('""', '"');
  const found = await connection.execute(
    `select exists (
       select 1
       from pg_namespace n
       cross join lateral aclexplode(n.nspacl) a
       join pg_roles r on r.oid = a.grantee
       where n.nspname = $1 and r.rolname = $2 and a.privilege_type = 'USAGE'
     )`,
    [schema, role],
  );
  if (roleFlag(found.rows[0]?.[0])) return;
  throw new OkmError("OKM1825", `Grant usage on schema ${schema} to ${role} did not take effect.`, {
    kind: "forbidden",
    fix: {
      summary: `Make the migration role the owner of schema ${schema}. ALTER SCHEMA ${quoteIdent(schema)} OWNER TO <migration role>.`,
    },
  });
}

function outsideTransaction(
  unit: RunnableUnit,
  index: number,
  reason: string | undefined,
): OkmError {
  const which = reason ?? "the connection is not proven direct";
  return new OkmError(
    "OKM1854",
    `Migration ${unit.migrationId} step ${String(index + 1)} runs outside a transaction. ${which}. A session setting would not stay on one connection. I stopped before running it. Use a direct URL for migrations.`,
    { fix: { summary: "Use a direct connection, without --allow-pooler, for this migration." } },
  );
}

function failStep(unit: RunnableUnit, index: number, error: unknown): OkmError {
  const waited = readLock(error);
  if (waited !== undefined) {
    return lockFailure(
      unit.migrationId,
      index + 1,
      error,
      waited,
      stepFailureFix(error, "apply").summary,
    );
  }
  const lost = sessionFailure(error);
  if (lost !== undefined) {
    return new OkmError(
      lost.code,
      `Migration ${unit.migrationId} failed at step ${String(index + 1)}: ${lost.message}`,
      { kind: lost.kind, cause: error, fix: lost.fix },
    );
  }
  const privilege = rolePrivilegeError(error, undefined);
  if (privilege !== undefined) {
    return new OkmError(
      privilege.code,
      `Migration ${unit.migrationId} failed at step ${String(index + 1)}: ${privilege.message}`,
      { kind: privilege.kind, cause: error, fix: privilege.fix },
    );
  }
  if (error instanceof OkmError) return error;
  const message = error instanceof Error ? error.message : "The step failed.";
  return new OkmError(
    "invalid",
    `Migration ${unit.migrationId} failed at step ${String(index + 1)}: ${message}`,
    {
      cause: error,
      fix: stepFailureFix(error, "apply"),
      ...(isLockTimeout(error) ? { retryable: true } : {}),
    },
  );
}

/**
 * Advice for a step that failed while applying or while `migrate check` replayed it.
 *
 * A lock timeout is a wait, so the step stays as written. Any other failure
 * still says to fix the step and run apply again.
 *
 * @param error - The driver error, or whatever the step threw
 * @param again - Which command the person should run
 * @returns The fix summary
 */
export function stepFailureFix(
  error: unknown,
  again: "apply" | "check",
): { readonly summary: string } {
  if (isExtensionOwner(error)) {
    return {
      summary:
        "The migration role does not own this extension. Make that role the owner, or run okm migrate check as the owner. A NOSUPERUSER role cannot alter an extension or type it does not own.",
    };
  }
  if (isLockTimeout(error)) {
    const command = again === "apply" ? "okm migrate apply" : "okm migrate check";
    const tail =
      again === "apply"
        ? "Finished steps are not repeated, so running it again is safe."
        : "The step does not need a change, so running it again is safe.";
    return {
      summary: `I could not get a lock in time and stopped at this step. Run ${command} again when that lock is free. ${tail}`,
    };
  }
  return { summary: "Fix the step and run apply again. Finished steps are not repeated." };
}

function isExtensionOwner(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /must be owner of (extension|type)\b/i.test(message);
}

function roleFlag(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function unquote(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replaceAll('""', '"');
  }
  return token;
}

/**
 * Reports whether Postgres refuses to run `sql` inside a transaction.
 *
 * `VACUUM`, `ALTER TYPE … ADD VALUE`, and concurrent index create or drop
 * each need their own unit.
 *
 * @param sql - One statement
 * @returns `true` when the statement cannot share a transaction
 */
export function statementOutsideTransaction(sql: string): boolean {
  const text = sql.trim().toLowerCase();
  if (text.startsWith("vacuum")) return true;
  if (/^alter\s+type\b/.test(text) && /\badd\s+value\b/.test(text)) return true;
  if (/^create\s+(?:unique\s+)?index\s+concurrently\b/.test(text)) return true;
  if (/^drop\s+index\s+concurrently\b/.test(text)) return true;
  return false;
}

function assertUnitPolicy(policy: RunPolicy, unit: RunnableUnit): void {
  let operation: PolicyOperation = "expand";
  for (const item of unit.steps) {
    if (item.step.action === "backfill") {
      operation = "backfill";
      break;
    }
    if (item.step.class === "contract" || item.step.class === "unclassified") {
      operation = item.step.class;
    }
  }
  assertTargetPolicy(
    policySubject({
      name: policy.target,
      protected: policy.protected,
      ...(policy.protection !== undefined ? { protection: policy.protection } : {}),
    }),
    operation,
    policy.allowProtected === true,
  );
}

function assertPublicGrant(sql: string, allowProtected: boolean): void {
  if (allowProtected) return;
  if (!/\b(grant|revoke)\b/i.test(sql)) return;
  if (!/\b(to|from)\s+public\b/i.test(sql)) return;
  // CONNECT on a table is not a privilege. The server rejects it, and that
  // error text contains CONNECT, which must stay a database error.
  if (/\bgrant\s+connect\s+on\s+table\b/i.test(sql)) return;
  if (/\brevoke\b/i.test(sql) && /\bokm_refresh_[a-z0-9_]+"?\s*\(/i.test(sql)) return;
  throw new OkmError(
    "OKM1850",
    "This statement grants or revokes PUBLIC. It needs --allow-protected.",
    { fix: { summary: "Pass --allow-protected, or remove the public grant." } },
  );
}

async function assertRevokeLanded(connection: DriverConnection, sql: string): Promise<void> {
  const parsed = parseRevoke(sql);
  if (parsed === undefined || parsed.role === "public") return;
  const left =
    parsed.kind === "schema"
      ? await connection.execute(
          `select o.rolname from pg_namespace n
           cross join lateral aclexplode(n.nspacl) a
           join pg_roles g on g.oid = a.grantee
           join pg_roles o on o.oid = a.grantor
           where n.nspname = $1 and g.rolname = $2 and a.privilege_type = $3`,
          [parsed.name, parsed.role, parsed.privilege],
        )
      : await connection.execute(
          `select o.rolname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(c.relacl) a
           join pg_roles g on g.oid = a.grantee
           join pg_roles o on o.oid = a.grantor
           where n.nspname = $1 and c.relname = $2 and g.rolname = $3 and a.privilege_type = $4`,
          [parsed.schema, parsed.name, parsed.role, parsed.privilege],
        );
  const grantor = left.rows[0]?.[0];
  if (grantor === undefined || grantor === null) return;
  throw new OkmError(
    "OKM1913",
    `REVOKE of ${parsed.privilege} on ${parsed.name} from ${parsed.role} left the privilege in place. The grantor is ${String(grantor)}. Run as that grantor, or use GRANTED BY with the needed membership.`,
    {
      kind: "forbidden",
      fix: {
        summary:
          "Run the revoke as the grantor, or GRANT that role to the migration role with ADMIN OPTION and revoke GRANTED BY the grantor.",
      },
    },
  );
}

function parseRevoke(sql: string):
  | {
      readonly privilege: string;
      readonly kind: string;
      readonly schema: string;
      readonly name: string;
      readonly role: string;
    }
  | undefined {
  const text = sql.trim();
  if (!/^revoke\s/i.test(text)) return undefined;
  const match =
    /^revoke\s+([a-z_]+)(?:\s*\([^)]*\))?\s+on\s+(table|sequence|function|schema)\s+(.+?)\s+from\s+("[^"]+"|[a-z_][\w$]*)$/i.exec(
      text,
    );
  if (match === null) return undefined;
  const privilege = (match[1] ?? "").toUpperCase();
  const kind = (match[2] ?? "").toLowerCase();
  const target = match[3] ?? "";
  const role = unquote(match[4] ?? "");
  const names = target.split(".").map((part) => unquote(part));
  const name = names[names.length - 1] ?? "";
  const schema = names.length > 1 ? (names[0] ?? "public") : "public";
  if (name.length === 0 || role.length === 0) return undefined;
  return { privilege, kind, schema, name, role };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
