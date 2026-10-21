/**
 * Postgres journal for a committed step.
 *
 * `okm_steps` is written in its own statement. The history row and the
 * delete of that marker commit together. The runner string is the backend
 * pid and the OKModel version.
 */

import type { DriverConnection } from "../../contracts/driver.js";
import { readPackageVersion } from "../cli/version.js";
import type { CommittedStep, MarkerState, StepJournal, StepMarker } from "./step-engine.js";

/**
 * Journal bound to one reserved connection.
 *
 * @param connection - Apply connection, not inside a transaction
 * @returns Reads and writes for {@link resumeCommittedStep}
 */
export function postgresStepJournal(connection: DriverConnection): StepJournal {
  return {
    read: (migrationId, stepIndex) => readMarker(connection, migrationId, stepIndex),
    start: (step, attempt) => startMarker(connection, step, attempt),
    fail: (migrationId, stepIndex, code, errorText) =>
      failMarker(connection, migrationId, stepIndex, code, errorText),
    complete: (step) => completeMarker(connection, step),
  };
}

async function readMarker(
  connection: DriverConnection,
  migrationId: string,
  stepIndex: number,
): Promise<StepMarker | undefined> {
  const result = await connection.execute(
    `select kind, sql_hash, state, attempt::text
     from okm_steps
     where migration_id = $1 and step_index = $2`,
    [migrationId, String(stepIndex)],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const kind = row[0];
  const sqlHash = row[1];
  const state = row[2];
  const attempt = row[3];
  if (kind === null || kind === undefined) return undefined;
  if (sqlHash === null || sqlHash === undefined) return undefined;
  if (!isMarkerState(state)) return undefined;
  return {
    migrationId,
    stepIndex,
    kind,
    sqlHash,
    state,
    attempt: Number(attempt ?? "0"),
  };
}

async function startMarker(
  connection: DriverConnection,
  step: CommittedStep,
  attempt: number,
): Promise<void> {
  const runner = await runnerLabel(connection);
  await connection.execute(
    `insert into okm_steps (
       migration_id, step_index, kind, sql_hash, state, attempt, started_at, runner
     ) values ($1, $2, $3, $4, 'started', $5, now(), $6)
     on conflict (migration_id, step_index) do update set
       kind = excluded.kind,
       sql_hash = excluded.sql_hash,
       state = 'started',
       attempt = excluded.attempt,
       started_at = now(),
       finished_at = null,
       runner = excluded.runner,
       error_code = null,
       error_text = null`,
    [step.migrationId, String(step.stepIndex), step.kind, step.sqlHash, String(attempt), runner],
  );
}

async function failMarker(
  connection: DriverConnection,
  migrationId: string,
  stepIndex: number,
  code: string,
  errorText: string,
): Promise<void> {
  await connection.execute(
    `update okm_steps
     set state = 'failed', finished_at = now(), error_code = $3, error_text = $4
     where migration_id = $1 and step_index = $2`,
    [migrationId, String(stepIndex), code, errorText],
  );
}

async function completeMarker(connection: DriverConnection, step: CommittedStep): Promise<void> {
  await connection.execute("begin");
  try {
    await connection.execute(
      "insert into okm_history (migration_id, step_index, class, catalog_hash) values ($1, $2, $3, $4)",
      [step.migrationId, String(step.stepIndex), step.stepClass, step.catalogHash],
    );
    await connection.execute("delete from okm_steps where migration_id = $1 and step_index = $2", [
      step.migrationId,
      String(step.stepIndex),
    ]);
    if (step.finishes) {
      await connection.execute(
        `insert into okm_meta (id, catalog_hash, migration_id) values ('head', $1, $2)
         on conflict (id) do update set catalog_hash = excluded.catalog_hash, migration_id = excluded.migration_id`,
        [step.catalogHash, step.migrationId],
      );
    }
    await connection.execute("commit");
  } catch (error) {
    await connection.execute("rollback").catch(() => undefined);
    throw error;
  }
}

async function runnerLabel(connection: DriverConnection): Promise<string> {
  const result = await connection.execute("select pg_backend_pid()::text");
  const pid = result.rows[0]?.[0];
  const id = pid === null || pid === undefined || pid.length === 0 ? "0" : pid;
  return `${id} ${readPackageVersion()}`;
}

function isMarkerState(value: string | null | undefined): value is MarkerState {
  return value === "started" || value === "failed" || value === "retry";
}
