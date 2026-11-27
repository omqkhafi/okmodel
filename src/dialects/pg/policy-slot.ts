/**
 * Slot the policy compiler fills.
 *
 * `schema()` reads it. The featureless app does not import the compiler.
 * `sessionSettings()` and `okm` install it before the catalog is read.
 */

import type { CatalogObject, Namespace, Provenance } from "../../contracts/catalog/types.js";
import type { AnyTable } from "./table.js";

/** One column the compiler can name. */
export type PolicyColumnRef = {
  readonly sql: string;
  readonly dataType: string;
};

/** One table the compiler can see. The key is the TypeScript table name. */
export type PolicyTableView = {
  readonly sqlName: string;
  readonly parent: { readonly namespace: Namespace; readonly name: string };
  readonly provenance: Provenance;
  readonly column: (field: string) => PolicyColumnRef | undefined;
};

/** Compiles `policies` and `rls` into catalog objects. */
export type PolicyCompiler = (
  tables: readonly AnyTable[],
  view: (tsName: string) => PolicyTableView | undefined,
  objects: CatalogObject[],
) => void;

let slot: PolicyCompiler | undefined;

/**
 * Installs the compiler. A later call replaces it.
 *
 * @param compiler - Function `schema()` runs when a table sets `policies` or `rls`
 */
export function installPolicyCompiler(compiler: PolicyCompiler): void {
  slot = compiler;
}

/**
 * The installed compiler.
 *
 * @returns The compiler, or `undefined` when nothing installed it
 */
export function readPolicyCompiler(): PolicyCompiler | undefined {
  return slot;
}
