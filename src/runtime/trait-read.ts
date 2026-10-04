/**
 * Reads sealed and touch columns off the traits stored on a table.
 *
 * `schema()` does not copy those lists onto the model. This module is
 * imported by the write path, which loads on the first write.
 */

import type { TableModel } from "../dialects/pg/model.js";

/**
 * Fields a trait sets to `now()` on update.
 *
 * @param model - Table model
 * @returns Field names, or `undefined` when no trait touches a column
 */
export function touchFields(model: TableModel): readonly string[] | undefined {
  const traits = model.traits;
  if (traits === undefined) return undefined;
  const names: string[] = [];
  for (const trait of traits) {
    const touch = trait.touch;
    if (touch === undefined) continue;
    for (const field of touch) names.push(field);
  }
  return names.length === 0 ? undefined : names;
}

/**
 * Whether a trait owns this field, so input cannot set it.
 *
 * @param model - Table model
 * @param field - Field name
 * @returns `true` when a trait seals it
 */
export function fieldSealed(model: TableModel, field: string): boolean {
  const traits = model.traits;
  if (traits === undefined) return false;
  for (const trait of traits) {
    const sealed = trait.sealed;
    if (sealed === undefined) continue;
    for (const name of sealed) if (name === field) return true;
  }
  return false;
}

/**
 * The trait that seals a field, when one does.
 *
 * @param model - Table model
 * @param field - Field name
 * @returns The trait name, or `undefined`
 */
export function sealingTrait(model: TableModel, field: string): string | undefined {
  const traits = model.traits;
  if (traits === undefined) return undefined;
  for (const trait of traits) {
    const sealed = trait.sealed;
    if (sealed === undefined) continue;
    for (const name of sealed) if (name === field) return trait.name;
  }
  return undefined;
}
