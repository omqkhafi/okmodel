/**
 * `createRequire` for the catalog compiler.
 *
 * This file is JavaScript so the import of `node:module` stays out of the
 * type graph. A consumer typecheck with `types: []` follows `schema()` and
 * must not need Node types. A literal `require()` in TypeScript is inlined
 * into the app bundle; `createRequire` is not. The call is inside
 * `requireSibling`, because a Workers bundle evaluates this module and
 * `import.meta.url` is unset there.
 */

import { createRequire } from "node:module";

/** @type {((specifier: string) => object) | undefined} */
let require;

/**
 * Loads the first specifier that exists.
 *
 * `createRequire` runs here, not at module evaluation. A Workers bundle leaves
 * `import.meta.url` unset, and calling it at import time crashes the isolate
 * before a query. The Workers entry installs the compilers and does not call this.
 *
 * @param {readonly string[]} specifiers - Paths tried in order, relative to this file
 * @returns {object} The loaded module
 */
export function requireSibling(specifiers) {
  const load = siblingRequire();
  /** @type {unknown} */
  let last;
  for (const specifier of specifiers) {
    try {
      return load(specifier);
    } catch (error) {
      if (!isMissing(error)) throw error;
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * @returns {(specifier: string) => object}
 */
function siblingRequire() {
  if (require !== undefined) return require;
  const url = import.meta.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      "Catalog compiler cannot load: import.meta.url is unset. Queries do not need it.",
    );
  }
  require = createRequire(url);
  return require;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissing(error) {
  if (typeof error !== "object" || error === null) return false;
  const code = /** @type {{ code?: unknown }} */ (error).code;
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("Cannot find module") || message.includes("Cannot find package");
}
