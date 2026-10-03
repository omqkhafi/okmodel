/**
 * Enum catalog objects.
 *
 * Kind `type`, identity `(namespace, name)`. The definition is the ordered
 * label list and nothing else: domains are not catalog objects.
 */

import { catalogError } from "../error.js";
import { assertIdentifier, assertStoredText } from "./identifier.js";
import { assertNamespace } from "./identity.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  Namespace,
  NamespaceIdentity,
  ObjectIdentity,
  Owner,
  Provenance,
  TypeObject,
} from "./types.js";

/** Input for {@link enumType}. */
export type EnumTypeInput = {
  readonly namespace: Namespace;
  readonly name: string;
  /** Labels in stored order. The order is part of the catalog hash. */
  readonly labels: readonly string[];
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

/**
 * Builds an enum type object.
 *
 * Labels are copied in the order given. An empty list, an empty label, or a
 * repeated label is OKM1020.
 *
 * @param input - Namespace, name, and ordered labels
 * @returns A type envelope
 */
export function enumType(input: EnumTypeInput): TypeObject {
  assertNamespace(input.namespace);
  assertIdentifier(input.name, "type");
  assertProvenance(input.provenance);
  if (input.labels.length === 0) {
    catalogError("OKM1020", `Enum ${input.name} must list at least one label.`);
  }
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const label of input.labels) {
    assertStoredText(label, "enum label");
    if (label.length === 0) {
      catalogError("OKM1020", `Enum ${input.name} has an empty label.`);
    }
    if (seen.has(label)) {
      catalogError("OKM1020", `Enum ${input.name} repeats label ${label}.`);
    }
    seen.add(label);
    labels.push(label);
  }
  const identity: NamespaceIdentity & { readonly kind: "type" } = {
    kind: "type",
    namespace: input.namespace,
    name: input.name,
  };
  return {
    kind: "type",
    identity,
    owner: input.owner ?? "managed",
    definition: { labels },
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
}

/**
 * Reports whether two label lists are the same text in the same order.
 *
 * @param left - First list
 * @param right - Second list
 * @returns `true` when every position matches
 */
export function sameEnumLabels(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
