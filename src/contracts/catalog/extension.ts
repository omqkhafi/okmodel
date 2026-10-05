/**
 * Extension catalog objects.
 *
 * The factory stores the record. It does not parse a document and it does
 * not plan SQL. Those stay in the document chunk and in tooling.
 */

import { catalogError } from "../error.js";
import { assertIdentifier } from "./identifier.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  Catalog,
  ExtensionDefinition,
  ExtensionObject,
  ObjectIdentity,
  Owner,
  Provenance,
} from "./types.js";

/** Input for {@link extensionObject}. */
export type ExtensionInput = {
  readonly name: string;
  readonly schema: string;
  readonly relocatable?: boolean;
  readonly version?: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

/**
 * Builds an extension record.
 *
 * @param input - Name, install schema, and optional version pin
 * @returns The catalog object
 */
export function extensionObject(input: ExtensionInput): ExtensionObject {
  assertIdentifier(input.name, "extension");
  assertIdentifier(input.schema, "extension schema");
  assertProvenance(input.provenance);
  assertVersion(input.version);
  const definition: ExtensionDefinition = {
    schema: input.schema,
    relocatable: input.relocatable ?? true,
    ...(input.version !== undefined ? { version: input.version } : {}),
  };
  return {
    kind: "extension",
    identity: { kind: "extension", name: input.name },
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
}

/**
 * Reports whether a version is an exact pin (`1.6`), not a floor or an omission.
 *
 * @param version - Declared or installed version
 * @returns `true` when every component is a decimal integer
 */
export function isExactVersion(version: string | undefined): version is string {
  return version !== undefined && /^\d+(?:\.\d+)*$/.test(version);
}

/**
 * Compares two exact versions. A shorter tail is zero.
 *
 * @param left - Exact version
 * @param right - Exact version
 * @returns Negative when `left` is older, positive when it is newer
 */
export function compareExtensionVersions(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Reports whether two extension records are the same migration.
 *
 * An unpinned or floor declaration matches any installed version. Schema and
 * `relocatable` still have to match.
 *
 * @param before - Previous record
 * @param after - Declared record
 * @returns `true` when no `ALTER EXTENSION` is required
 */
export function sameExtensionDefinition(before: ExtensionObject, after: ExtensionObject): boolean {
  if (before.definition.schema !== after.definition.schema) return false;
  if (before.definition.relocatable !== after.definition.relocatable) return false;
  return sameVersion(before.definition.version, after.definition.version);
}

/**
 * Drops a version when the other side of a diff does not pin an exact one.
 *
 * Serialization then compares the rest of the record. Exact pins on both
 * sides are left as written.
 *
 * @param source - Catalog being compared
 * @param other - The other catalog
 * @returns `source`, or a copy with those versions removed
 */
export function alignExtensionVersions(source: Catalog, other: Catalog): Catalog {
  const loose = looseNames(source, other);
  if (loose.size === 0) return source;
  let changed = false;
  const objects = source.objects.map((object) => {
    if (object.kind !== "extension" || object.definition.version === undefined) return object;
    if (!loose.has(object.identity.name)) return object;
    changed = true;
    const { version: _version, ...definition } = object.definition;
    return { ...object, definition };
  });
  return changed ? { version: source.version, objects } : source;
}

function sameVersion(before: string | undefined, after: string | undefined): boolean {
  if (!isExactVersion(after) || !isExactVersion(before)) return true;
  return before === after;
}

function looseNames(source: Catalog, other: Catalog): Set<string> {
  const names = new Set<string>();
  for (const catalog of [source, other]) {
    for (const object of catalog.objects) {
      if (object.kind !== "extension") continue;
      if (!isExactVersion(object.definition.version)) names.add(object.identity.name);
    }
  }
  return names;
}

function assertVersion(version: string | undefined): void {
  if (version === undefined) return;
  if (isExactVersion(version) || /^>=\d+(?:\.\d+)*$/.test(version)) return;
  catalogError(
    "OKM1020",
    `Extension version ${String(version)} must be a dotted version or a >= floor.`,
  );
}

function parts(version: string): number[] {
  return version.split(".").map((part) => Number(part));
}
