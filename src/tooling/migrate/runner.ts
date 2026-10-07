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
import { createdRoleName, createRoleOnce } from "../../dialects/pg/role/sql.js";
import {
  boundaryQuery,
  checkedCast,
  DEFAULT_BACKFILL_PAUSE_MS,
  DEFAULT_BACKFILL_STATEMENT_TIMEOUT_MS,
  type BackfillColumn,
  type BackfillSpec,
} from "./backfill.js";
import type { PlanStep } from "./plan.js";
import { assertTargetPolicy, type PolicyOperation } from "./policy.js";

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
};

/** What {@link runTarget} finished on this target. */
export type TargetRunReport = {
  readonly target: string;
  readonly applied: readonly string[];
  readonly setRole?: string;
};

const BACKOFF_MS = 50;

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
  session: { setRole?: string },
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
 * A second call with the same role does nothing.
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
  await connection.execute(`set role ${quoteIdent(role)}`);
  session.setRole = role;
}

/**
 * Lets a new migration role create objects in `schema`.
 *
 * @param connection - Reserved connection, before `SET ROLE`
 * @param schema - Schema the migration writes
 * @param role - Role that was just created
 */
export async function grantSchema(
  connection: DriverConnection,
  schema: string,
  role: string,
): Promise<void> {
  await connection.execute(
    `grant usage, create on schema ${quoteIdent(schema)} to ${quoteIdent(role)}`,
  );
}

async function runUnit(
  connection: DriverConnection,
  unit: RunnableUnit,
  run: TargetRun,
  session: { setRole?: string },
): Promise<void> {
  const only = unit.steps.length === 1 ? unit.steps[0] : undefined;
  if (only?.step.backfill !== undefined) {
    await runBackfill(connection, unit, only, only.step.backfill, run);
    return;
  }
  for (let attempt = 0; attempt <= run.retries; attempt += 1) {
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
        if (created === undefined) await connection.execute(item.step.sql);
        else if (!existed) await connection.execute(createRoleOnce(item.step.sql));
        if (created !== undefined && created === run.migrationRole) {
          if (!existed) {
            await grantSchema(connection, run.schema ?? "public", created);
            await connection.execute(
              `grant select, insert, update on okm_meta, okm_history, okm_backfill to ${quoteIdent(created)}`,
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
      if (!isLockTimeout(error) || attempt === run.retries) throw failStep(unit, current, error);
      await delay(BACKOFF_MS * 2 ** attempt);
    }
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
      { name: run.policy.target, protected: run.policy.protected },
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
      `backfill ${unit.migrationId} step ${String(item.index)} batch ${String(batches)} rows ${String(rows)} key ${committed.lastKey ?? "-"}`,
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

function failStep(unit: RunnableUnit, index: number, error: unknown): OkmError {
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
    { name: policy.target, protected: policy.protected },
    operation,
    policy.allowProtected === true,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
