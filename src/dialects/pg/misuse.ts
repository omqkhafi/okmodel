/**
 * Column and codec failures from spec section 21 (D130).
 *
 * OKM1060 is an invalid column definition. OKM1061 is a reserved option this
 * version does not implement. OKM1210 is a value a codec rejects.
 * Messages name the accepted values.
 */

import { OkmError } from "../../contracts/error.js";

/** Invalid length, precision, scale, rank, qualifier, or value list. */
const COLUMN_DEFINITION_CODE = "OKM1060";

/** A table or schema option reserved for a later prompt. */
const RESERVED_OPTION_CODE = "OKM1061";

/** A codec rejected a value. */
const CODEC_VALUE_CODE = "OKM1210";

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
  readonly options?: { readonly tenantIndexes?: unknown };
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
