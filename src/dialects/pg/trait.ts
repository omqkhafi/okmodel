/**
 * Trait values `schema()` applies.
 *
 * The timestamp columns and their clock live in `okmodel/traits`. This module
 * only reads the object a schema passes in, so an application that never
 * imports a trait does not load that code.
 */

import { definition, unavailable } from "./misuse.js";

/**
 * Columns `schema()` passes to {@link Trait.apply}.
 *
 * `columns` starts as the table's own fields. `apply` adds the trait's fields
 * or throws OKM1012 when a name is already there.
 */
export type TraitModel = {
  columns: Record<string, object>;
};

/**
 * The table `apply` is adding columns to.
 */
export type TraitContext = {
  readonly table: string;
};

/**
 * Columns and write rules a trait contributes.
 *
 * `fields` are real columns. `touch` columns are set to `now()` on update.
 * `sealed` columns cannot be set from input, including `{ allow }`.
 * A touched column is sealed. `apply` is the trait's own merge. `schema()`
 * only calls it.
 */
export type Trait = {
  readonly name: string;
  readonly fields: Readonly<Record<string, object>>;
  readonly touch?: readonly string[];
  readonly sealed?: readonly string[];
  /**
   * Adds this trait's columns to one table.
   *
   * @param model - Columns collected so far
   * @param ctx - Table name, for OKM1012
   */
  apply(model: TraitModel, ctx: TraitContext): void;
};

/**
 * Field maps of every trait in a list, as one object.
 *
 * An empty list contributes no fields. The field types stay on the value
 * `trait()` returned; this reads them back.
 *
 * @typeParam TTraits - Trait list
 */
export type FieldsOfList<TTraits> = TTraits extends readonly []
  ? Record<never, never>
  : TTraits extends readonly (infer TItem)[]
    ? UnionToIntersection<
        TItem extends { readonly fields: infer TFields } ? TFields : Record<never, never>
      >
    : Record<never, never>;

type UnionToIntersection<TUnion> = (
  TUnion extends unknown ? (argument: TUnion) => void : never
) extends (argument: infer TIntersection) => void
  ? TIntersection
  : never;

/** A trait object before `trait()` attaches `apply`. */
type CheckedTrait = {
  readonly name: string;
  readonly fields: Readonly<Record<string, object>>;
  readonly touch?: readonly string[];
  readonly sealed?: readonly string[];
};

const TRAIT_KEYS = new Set(["fields", "name", "sealed", "touch"]);

/**
 * Checks one trait object.
 *
 * `presets`, `methods`, and `requires` are part of the type and rejected
 * until the prompt that implements them.
 *
 * @param value - One entry of a traits list
 * @param where - `schema()` or the table name, for the error
 * @returns The same object when it is a trait
 */
export function checkTrait(value: unknown, where: string): CheckedTrait {
  if (!isRecord(value)) definition(`${where} traits must be a list of traits.`);
  for (const key of Object.keys(value)) {
    if (key === "presets" || key === "methods" || key === "requires") {
      unavailable(`Trait option ${key} is not available yet. It arrives in 0.2.`);
    }
    if (!TRAIT_KEYS.has(key)) {
      definition(
        `${where} trait option ${key} is not supported. Accepted options: fields, name, sealed, touch.`,
      );
    }
  }
  const name = value.name;
  if (typeof name !== "string" || name.length === 0) definition(`${where} trait needs a name.`);
  const fields = value.fields;
  if (!isRecord(fields)) definition(`Trait ${name} needs a fields object.`);
  const known = Object.keys(fields);
  readNames(value.touch, name, "touch", known);
  readNames(value.sealed, name, "sealed", known);
  return value as CheckedTrait;
}

/**
 * Trait field builders that apply to one table, in catalog order.
 *
 * `emitRowTypes` uses this. `schema()` has already rejected a conflict.
 *
 * @param schemaTraits - Traits stored on the built schema
 * @param options - This table's `traits` and `omitDefaults`
 * @returns Field name and builder pairs. Empty when the table has no traits
 */
export function contributedFields(
  schemaTraits: readonly Trait[] | undefined,
  options: { readonly traits?: readonly Trait[]; readonly omitDefaults?: string } | undefined,
): readonly (readonly [string, object])[] {
  const chosen = choose(
    options?.omitDefaults === undefined ? schemaTraits : undefined,
    options?.traits,
  );
  if (chosen === undefined) return [];
  const pairs: (readonly [string, object])[] = [];
  const seen = new Set<string>();
  for (const trait of chosen) {
    for (const field of Object.keys(trait.fields)) {
      if (seen.has(field)) continue;
      const builder = trait.fields[field];
      if (builder === undefined) continue;
      seen.add(field);
      pairs.push([field, builder]);
    }
  }
  return pairs;
}

function choose(
  schemaTraits: readonly Trait[] | undefined,
  local: readonly Trait[] | undefined,
): readonly Trait[] | undefined {
  const shared = schemaTraits ?? [];
  const own = local ?? [];
  if (shared.length === 0 && own.length === 0) return undefined;
  if (own.length === 0) return shared;
  if (shared.length === 0) return own;
  return [...shared, ...own];
}

function readNames(
  value: unknown,
  traitName: string,
  label: string,
  known: readonly string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value))
    definition(`Trait ${traitName} ${label} must be a list of field names.`);
  for (const field of value) {
    if (typeof field === "string" && known.includes(field)) continue;
    definition(
      `Trait ${traitName} ${label} names ${String(field)}, which is not one of its fields. Accepted fields: ${known.join(", ")}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
