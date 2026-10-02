/**
 * Run state in the control database.
 *
 * Rows hold target names, checkpoints, and errors. They do not hold URLs.
 */

import type { Sql } from "postgres";

import { quoteIdent } from "../catalog/sql.js";
import type { TargetClass } from "./target.js";
import type { TargetRunRecord } from "./plan.js";

/** One control-database row. */
export type ControlRow = TargetRunRecord & {
  readonly class: TargetClass;
  readonly planId: string;
};

/**
 * Creates the run-state table in `schema`.
 *
 * @param sql - Connection to the control database
 * @param schema - Schema that holds run state
 */
export async function ensureControlSchema(sql: Sql, schema: string): Promise<void> {
  const quoted = quoteIdent(schema);
  await sql.unsafe(`create schema if not exists ${quoted}`);
  await sql.unsafe(`
    create table if not exists ${quoted}.run_target (
      run_id text not null,
      plan_id text not null,
      target_name text not null,
      class text not null,
      state text not null,
      checkpoint text,
      error text,
      primary key (run_id, target_name)
    )
  `);
}

/**
 * Inserts or updates one target's row.
 *
 * @param sql - Control database
 * @param schema - Run-state schema
 * @param runId - Run id
 * @param row - Target progress
 */
export async function saveControlRow(
  sql: Sql,
  schema: string,
  runId: string,
  row: ControlRow,
): Promise<void> {
  await sql.unsafe(
    `insert into ${quoteIdent(schema)}.run_target
       (run_id, plan_id, target_name, class, state, checkpoint, error)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (run_id, target_name) do update set
       state = excluded.state,
       checkpoint = excluded.checkpoint,
       error = excluded.error`,
    [runId, row.planId, row.name, row.class, row.state, row.checkpoint, row.error],
  );
}

/**
 * Reads one run back.
 *
 * @param sql - Control database
 * @param schema - Run-state schema
 * @param runId - Run id
 * @returns Rows in target-name order
 */
export async function readControlRows(
  sql: Sql,
  schema: string,
  runId: string,
): Promise<readonly ControlRow[]> {
  const rows = await sql.unsafe(
    `select plan_id, target_name, class, state, checkpoint, error
     from ${quoteIdent(schema)}.run_target
     where run_id = $1
     order by target_name`,
    [runId],
  );
  return rows.map((row) => ({
    planId: text(row.plan_id),
    name: text(row.target_name),
    class: text(row.class) === "shared" ? "shared" : "tenant",
    state: stateOf(text(row.state)),
    checkpoint:
      row.checkpoint === null || row.checkpoint === undefined ? null : text(row.checkpoint),
    error: row.error === null || row.error === undefined ? null : text(row.error),
  }));
}

/**
 * Drops a control schema created for one test.
 *
 * @param sql - Control database
 * @param schema - Schema name
 */
export async function dropControlSchema(sql: Sql, schema: string): Promise<void> {
  await sql.unsafe(`drop schema if exists ${quoteIdent(schema)} cascade`);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function stateOf(value: string): TargetRunRecord["state"] {
  if (
    value === "pending" ||
    value === "running" ||
    value === "current" ||
    value === "failed" ||
    value === "skipped"
  ) {
    return value;
  }
  return "failed";
}
