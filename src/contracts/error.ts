/**
 * Errors raised by the contracts layer.
 *
 * The full error surface (categories, `fix`, HTTP mapping) arrives later.
 * This class is the `OkmError` the spec names, and it already carries an
 * `OKM1xxx` code.
 */

/**
 * Catalog failures that have a code in spec section 21 or D128.
 *
 * OKM1020 stays the code for an unknown table and for catalog failures that
 * still have no narrower code. A dependency cycle is OKM1026. A document this
 * version cannot read is OKM1027.
 */
export const CATALOG_CODES = [
  "OKM1020",
  "OKM1021",
  "OKM1022",
  "OKM1023",
  "OKM1026",
  "OKM1027",
  "OKM1122",
] as const;

/**
 * A catalog error code.
 */
export type CatalogCode = (typeof CATALOG_CODES)[number];

/**
 * Column definition, reserved options, and codec failures (D130, D132).
 *
 * OKM1060 is an invalid column definition. OKM1061 is a table or schema option
 * the types accept but this version does not implement. OKM1210 is a value a
 * codec rejects.
 */
export const COLUMN_CODES = ["OKM1060", "OKM1061", "OKM1210"] as const;

/**
 * A column or codec error code.
 */
export type ColumnCode = (typeof COLUMN_CODES)[number];

/**
 * One OKModel error.
 *
 * Catalog construction, naming, ordering, and parsing throw this class.
 */
export class OkmError extends Error {
  /**
   * Spec code, for example `OKM1023`.
   */
  readonly code: string;

  /**
   * @param code - Spec code
   * @param message - What failed
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "OkmError";
    this.code = code;
  }
}

/**
 * Throws an {@link OkmError} for a catalog failure.
 *
 * @param code - Spec code
 * @param message - What failed
 */
export function catalogError(code: CatalogCode, message: string): never {
  throw new OkmError(code, message);
}
