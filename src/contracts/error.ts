/**
 * Errors raised by the contracts layer.
 *
 * The full error surface (categories, `fix`, HTTP mapping) arrives later.
 * This class is the `OkmError` the spec names, and it already carries an
 * `OKM1xxx` code.
 */

/** Catalog failures that have a code in spec section 21. */
export const CATALOG_CODES = ["OKM1020", "OKM1021", "OKM1023", "OKM1122"] as const;

/**
 * A catalog error code.
 *
 * Draft 18 does not assign a code to a dependency cycle or to a catalog
 * document this version cannot read. Both are raised as OKM1020.
 */
export type CatalogCode = (typeof CATALOG_CODES)[number];

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
