/**
 * The `citext` extension.
 *
 * Case-insensitive equality is the column's ordinary `eq` once the type is
 * `citext`. This module declares the extension so that column can build.
 */

import { extension, type Extension, type ExtensionOptions } from "./index.js";

/**
 * Declares `citext`.
 *
 * @param options - Schema and version pin. The version differs by Postgres major, so the default is unpinned.
 * @returns The extension object
 */
export function citext(options: ExtensionOptions = {}): Extension {
  return extension("citext", options);
}
