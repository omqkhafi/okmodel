/**
 * Range catalog types.
 *
 * Kind `type`, identity `(namespace, name)`. The definition is the subtype,
 * the optional diff and collation, and the multirange name created with it.
 */

import { catalogError } from "../error.js";
import { assertIdentifier } from "./identifier.js";
import { assertNamespace } from "./identity.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  Namespace,
  NamespaceIdentity,
  ObjectIdentity,
  Owner,
  Provenance,
  RangeDefinition,
  TypeDefinition,
  TypeObject,
} from "./types.js";

/** Input for {@link rangeType}. */
export type RangeTypeInput = {
  readonly namespace: Namespace;
  readonly name: string;
  readonly subtype: string;
  readonly subtypeDiff?: string;
  readonly collation?: string;
  readonly multirange: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
  /** Absent means the comment is not managed. */
  readonly comment?: string;
};

/**
 * Builds a range type object.
 *
 * @param input - Namespace, name, subtype, and multirange name
 * @returns A type envelope
 */
export function rangeType(input: RangeTypeInput): TypeObject {
  assertNamespace(input.namespace);
  assertIdentifier(input.name, "type");
  assertIdentifier(input.multirange, "multirange");
  assertProvenance(input.provenance);
  if (input.subtype.length === 0) {
    catalogError("OKM1020", `Range ${input.name} needs a subtype.`);
  }
  if (input.subtypeDiff !== undefined && input.subtypeDiff.length === 0) {
    catalogError("OKM1020", `Range ${input.name} has an empty subtype diff.`);
  }
  if (input.collation !== undefined) assertIdentifier(input.collation, "range collation");
  const identity: NamespaceIdentity & { readonly kind: "type" } = {
    kind: "type",
    namespace: input.namespace,
    name: input.name,
  };
  const definition: RangeDefinition = {
    subtype: input.subtype,
    multirange: input.multirange,
    ...(input.subtypeDiff !== undefined ? { subtypeDiff: input.subtypeDiff } : {}),
    ...(input.collation !== undefined ? { collation: input.collation } : {}),
  };
  return {
    kind: "type",
    identity,
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };
}

/**
 * Reports whether a type definition is a range.
 *
 * @param definition - Type definition
 * @returns `true` when the definition stores a subtype
 */
export function isRange(definition: TypeDefinition): definition is RangeDefinition {
  return "subtype" in definition;
}
