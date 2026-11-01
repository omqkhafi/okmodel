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
  resumeCommittedStep,
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

/** One target's units, retries, and checkpoints. */
export type TargetRun = {
  readonly policy: RunPolicy;
  readonly units: readonly RunnableUnit[];
  readonly retries: number;
  readonly lockTimeoutMs: number;
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
};

const BACKOFF_MS = 50;

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
 * Lock timeout retries that step. A backfill retries the current batch only
 * and resumes from `okm_backfill`.
 *
 * @param connection - Reserved connection. The caller holds the advisory lock
 * @param run - Units, retries, and the protection flag
 * @param session - Role assumed for the rest of the connection
 * @returns The target and the migration ids that ran at least one unit
 */
export async function runTarget(
  connection: DriverConnection,
  run: TargetRun,
  session: RunSession,
): Promise<TargetRunReport> {
  const applied: string[] = [];
  for (let index = 0; index < run.units.length; index += 1) {
    const unit = run.units[index];
    if (unit === undefined) continue;
    assertUnitPolicy(run.policy, unit);
    await runUnit(connection, unit, run, session);
    const next = run.units[index + 1];
    if (next === undefined || next.migrationId !== unit.migrationId) applied.push(unit.migrationId);
  }
  return {
    target: run.policy.target,
    applied,
    ...(session.setRole !== undefined ? { setRole: session.setRole } : {}),
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
): Promise<void> {
  const only = unit.steps.length === 1 ? unit.steps[0] : undefined;
  if (only?.step.backfill !== undefined) {
    await runBackfill(connection, unit, only, only.step.backfill, run);
    return;
  }
  if (unitMode(unit) === "committed") {
    if (only === undefined) return;
    await runCommitted(connection, unit, only, run, session);
    return;
  }
  for (let attempt = 0; attempt <= run.retries; attempt += 1) {
    let began = false;
    let current = unit.steps[0]?.index ?? 0;
    try {
      await connection.execute("begin");
      began = true;
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
      return;
    } catch (error) {
      if (began) await connection.execute("rollback").catch(() => undefined);
      if (!isLockTimeout(error) || attempt === run.retries) throw failStep(unit, current, error);
      await delay(BACKOFF_MS * 2 ** attempt);
    }
  }
}

async function runCommitted(
  connection: DriverConnection,
  unit: RunnableUnit,
  item: RunnableStep,
  run: TargetRun,
  session: RunSession,
): Promise<void> {
  const step = committedOf(unit, item);
  await resumeCommittedStep(
    step,
    postgresStepJournal(connection),
    postgresStepEngine(
      connection,
      {
        kind: step.kind,
        sql: item.step.sql,
        lockTimeoutMs: run.lockTimeoutMs,
        ...(item.step.probe !== undefined ? { probe: item.step.probe } : {}),
      },
      () => executePlanStep(connection, item, run, session),
    ),
    {
      retries: run.retries,
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
    await connection.execute(item.step.sql);
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
    const committed = await oneBatch(connection, unit, item, spec, run, query, {
      last,
      rows,
      batches,
      statementMs,
    });
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
): Promise<CommittedBatch> {
  for (let attempt = 0; attempt <= run.retries; attempt += 1) {
    let began = false;
    try {
      await connection.execute("begin");
      began = true;
      await connection.execute("select set_config('lock_timeout', $1, true)", [
        String(run.lockTimeoutMs),
      ]);
      await connection.execute("select set_config('statement_timeout', $1, true)", [
        String(state.statementMs),
      ]);
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
      return { rows, batches, lastKey, final };
    } catch (error) {
      if (began) await connection.execute("rollback").catch(() => undefined);
      if (!isLockTimeout(error) || attempt === run.retries) throw failStep(unit, item.index, error);
      await delay(BACKOFF_MS * 2 ** attempt);
    }
  }
  throw failStep(unit, item.index, new Error("The batch did not commit."));
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

function failStep(unit: RunnableUnit, index: number, error: unknown): OkmError {
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
      again === "apply" ? "Finished steps are not repeated." : "The step does not need a change.";
    return {
      summary: `A lock timed out. Run ${command} again when that lock is free. ${tail}`,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
