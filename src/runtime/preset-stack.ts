/**
 * Puts preset filters after a caller's filter.
 *
 * Kept apart from the presets module so a write or an archive that uses no
 * preset does not load the code that runs them.
 */

import { tag } from "../dialects/pg/operators.js";

/**
 * Joins a caller's `where` and the filters presets added, with AND.
 *
 * The planner reads the result like any `where`, so the tenant predicate and
 * the active set are written around it and cannot be dropped by a preset.
 *
 * @param where - The caller's `where`, when there is one
 * @param presets - Filters the presets added, in call order. Absent or empty adds nothing
 * @returns The same `where`, or one that also holds the preset filters
 */
export function stack(where: unknown, presets: readonly unknown[] | undefined): unknown {
  if (presets === undefined || presets.length === 0) return where;
  return tag("and", where === undefined ? presets : [where, ...presets]);
}
