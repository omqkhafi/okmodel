/**
 * Column and codec failures from spec section 21 (D130).
 *
 * OKM1060 is an invalid column definition. OKM1061 is a reserved option this
 * version does not implement. OKM1210 is a value a codec rejects.
 * Messages name the accepted values.
 */

import { OkmError } from "../../contracts/error.js";

/** Invalid length, precision, scale, rank, qualifier, or value list. */
export const COLUMN_DEFINITION_CODE = "OKM1060";

/** A table or schema option reserved for a later prompt. */
export const RESERVED_OPTION_CODE = "OKM1061";

/** A codec rejected a value. */
export const CODEC_VALUE_CODE = "OKM1210";

/**
 * Throws OKM1060.
 *
 * @param message - What is wrong with the column definition, including accepted values
 */
export function definition(message: string): never {
  throw new OkmError(COLUMN_DEFINITION_CODE, message);
}

type IndexMarked = {
  readonly name: string;
  readonly columns: Readonly<Record<string, unknown>>;
  readonly options?: {
    readonly tenantIndexes?: unknown;
    readonly indexes?: (columns: Readonly<Record<string, { readonly name: string }>>) => readonly {
      readonly tenantGlobal?: string;
      readonly tenantScoped?: boolean;
    }[];
  };
};

/**
 * Refuses `tenantIndexes` on a global table.
 *
 * The rewrite returns before that flag is read, so a silent option would
 * look like it applied.
 *
 * @param item - The global table
 */
export function refuseGlobalTenantIndexes(item: IndexMarked): void {
  if (item.options?.tenantIndexes !== undefined) {
    definition(`Table ${item.name} sets tenantIndexes, and the table is global.`);
  }
}

/**
 * Refuses tenant index marks when the schema has no tenancy.
 *
 * `tenantIndexes`, `index().global()`, and `index().scoped()` do nothing
 * there. The callback is read with the table's own fields so only the marks
 * are inspected.
 *
 * @param item - One table in a schema that set no tenancy
 */
export function refuseTenancyIndexMarks(item: IndexMarked): void {
  if (item.options?.tenantIndexes !== undefined) {
    definition(`Table ${item.name} sets tenantIndexes, and the schema has no tenancy.`);
  }
  const build = item.options?.indexes;
  if (typeof build !== "function") return;
  const handles: Record<string, { readonly name: string }> = {};
  for (const field of Object.keys(item.columns)) handles[field] = { name: field };
  const calls = build(handles);
  if (!Array.isArray(calls)) return;
  for (const call of calls) {
    if (call?.tenantGlobal !== undefined) {
      definition(`Table ${item.name} index().global() needs tenancy. The schema has none.`);
    }
    if (call?.tenantScoped === true) {
      definition(`Table ${item.name} index().scoped() needs tenancy. The schema has none.`);
    }
  }
}

/**
 * Throws OKM1061.
 *
 * @param message - Which option is reserved, and the prompt or milestone that adds it
 */
export function unavailable(message: string): never {
  throw new OkmError(RESERVED_OPTION_CODE, message);
}

/**
 * Throws OKM1210.
 *
 * @param message - What the codec refused, including accepted values
 */
export function rejected(message: string): never {
  throw new OkmError(CODEC_VALUE_CODE, message);
}
