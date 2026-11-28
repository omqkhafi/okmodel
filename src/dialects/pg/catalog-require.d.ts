/**
 * Loads the first sibling that exists.
 *
 * The implementation is JavaScript so `node:module` stays out of the type graph.
 *
 * @param specifiers - Paths tried in order, relative to this file
 * @returns The loaded module
 */
export function requireSibling(specifiers: readonly string[]): object;
