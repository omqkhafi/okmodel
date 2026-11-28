/**
 * Installs the catalog compilers for a bundle that has no sibling file.
 *
 * `schema().catalog` otherwise loads `catalog-compile.js` with `createRequire`.
 * A single-file bundle has nowhere to look. Call {@link armCatalog} before
 * that read. A featureless app does not import this file, so the compilers
 * stay off its startup graph. `sideEffects` is false: the call is what keeps it.
 */

import type { Catalog } from "../../contracts/catalog/types.js";
import { compileCatalog } from "./catalog-compile.js";
import type { CatalogCompileInput } from "./catalog-draft.js";
import {
  installCatalogCompiler,
  installCompileExclusion,
  type CompileExclusion,
} from "./catalog-load.js";
import { compileExclusion } from "./exclusion.js";

/**
 * Installs `compileCatalog` and `compileExclusion` for this process.
 *
 * A later call replaces them. Node's normal entry does not call this.
 */
export function armCatalog(): void {
  installCatalogCompiler(compileCatalog as (input: CatalogCompileInput) => Catalog);
  installCompileExclusion(compileExclusion as CompileExclusion);
}
