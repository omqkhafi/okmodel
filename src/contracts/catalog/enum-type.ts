/**
 * Constructors for enum and domain catalog objects.
 *
 * These live apart from `sameEnumLabels`. `schema()` loads that check at
 * startup. A bundler that also compiles the catalog would otherwise place
 * this file's dependencies in the startup chunk (D365).
 */

import { catalogError } from "../error.js";
import { assertIdentifier, assertStoredText } from "./identifier.js";
import { assertNamespace } from "./identity.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  DomainDefinition,
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
  /** Absent means the comment is not managed. */
  readonly comment?: string;
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
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };
}

/** Input for {@link domainType}. */
export type DomainTypeInput = {
  readonly namespace: Namespace;
  readonly name: string;
  readonly base: string;
  readonly check: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
  /** Absent means the comment is not managed. */
  readonly comment?: string;
};

/**
 * Builds a domain type object.
 *
 * The definition is the base type and the check. An empty base or an empty
 * check is OKM1020.
 *
 * @param input - Namespace, name, base type, and check
 * @returns A type envelope
 */
export function domainType(input: DomainTypeInput): TypeObject {
  assertNamespace(input.namespace);
  assertIdentifier(input.name, "type");
  assertProvenance(input.provenance);
  if (input.base.length === 0) {
    catalogError("OKM1020", `Domain ${input.name} needs a base type.`);
  }
  assertStoredText(input.check, "domain check");
  if (input.check.length === 0) {
    catalogError("OKM1020", `Domain ${input.name} needs a check.`);
  }
  const identity: NamespaceIdentity & { readonly kind: "type" } = {
    kind: "type",
    namespace: input.namespace,
    name: input.name,
  };
  const definition: DomainDefinition = { base: input.base, check: input.check };
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
