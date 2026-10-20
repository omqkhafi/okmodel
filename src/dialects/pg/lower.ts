/**
 * Postgres DDL lowering.
 *
 * Statement families move here from the planner one group at a time.
 * Until a family moves, the planner still emits that SQL itself.
 * Output for a catalog pair stays the recorded plan.
 */

import type { DdlStep, LogicalChange } from "../ddl.js";

/**
 * Lowers one logical change to Postgres statements.
 *
 * @param change - Logical change from the planner
 * @returns Physical steps. The pending variant has none
 */
export function lowerPostgres(change: LogicalChange): readonly DdlStep[] {
  if (change.op === "pending") return [];
  return [];
}
