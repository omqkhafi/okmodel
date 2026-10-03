/**
 * Client id generators (`okmodel/ids`).
 *
 * Pass these to `.default()` or `schema({ defaults: { id } })`. A literal
 * passed to `.default()` stays a database default. These functions are not
 * part of the runtime entry, so an application that does not import them
 * does not ship them.
 */

export { uuidv4, uuidv7 } from "./uuid.js";
export { okid, type OkidOptions } from "./okid-generator.js";
export type { ClientGenerator, IdGenerators } from "../../contracts/generator.js";
