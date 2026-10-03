/**
 * OKID as a client generator.
 *
 * Calling {@link okid} does not mint an id. It returns a function that mints
 * one id per call, so `.default(okid({ prefix }))` fills each inserted row.
 * The vendored {@link mintOkid} is what that function calls.
 */

import {
  clientGenerator,
  type ClientGenerator,
  type GeneratorOptions,
} from "../../contracts/generator.js";
import { okid as mintOkid, type OkidOptions } from "./okid.js";

export type { OkidOptions } from "./okid.js";

/**
 * Binds OKID options into a client generator.
 *
 * `okid()` and `okid(length)` use the default alphabet. `okid({ prefix,
 * sortable, length })` keeps those options for every row. Sortable ids embed
 * the creation time. An OKID column is `text` with collation `C`.
 *
 * @param options - Body length, or prefix, sortable, and alphabet toggles
 * @returns A generator. Call it to mint one id
 */
export function okid(options?: number | OkidOptions): ClientGenerator<string> {
  const stored = optionsRecord(options);
  return clientGenerator(
    () => (options === undefined ? mintOkid() : mintOkid(options)),
    "okid",
    stored,
  );
}

function optionsRecord(options: number | OkidOptions | undefined): GeneratorOptions | undefined {
  if (options === undefined) return undefined;
  if (typeof options === "number") return { length: options };
  const stored: Record<string, string | number | boolean> = {};
  if (options.length !== undefined) stored.length = options.length;
  if (options.prefix !== undefined) stored.prefix = options.prefix;
  if (options.sortable !== undefined) stored.sortable = options.sortable;
  if (options.lowercase !== undefined) stored.lowercase = options.lowercase;
  if (options.uppercase !== undefined) stored.uppercase = options.uppercase;
  if (options.numbers !== undefined) stored.numbers = options.numbers;
  if (options.symbols !== undefined) stored.symbols = options.symbols;
  if (options.lookAlikes !== undefined) stored.lookAlikes = options.lookAlikes;
  return stored;
}
