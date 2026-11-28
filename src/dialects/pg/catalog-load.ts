/**
 * Loads the catalog compiler when `.catalog` is first read.
 *
 * `import()` is async and a literal `require()` is inlined into the app bundle.
 * `catalog-require.js` calls `createRequire` on that read, so a featureless app never
 * parses the compiler and a consumer typecheck does not import `node:module`. The
 * compiler is also emitted beside `dist/dialects/pg`. A shared chunk looks one
 * directory up. Cloudflare Workers have no `import.meta.url`; `okmodel/pg`'s
 * `workerd` export installs the compilers before `schema()` runs.
 */

import { OkmError } from "../../contracts/error.js";
import type { ExclusionElement } from "../../contracts/catalog/types.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import type { CatalogCompileInput } from "./catalog-draft.js";
import { requireSibling } from "./catalog-require.js";

/** Specifiers tried in order. The first that exists wins. */
const COMPILER = ["./catalog-compile.js", "../dialects/pg/catalog-compile.js"] as const;

/** Same layout for the exclusion checker, which runs at `schema()` only when a table sets it. */
const EXCLUSION = ["./exclusion.js", "../dialects/pg/exclusion.js"] as const;

/** Installed by the Workers entry. Node leaves this empty and loads on demand. */
let installedCompiler: ((input: CatalogCompileInput) => Catalog) | undefined;

/** Installed by the Workers entry. Node leaves this empty and loads on demand. */
let installedExclusion: CompileExclusion | undefined;

/**
 * Installs `compileCatalog` for a runtime that cannot `createRequire`.
 *
 * A later call replaces it. Node does not call this.
 *
 * @param compiler - Function the first `.catalog` read runs
 */
export function installCatalogCompiler(compiler: (input: CatalogCompileInput) => Catalog): void {
  installedCompiler = compiler;
}

/**
 * Installs `compileExclusion` for a runtime that cannot `createRequire`.
 *
 * A later call replaces it. `schema()` calls it only when a table sets `exclusions`.
 *
 * @param compiler - Checker `schema()` runs while it is still building the query model
 */
export function installCompileExclusion(compiler: CompileExclusion): void {
  installedExclusion = compiler;
}

/**
 * One exclusion, as `schema()` calls it.
 *
 * The parameter is structural so this file does not import `exclusion.ts`.
 */
export type CompileExclusion = (
  table: string,
  key: string,
  spec: {
    readonly on: readonly (readonly [unknown, "eq" | "overlaps" | "adjacent"])[];
    readonly where?: unknown;
    readonly deferrable?: "deferred" | "immediate";
    readonly comment?: string;
  },
  columns: ReadonlyMap<string, { readonly sql: string; readonly dataType: string }>,
  tenantKeys: readonly string[],
  path: boolean,
) => {
  readonly elements: readonly ExclusionElement[];
  readonly expression?: string;
  readonly gist: boolean;
};

/**
 * Loads `compileCatalog`.
 *
 * @returns The compiler for one schema's stored descriptors
 */
export function loadCatalogCompiler(): (input: CatalogCompileInput) => Catalog {
  if (installedCompiler !== undefined) return installedCompiler;
  const loaded = requireSibling(COMPILER) as {
    compileCatalog?: (input: CatalogCompileInput) => Catalog;
  };
  if (typeof loaded.compileCatalog !== "function") missing(COMPILER[0]);
  return loaded.compileCatalog;
}

/**
 * Loads `compileExclusion` for a table that declared exclusions.
 *
 * A schema with no exclusions does not call this, so that module stays off the featureless graph.
 *
 * @returns The checker `schema()` runs while it is still building the query model
 */
export function loadCompileExclusion(): CompileExclusion {
  if (installedExclusion !== undefined) return installedExclusion;
  const loaded = requireSibling(EXCLUSION) as { compileExclusion?: CompileExclusion };
  if (typeof loaded.compileExclusion !== "function") missing(EXCLUSION[0]);
  return loaded.compileExclusion;
}

function missing(specifier: string): never {
  throw new OkmError("OKM1020", `Catalog compiler ${specifier} is not in this build.`, {
    fix: { summary: "Use the published okmodel build, which emits the compiler next to schema()." },
  });
}
