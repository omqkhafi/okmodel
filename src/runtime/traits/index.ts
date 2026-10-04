/**
 * Traits (`okmodel/traits`).
 *
 * Importing this module is what puts a trait on a schema. An application that
 * does not import it does not load these columns.
 */

import { OkmError } from "../../contracts/error.js";
import { definition, unavailable } from "../../dialects/pg/misuse.js";
import { timestamptz } from "../../dialects/pg/time.js";
import {
  checkTrait,
  type Trait,
  type TraitContext,
  type TraitModel,
} from "../../dialects/pg/trait.js";

export type { Trait };

/**
 * Options `trait()` accepts.
 *
 * `presets`, `methods`, and `requires` are named here and rejected until the
 * prompt that implements them.
 *
 * @typeParam TFields - Columns the trait adds
 */
export type TraitDefinition<TFields extends Readonly<Record<string, object>>> = {
  readonly fields: TFields;
  /** Columns set to `now()` on update. Each one is sealed. */
  readonly touch?: readonly (keyof TFields & string)[];
  /** Columns input cannot set, including `{ allow }`. */
  readonly sealed?: readonly (keyof TFields & string)[];
  readonly presets?: unknown;
  readonly methods?: unknown;
  readonly requires?: unknown;
};

/**
 * Builds a trait.
 *
 * The same function the built-in traits use. `schema()` copies `fields` onto
 * each table and rejects a field the table already has (OKM1012).
 *
 * @typeParam TFields - Columns the trait adds
 * @param name - Provenance name stored on those columns
 * @param definition - Fields and, when needed, which ones the write path seals
 * @returns The trait
 */
export function trait<const TFields extends Readonly<Record<string, object>>>(
  name: string,
  input: TraitDefinition<TFields>,
): {
  readonly name: string;
  readonly fields: TFields;
  readonly touch?: readonly (keyof TFields & string)[];
  readonly sealed?: readonly (keyof TFields & string)[];
  apply(model: TraitModel, ctx: TraitContext): void;
} {
  if (input.presets !== undefined) {
    unavailable("Trait option presets is not available yet. It arrives in 0.2.");
  }
  if (input.methods !== undefined) {
    unavailable("Trait option methods is not available yet. It arrives in 0.2.");
  }
  if (input.requires !== undefined) {
    unavailable("Trait option requires is not available yet. It arrives in 0.2.");
  }
  const checked = checkTrait(
    {
      name,
      fields: input.fields,
      ...(input.touch !== undefined ? { touch: input.touch } : {}),
      ...(input.sealed !== undefined ? { sealed: input.sealed } : {}),
    },
    `trait(${name})`,
  );
  markFields(checked.fields, name);
  const sealed = sealTouch(checked.sealed, checked.touch);
  return {
    name,
    fields: checked.fields as TFields,
    ...(checked.touch !== undefined
      ? { touch: checked.touch as readonly (keyof TFields & string)[] }
      : {}),
    ...(sealed !== undefined ? { sealed: sealed as readonly (keyof TFields & string)[] } : {}),
    apply(model, ctx) {
      addFields(name, checked.fields, model, ctx);
    },
  };
}

/**
 * Options for {@link timestamps}.
 *
 * `enforce: "trigger"` is the database trigger. It arrives in 0.3.
 */
export type TimestampsOptions = {
  readonly enforce?: "trigger";
};

/**
 * Adds `createdAt` and `updatedAt`.
 *
 * Both are `timestamptz not null default now()`, and input cannot set either
 * of them. Insert leaves them to the default, so one statement stamps both
 * with the same time. Update sets `updatedAt` to `now()` and leaves `createdAt`.
 *
 * @param options - Pass `{ enforce: "trigger" }` only when the trigger ships
 * @returns The timestamps trait
 */
export function timestamps(options?: TimestampsOptions) {
  if (options !== undefined) {
    for (const key of Object.keys(options)) {
      if (key !== "enforce") {
        definition(`timestamps() option ${key} is not supported. Accepted options: enforce.`);
      }
    }
    if (options.enforce === "trigger") {
      unavailable(`timestamps({ enforce: "trigger" }) is not available yet. It arrives in 0.3.`);
    }
    if (options.enforce !== undefined) {
      definition(`timestamps() enforce ${String(options.enforce)} must be trigger.`);
    }
  }
  return trait("timestamps", {
    fields: {
      createdAt: stamped(),
      updatedAt: stamped(),
    },
    touch: ["updatedAt"],
    sealed: ["createdAt", "updatedAt"],
  });
}

function stamped() {
  return timestamptz().defaultSql("now()").guarded();
}

/**
 * Remembers which trait added a column, so the catalog can record it.
 *
 * @param fields - Columns the trait adds
 * @param name - Trait name
 */
function markFields(fields: Readonly<Record<string, object>>, name: string): void {
  for (const field of Object.keys(fields)) {
    const builder = fields[field];
    if (typeof builder === "object" && builder !== null) Object.assign(builder, { trait: name });
  }
}

/**
 * A touched column is sealed. The write path reads this list lazily.
 *
 * @param sealed - Columns input cannot set
 * @param touch - Columns set to `now()` on update
 * @returns Both lists, or `undefined` when the trait seals nothing
 */
function sealTouch(
  sealed: readonly string[] | undefined,
  touch: readonly string[] | undefined,
): readonly string[] | undefined {
  if (touch === undefined) return sealed;
  if (sealed === undefined) return touch;
  const names = [...sealed];
  for (const field of touch) if (!names.includes(field)) names.push(field);
  return names;
}

/**
 * Copies one trait's columns onto a table.
 *
 * @param name - Trait name, for OKM1012
 * @param fields - Columns this trait adds
 * @param model - Columns collected so far, including the table's own
 * @param ctx - Table name
 */
function addFields(
  name: string,
  fields: Readonly<Record<string, object>>,
  model: TraitModel,
  ctx: TraitContext,
): void {
  for (const field of Object.keys(fields)) {
    const builder = fields[field];
    if (builder === undefined) continue;
    if (Object.hasOwn(model.columns, field)) {
      const previous = (model.columns[field] as { readonly trait?: unknown }).trait;
      const which =
        typeof previous === "string"
          ? `trait ${previous} already adds it`
          : `${ctx.table} already declares it`;
      throw new OkmError("OKM1012", `Trait ${name} adds ${ctx.table}.${field}, and ${which}.`, {
        fix: { summary: "Rename the table field or drop one of the traits." },
      });
    }
    model.columns[field] = builder;
  }
}
