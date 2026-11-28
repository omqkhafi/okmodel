/**
 * `createRequire` for the catalog compiler.
 *
 * This file is JavaScript so the import of `node:module` stays out of the
 * type graph. A consumer typecheck with `types: []` follows `schema()` and
 * must not need Node types. A literal `require()` in TypeScript is inlined
 * into the app bundle; `createRequire` is not.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Loads the first specifier that exists.
 *
 * @param {readonly string[]} specifiers - Paths tried in order, relative to this file
 * @returns {object} The loaded module
 */
export function requireSibling(specifiers) {
  /** @type {unknown} */
  let last;
  for (const specifier of specifiers) {
    try {
      return require(specifier);
    } catch (error) {
      if (!isMissing(error)) throw error;
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
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
