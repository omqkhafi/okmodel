/**
 * Structural equality for two catalogs.
 *
 * Introspection stamps the same provenance on every object, so the canonical
 * document is the comparison. Authoring text is not compared to a reprint.
 */

import { serializeCatalog } from "../../contracts/catalog/document.js";
import type { Catalog } from "../../contracts/catalog/types.js";

/**
 * Reports whether two catalogs serialise to the same bytes.
 *
 * @param left - First catalog
 * @param right - Second catalog
 * @returns `true` when the canonical documents match
 */
export function catalogsEqual(left: Catalog, right: Catalog): boolean {
  return serializeCatalog(left) === serializeCatalog(right);
}
