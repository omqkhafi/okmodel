/**
 * Composite catalog types.
 *
 * Kind `type`, identity `(namespace, name)`. The definition is the field list
 * in catalog order. Field order is part of the stored document. The planner
 * compares fields by name.
 */

import { catalogError } from "../error.js";
import { assertIdentifier, assertStoredText } from "./identifier.js";
import { assertNamespace } from "./identity.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  CompositeDefinition,
  CompositeFieldDefinition,
  Namespace,
  NamespaceIdentity,
  ObjectIdentity,
  Owner,
  Provenance,
  TypeDefinition,
  TypeObject,
} from "./types.js";

/** Input for {@link compositeType}. */
export type CompositeTypeInput = {
  readonly namespace: Namespace;
  readonly name: string;
  readonly fields: readonly CompositeFieldDefinition[];
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
  /** Absent means the comment is not managed. */
  readonly comment?: string;
};

/**
 * Builds a composite type object.
 *
 * Fields are copied in the order given. An empty field list is OKM1020.
 *
 * @param input - Namespace, name, and fields in catalog order
 * @returns A type envelope
 */
export function compositeType(input: CompositeTypeInput): TypeObject {
  assertNamespace(input.namespace);
  assertIdentifier(input.name, "type");
  assertProvenance(input.provenance);
  if (input.fields.length === 0) {
    catalogError("OKM1020", `Composite ${input.name} needs a field.`);
  }
  const fields: CompositeFieldDefinition[] = [];
  const seen = new Set<string>();
  for (const field of input.fields) {
    assertIdentifier(field.name, "composite field");
    if (seen.has(field.name)) {
      catalogError("OKM1020", `Composite ${input.name} repeats field ${field.name}.`);
    }
    seen.add(field.name);
    if (field.dataType.length === 0) {
      catalogError("OKM1020", `Composite ${input.name}.${field.name} needs a type.`);
    }
    if (field.comment !== undefined) assertStoredText(field.comment, "composite field comment");
    fields.push({
      name: field.name,
      dataType: field.dataType,
      nullable: field.nullable,
      ...(field.comment !== undefined ? { comment: field.comment } : {}),
    });
  }
  const identity: NamespaceIdentity & { readonly kind: "type" } = {
    kind: "type",
    namespace: input.namespace,
    name: input.name,
  };
  const definition: CompositeDefinition = { fields };
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
 * Reports whether a type definition is a composite.
 *
 * @param definition - Enum, domain, or composite
 * @returns `true` when the definition has fields
 */
export function isComposite(definition: TypeDefinition): definition is CompositeDefinition {
  return "fields" in definition;
}
