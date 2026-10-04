/**
 * Preset types and the names a preset may not take (spec section 6.2, D41, D125).
 *
 * A preset is a named, typed refinement of a table: `tasks.pending()`. It gets
 * a builder with one additive method, `where`, and returns that builder. The
 * builder has no method that removes or replaces a predicate, so a preset can
 * only narrow what the caller, tenancy, and the active set already allow.
 *
 * Only types and one list live here. The code that runs presets loads on the
 * first call (`runtime/presets.ts`).
 */

import { OkmError } from "../../contracts/error.js";
import type { Or } from "./operators.js";
import type { FieldWhere } from "./where.js";

/**
 * What a preset receives.
 *
 * Every method adds. There is no method that removes or replaces a predicate
 * (D125, D126), and the tenant and active-set predicates are not in the
 * builder at all: the planner puts them around it.
 *
 * @typeParam Row - The table's row
 */
export type PresetQuery<Row> = {
  /**
   * Adds a predicate, joined with the others by AND.
   *
   * Earlier predicates stay, whether the caller's, another preset's, or this
   * preset's own.
   *
   * @param filter - Fields and operators, or `or(...)`
   * @returns The same builder
   */
  where(filter: FieldWhere<Row> | Or<FieldWhere<Row>>): PresetQuery<Row>;
};

/**
 * One preset: the builder first, then the preset's own typed arguments.
 *
 * @typeParam Row - The table's row
 */
export type Preset<Row> = (q: PresetQuery<Row>, ...args: never[]) => PresetQuery<Row>;

/**
 * Names a preset may not take (OKM1040).
 *
 * The first group are client methods. The second is reserved for later
 * releases. `then` would make a table handle look like a promise.
 */
export type ReservedPreset =
  | "find"
  | "one"
  | "page"
  | "aggregate"
  | "count"
  | "exists"
  | "insert"
  | "update"
  | "delete"
  | "archive"
  | "restore"
  | "withArchived"
  | "onlyArchived"
  | "then"
  | "lock"
  | "watch"
  | "subscribe"
  | "stream"
  | "inspect"
  | "explain"
  | "with"
  | "for"
  | "as";

/**
 * The `presets` option. A reserved name is a type error here, and OKM1040 when
 * the schema is used.
 *
 * @typeParam Row - The table's row
 */
export type PresetMap<Row> = {
  readonly [name: string]: Preset<Row>;
} & {
  readonly [N in ReservedPreset]?: never;
};

/** Names {@link ReservedPreset} lists, for the runtime check. */
export const RESERVED_PRESETS: ReadonlySet<string> = new Set<ReservedPreset>([
  "find",
  "one",
  "page",
  "aggregate",
  "count",
  "exists",
  "insert",
  "update",
  "delete",
  "archive",
  "restore",
  "withArchived",
  "onlyArchived",
  "then",
  "lock",
  "watch",
  "subscribe",
  "stream",
  "inspect",
  "explain",
  "with",
  "for",
  "as",
]);

/**
 * Throws OKM1040 when a preset name is a client method or reserved.
 *
 * @param names - Preset names from one table or one trait
 * @param where - What defines them, for the message: `table tasks` or `trait softDelete`
 */
export function checkPresetNames(names: Iterable<string>, where: string): void {
  for (const name of names) {
    if (!RESERVED_PRESETS.has(name)) continue;
    throw new OkmError(
      "OKM1040",
      `Preset ${name} on ${where} is a client method or a reserved name. Reserved: ${[...RESERVED_PRESETS].join(", ")}.`,
      { fix: { summary: `Rename the preset ${name}.` } },
    );
  }
}

/**
 * Throws OKM1040 for a preset name defined by two sources.
 *
 * @param name - The preset name
 * @param table - Table that ends up with both
 * @param first - What defined it first: `table tasks` or `trait softDelete`
 * @param second - What defines it again
 */
export function duplicatePreset(name: string, table: string, first: string, second: string): never {
  throw new OkmError(
    "OKM1040",
    `Preset ${name} on ${table} is defined by ${first} and by ${second}.`,
    { fix: { summary: `Rename the preset in ${first} or in ${second}, or drop one of them.` } },
  );
}
