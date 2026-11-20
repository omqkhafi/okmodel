/**
 * The PostgreSQL words the `computed` read compiler writes.
 *
 * `FILTER`, `bool_or`, `MATERIALIZED`, and `OFFSET ... LIMIT 1` inside an
 * `EXISTS` are Postgres. Each is one named function, so the compiler in the
 * runtime layer holds no dialect text of its own.
 */

import type { RelationSink } from "./model.js";

/**
 * Writes ` filter (<condition>)` after an aggregate.
 *
 * @param sink - Statement under construction
 * @param condition - Writes the condition, starting with its own `where`
 */
export function emitFilter(sink: RelationSink, condition: () => void): void {
  sink.text(" filter (");
  condition();
  sink.text(")");
}

/**
 * Writes the aggregate that reads `true` when any grouped row matched.
 *
 * @param sink - Statement under construction
 */
export function emitAnyRow(sink: RelationSink): void {
  sink.text("bool_or(true)");
}

/**
 * Writes `with <name> as materialized (<body>)`.
 *
 * `materialized` makes the page one scan that every grouped subquery reads.
 *
 * @param sink - Statement under construction
 * @param name - CTE name
 * @param body - Writes the select
 */
export function emitMaterialized(sink: RelationSink, name: string, body: () => void): void {
  sink.text(`with ${name} as materialized (`);
  body();
  sink.text(")");
}

/**
 * Writes ` offset $n limit 1`: stop at the n-th matching row.
 *
 * @param sink - Statement under construction
 * @param skipped - Rows to pass over before the one that proves the threshold
 */
export function emitSkipOne(sink: RelationSink, skipped: number): void {
  sink.text(" offset ");
  sink.param(String(skipped));
  sink.text(" limit 1");
}
