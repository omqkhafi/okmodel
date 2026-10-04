/**
 * The only static reference to the validation engine.
 *
 * A no-validation app does not import this module, so its total graph does
 * not include the engine chunk. A failed import rejects the call that asked
 * for it, and the same promise is reused so a later call fails the same way.
 */

let engine: Promise<typeof import("./engine.js")> | undefined;

/**
 * Loads the validation engine.
 *
 * @returns The engine module
 */
export function loadEngine(): Promise<typeof import("./engine.js")> {
  engine ??= import("./engine.js");
  return engine;
}
