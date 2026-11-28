/**
 * Enum and domain catalog checks that `schema()` runs at startup.
 *
 * Kind `type`, identity `(namespace, name)`. Constructors that allocate the
 * catalog objects live in `enum-type.ts`, so a bundle can keep them with the
 * catalog compiler.
 */

import type { DomainDefinition, TypeDefinition } from "./types.js";

/**
 * Reports whether a type definition is a domain.
 *
 * @param definition - Enum labels or a domain base and check
 * @returns `true` when the definition has a base type
 */
export function isDomain(definition: TypeDefinition): definition is DomainDefinition {
  return "base" in definition;
}

/**
 * Reports whether two label lists are the same text in the same order.
 *
 * @param left - First list
 * @param right - Second list
 * @returns `true` when every position matches
 */
export function sameEnumLabels(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
