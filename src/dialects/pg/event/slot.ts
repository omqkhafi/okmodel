/**
 * Slot the event-trigger compiler fills.
 *
 * `schema()` and `trigger({ event })` read it. The featureless app does not
 * import the compiler. Importing `okmodel/event` installs it.
 */

import type { CatalogObject } from "../../../contracts/catalog/types.js";

/** Options for `trigger()` when the trigger is an event trigger. */
export type EventTriggerOptions = {
  readonly event: string;
  readonly tags?: readonly string[];
  readonly calls: {
    readonly name: string;
    readonly schema: string;
    readonly argTypes: readonly string[];
  };
  readonly enabled?: true | false | "replica" | "always";
  readonly comment?: string;
};

/** One declaration `schema({ triggers })` can store. */
export type EventDeclaration = {
  readonly name: string;
  readonly event?: string;
  readonly rlsSchemas?: readonly string[];
  contribute(peers: unknown, built: unknown, names?: unknown): readonly CatalogObject[];
};

/** Compiles `trigger({ event })` and stamps `enableRls` defaults. */
export type EventCompiler = {
  declaration(name: string, options: EventTriggerOptions): EventDeclaration;
  stampRls(objects: CatalogObject[], schemas: readonly string[]): void;
};

let slot: EventCompiler | undefined;

/**
 * Installs the compiler. A later call replaces it.
 *
 * @param compiler - Function `trigger({ event })` and `schema()` run
 */
export function installEventCompiler(compiler: EventCompiler): void {
  slot = compiler;
}

/**
 * The installed compiler.
 *
 * @returns The compiler, or `undefined` when nothing installed it
 */
export function readEventCompiler(): EventCompiler | undefined {
  return slot;
}

/**
 * Schemas named by `enableRls` in a trigger list.
 *
 * The read does not load the compiler. An empty result means no preset asked.
 *
 * @param triggers - `schema({ triggers })`
 * @returns Schema names, or `undefined` when none are declared
 */
export function declaredRlsSchemas(triggers: unknown): readonly string[] | undefined {
  if (!Array.isArray(triggers)) return undefined;
  const found: string[] = [];
  for (const item of triggers) {
    if (typeof item !== "object" || item === null || !("rlsSchemas" in item)) continue;
    const value = (item as { readonly rlsSchemas?: unknown }).rlsSchemas;
    if (!Array.isArray(value)) continue;
    for (const name of value) {
      if (typeof name === "string" && name.length > 0) found.push(name);
    }
  }
  return found.length > 0 ? found : undefined;
}
