/**
 * Public entry for the `okmodel` package.
 *
 * The query API arrives in later prompts. Hashing is here so later layers
 * do not depend on a host crypto API.
 */

export { sha256 } from "./sha256.js";
