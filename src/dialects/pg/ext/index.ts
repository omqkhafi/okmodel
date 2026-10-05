/**
 * `okmodel/ext`.
 *
 * `extension()` returns an object that produces its own catalog record.
 * Duplicate and undeclared-use checks run here. Core only asks each declared
 * object for its records.
 */

import { OkmError } from "../../../contracts/error.js";
import { extensionObject } from "../../../contracts/catalog/extension.js";
import type { ExtensionObject } from "../../../contracts/catalog/types.js";

/** Options on {@link extension}. */
export type ExtensionOptions = {
  /** Exact pin (`1.6`) or a floor (`>=0.7`). Omitted means unpinned. */
  readonly version?: string;
  /** Install schema. The default is `public`. */
  readonly schema?: string;
  /**
   * Whether the extension may move.
   *
   * The default is `true`. A move of a non-relocatable extension is OKM1814.
   */
  readonly relocatable?: boolean;
};

/**
 * One declared extension.
 *
 * Methods on a built-in, such as `pgTrgm.similar`, are the typed API. They
 * are not stored in the catalog record.
 */
export type Extension = {
  readonly name: string;
  readonly schema: string;
  readonly relocatable: boolean;
  readonly version?: string;
  /**
   * Catalog records for this declaration.
   *
   * @param peers - The `schema({ extensions })` list
   * @param built - Objects the schema has already staged
   * @returns The extension record
   */
  contribute(peers: unknown, built: unknown): readonly ExtensionObject[];
};

/**
 * Declares an extension by name.
 *
 * A bare declaration has the full lifecycle and no typed operators. Built-ins
 * wrap this and add their own methods.
 *
 * @param name - Extension name, such as `citext` or `vector`
 * @param options - Schema, version pin, and whether it may move
 * @returns The definition object `schema({ extensions })` stores
 */
export function extension(name: string, options: ExtensionOptions = {}): Extension {
  const schema = options.schema ?? "public";
  const relocatable = options.relocatable ?? true;
  const version = options.version;
  const record = extensionObject({
    name,
    schema,
    relocatable,
    ...(version !== undefined ? { version } : {}),
    provenance: { origin: "extension", name },
  });
  return {
    name,
    schema,
    relocatable,
    ...(version !== undefined ? { version } : {}),
    contribute(peers, built) {
      const names = peerNames(peers);
      assertDeclared(names, built);
      return [record];
    },
  };
}

function peerNames(peers: unknown): ReadonlyMap<string, number> {
  if (!Array.isArray(peers)) {
    extensionError("OKM1810", "schema({ extensions }) must be a list of extensions.");
  }
  const counts = new Map<string, number>();
  for (const peer of peers) {
    if (!isPeer(peer)) {
      extensionError("OKM1810", "schema({ extensions }) must be a list of extensions.");
    }
    counts.set(peer.name, (counts.get(peer.name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) extensionError("OKM1813", `Extension ${name} is defined twice.`);
  }
  return counts;
}

function assertDeclared(names: ReadonlyMap<string, number>, built: unknown): void {
  if (!Array.isArray(built)) return;
  for (const object of built) {
    if (typeof object !== "object" || object === null || !("dependencies" in object)) continue;
    const dependencies = object.dependencies;
    if (!Array.isArray(dependencies)) continue;
    for (const edge of dependencies) {
      if (typeof edge !== "object" || edge === null || !("target" in edge)) continue;
      const target = edge.target;
      if (typeof target !== "object" || target === null) continue;
      if (!("kind" in target) || !("name" in target)) continue;
      if (
        target.kind === "extension" &&
        typeof target.name === "string" &&
        !names.has(target.name)
      ) {
        extensionError("OKM1810", `Extension ${target.name} is used but not declared.`);
      }
    }
  }
}

function isPeer(value: unknown): value is { readonly name: string } {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || !("contribute" in value)) return false;
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.contribute === "function"
  );
}

function extensionError(code: "OKM1810" | "OKM1813", message: string): never {
  const summary =
    code === "OKM1813"
      ? "Keep one definition. A second copy fails at build."
      : "Declare the extension next to the schema that uses it.";
  throw new OkmError(code, message, { fix: { summary } });
}
