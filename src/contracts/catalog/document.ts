/**
 * Catalog documents.
 *
 * `catalog` checks identity, foreign keys, and cycles, then stores objects in
 * identity-key order. The serialized form is the canonical JSON of that
 * document, templates included. The hash is SHA-256 of those bytes.
 */

import { catalogError } from "../error.js";
import { sha256 } from "../sha256.js";
import { canonicalJson, type Json } from "./json.js";
import {
  identityKey,
  identityLabel,
  identityToJson,
  namespaceToJson,
  sameNamespace,
  sameRef,
  staticNamespace,
  templateNamespace,
} from "./identity.js";
import { compareText, column, constraint, index, sequence, table } from "./object.js";
import { dependencyOrder } from "./order.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  DependencyEdge,
  IndexObject,
  Namespace,
  ObjectIdentity,
  ObjectRef,
  Owner,
  Provenance,
  SequenceObject,
  TableObject,
} from "./types.js";
import { CATALOG_VERSION, OWNERS } from "./types.js";

/**
 * Checks a set of objects and returns them in identity-key order.
 *
 * Duplicate identities are OKM1023. A foreign key whose target is missing is
 * OKM1021. Anything else the graph cannot resolve, including a cycle, is
 * OKM1020.
 *
 * @param objects - Built objects, in any order
 * @returns A catalog document
 */
export function catalog(objects: readonly CatalogObject[]): Catalog {
  const keys = new Set<string>();
  for (const object of objects) {
    if (object.kind !== object.identity.kind) {
      catalogError("OKM1020", `${identityLabel(object.identity)} has kind ${object.kind}.`);
    }
    const key = identityKey(object.identity);
    if (keys.has(key)) {
      catalogError("OKM1023", `Duplicate identity for ${identityLabel(object.identity)}.`);
    }
    keys.add(key);
  }
  assertForeignKeys(objects, keys);
  dependencyOrder(objects);
  const sorted = [...objects].sort((left, right) =>
    compareText(identityKey(left.identity), identityKey(right.identity)),
  );
  return { version: CATALOG_VERSION, objects: sorted };
}

/**
 * Create order for a catalog.
 *
 * Ties break by identity key.
 *
 * @param source - Catalog document
 * @returns Dependencies first
 */
export function creationOrder(source: Catalog): readonly CatalogObject[] {
  return dependencyOrder(source.objects);
}

/**
 * Renames a column without renaming constraints or indexes.
 *
 * Column lists and edges that pointed at the old column move to the new name.
 * `nameKey` and the stored constraint or index name stay as they were.
 *
 * @param source - Catalog document
 * @param change - Parent table, current column name, and the new name
 * @returns A new catalog
 */
export function renameColumn(
  source: Catalog,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
): Catalog {
  const fromIdentity: ObjectIdentity = {
    kind: "column",
    parent: change.parent,
    name: change.from,
  };
  const toIdentity: ObjectIdentity = {
    kind: "column",
    parent: change.parent,
    name: change.to,
  };
  const fromKey = identityKey(fromIdentity);
  const found = source.objects.some((object) => identityKey(object.identity) === fromKey);
  if (!found) {
    catalogError("OKM1020", `Column ${change.from} is not in the catalog.`);
  }
  const next = source.objects.map((object) => rewriteRenamed(object, change, fromKey, toIdentity));
  return catalog(next);
}

/**
 * Canonical JSON for a catalog.
 *
 * Templates stay templates. Object keys are sorted and objects are ordered by
 * identity key, so input order does not change the bytes.
 *
 * @param source - Catalog document
 * @returns Canonical text
 */
export function serializeCatalog(source: Catalog): string {
  const objects = [...source.objects].sort((left, right) =>
    compareText(identityKey(left.identity), identityKey(right.identity)),
  );
  return canonicalJson({
    objects: objects.map((object) => objectToJson(object)),
    version: source.version,
  });
}

/**
 * SHA-256 of {@link serializeCatalog}.
 *
 * The hash covers the normalised structure. It does not cover a separate
 * authoring document.
 *
 * @param source - Catalog document
 * @returns Lowercase hex digest
 */
export function catalogHash(source: Catalog): string {
  return sha256(serializeCatalog(source));
}

/**
 * Reads canonical catalog JSON.
 *
 * @param text - Serialized catalog
 * @returns A checked catalog
 */
export function parseCatalog(text: string): Catalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    catalogError("OKM1020", "Catalog JSON is not valid.");
  }
  const record = requireRecord(parsed, "catalog");
  rejectUnknown(record, ["objects", "version"], "catalog");
  if (record.version !== CATALOG_VERSION) {
    catalogError("OKM1020", `Catalog version ${String(record.version)} is not supported.`);
  }
  if (!Array.isArray(record.objects)) {
    catalogError("OKM1020", "Catalog objects are not an array.");
  }
  return catalog(record.objects.map((item) => parseObject(item)));
}

function assertForeignKeys(objects: readonly CatalogObject[], keys: ReadonlySet<string>): void {
  for (const object of objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") {
      continue;
    }
    const references = object.definition.references;
    if (references === undefined) {
      catalogError("OKM1021", `Foreign key ${object.identity.name} is missing its target.`);
    }
    const tableKey = identityKey({
      kind: "table",
      namespace: references.parent.namespace,
      name: references.parent.name,
    });
    if (!keys.has(tableKey)) {
      catalogError(
        "OKM1021",
        `Foreign key ${object.identity.name} references missing table ${references.parent.name}.`,
      );
    }
    for (const name of references.columns) {
      const columnKey = identityKey({ kind: "column", parent: references.parent, name });
      if (!keys.has(columnKey)) {
        catalogError(
          "OKM1021",
          `Foreign key ${object.identity.name} references missing column ${name}.`,
        );
      }
    }
  }
}

function rewriteRenamed(
  object: CatalogObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  fromKey: string,
  toIdentity: ObjectIdentity,
): CatalogObject {
  const dependencies = retarget(object.dependencies, fromKey, toIdentity);
  switch (object.kind) {
    case "table":
      return rewriteTable(object, change, dependencies);
    case "column":
      return rewriteColumn(object, change, dependencies);
    case "index":
      return rewriteIndex(object, change, dependencies);
    case "constraint":
      return rewriteConstraint(object, change, dependencies);
    case "sequence":
      return rewriteSequence(object, dependencies);
    default:
      return assertNever(object);
  }
}

function rewriteTable(
  object: TableObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): TableObject {
  const partition = object.definition.partition;
  const renamed =
    partition !== undefined &&
    object.identity.name === change.parent.name &&
    sameNamespace(object.identity.namespace, change.parent.namespace);
  return table({
    namespace: object.identity.namespace,
    name: object.identity.name,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(partition === undefined
      ? {}
      : {
          partition: {
            method: partition.method,
            columns: renamed
              ? partition.columns.map((name) => (name === change.from ? change.to : name))
              : [...partition.columns],
          },
        }),
  });
}

function rewriteColumn(
  object: ColumnObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): ColumnObject {
  const renamed =
    sameRef(object.identity.parent, change.parent) && object.identity.name === change.from;
  const definition = object.definition;
  return column({
    parent: object.identity.parent,
    name: renamed ? change.to : object.identity.name,
    dataType: definition.dataType,
    nullable: definition.nullable,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(definition.defaultExpression !== undefined
      ? { defaultExpression: definition.defaultExpression }
      : {}),
    ...(definition.identity !== undefined ? { identity: definition.identity } : {}),
    ...(definition.generated !== undefined ? { generated: definition.generated } : {}),
  });
}

function rewriteIndex(
  object: IndexObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): IndexObject {
  const local = sameRef(object.identity.parent, change.parent);
  const definition = object.definition;
  return index({
    parent: object.identity.parent,
    name: object.identity.name,
    nameKey: definition.nameKey,
    columns: local
      ? renameList(definition.columns, change.from, change.to)
      : [...definition.columns],
    unique: definition.unique,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(definition.predicate !== undefined ? { predicate: definition.predicate } : {}),
    ...(definition.expression !== undefined ? { expression: definition.expression } : {}),
  });
}

function rewriteConstraint(
  object: ConstraintObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): ConstraintObject {
  const definition = object.definition;
  const local = sameRef(object.identity.parent, change.parent);
  const references = definition.references;
  const referenced =
    references !== undefined && sameRef(references.parent, change.parent)
      ? {
          parent: references.parent,
          columns: renameList(references.columns, change.from, change.to),
        }
      : references;
  return constraint({
    parent: object.identity.parent,
    constraintKind: definition.constraintKind,
    name: object.identity.name,
    nameKey: definition.nameKey,
    columns: local
      ? renameList(definition.columns, change.from, change.to)
      : [...definition.columns],
    deferrable: definition.deferrable,
    initially: definition.initially,
    nullsNotDistinct: definition.nullsNotDistinct,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(definition.expression !== undefined ? { expression: definition.expression } : {}),
    ...(referenced !== undefined ? { references: referenced } : {}),
  });
}

function rewriteSequence(
  object: SequenceObject,
  dependencies: readonly ObjectIdentity[],
): SequenceObject {
  return sequence({
    namespace: object.identity.namespace,
    name: object.identity.name,
    dataType: object.definition.dataType,
    start: object.definition.start,
    increment: object.definition.increment,
    cycle: object.definition.cycle,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function renameList(names: readonly string[], from: string, to: string): string[] {
  return names.map((name) => (name === from ? to : name));
}

function retarget(
  edges: readonly DependencyEdge[],
  fromKey: string,
  to: ObjectIdentity,
): ObjectIdentity[] {
  return edges.map((edge) => (identityKey(edge.target) === fromKey ? to : edge.target));
}

function objectToJson(object: CatalogObject): Json {
  const dependencies = [...object.dependencies]
    .sort((left, right) => compareText(identityKey(left.target), identityKey(right.target)))
    .map((edge) => ({ target: identityToJson(edge.target) }));
  return {
    definition: definitionToJson(object),
    dependencies,
    identity: identityToJson(object.identity),
    kind: object.kind,
    owner: object.owner,
    provenance: { name: object.provenance.name, origin: object.provenance.origin },
  };
}

function definitionToJson(object: CatalogObject): Json {
  switch (object.kind) {
    case "table": {
      const partition = object.definition.partition;
      if (partition === undefined) {
        return {};
      }
      return { partition: { columns: [...partition.columns], method: partition.method } };
    }
    case "column": {
      const definition = object.definition;
      return {
        dataType: definition.dataType,
        nullable: definition.nullable,
        ...(definition.defaultExpression !== undefined
          ? { defaultExpression: definition.defaultExpression }
          : {}),
        ...(definition.identity !== undefined
          ? { identity: { always: definition.identity.always } }
          : {}),
        ...(definition.generated !== undefined
          ? {
              generated: {
                expression: definition.generated.expression,
                stored: definition.generated.stored,
              },
            }
          : {}),
      };
    }
    case "index": {
      const definition = object.definition;
      return {
        columns: [...definition.columns],
        nameKey: definition.nameKey,
        unique: definition.unique,
        ...(definition.expression !== undefined ? { expression: definition.expression } : {}),
        ...(definition.predicate !== undefined ? { predicate: definition.predicate } : {}),
      };
    }
    case "constraint": {
      const definition = object.definition;
      const references = definition.references;
      return {
        columns: [...definition.columns],
        constraintKind: definition.constraintKind,
        deferrable: definition.deferrable,
        initially: definition.initially,
        nameKey: definition.nameKey,
        nullsNotDistinct: definition.nullsNotDistinct,
        ...(definition.expression !== undefined ? { expression: definition.expression } : {}),
        ...(references !== undefined
          ? {
              references: {
                columns: [...references.columns],
                parent: {
                  name: references.parent.name,
                  namespace: namespaceToJson(references.parent.namespace),
                },
              },
            }
          : {}),
      };
    }
    case "sequence":
      return {
        cycle: object.definition.cycle,
        dataType: object.definition.dataType,
        increment: object.definition.increment,
        start: object.definition.start,
      };
    default:
      return assertNever(object);
  }
}

function parseObject(value: unknown): CatalogObject {
  const record = requireRecord(value, "catalog object");
  rejectUnknown(
    record,
    ["definition", "dependencies", "identity", "kind", "owner", "provenance"],
    "catalog object",
  );
  const kind = requireString(record.kind, "kind");
  if (!isBuiltKind(kind)) {
    catalogError("OKM1020", `Kind ${kind} is not part of this catalog.`);
  }
  const identity = parseIdentity(record.identity);
  if (identity.kind !== kind) {
    catalogError("OKM1020", `${identityLabel(identity)} has kind ${kind}.`);
  }
  const owner = parseOwner(record.owner);
  const provenance = parseProvenance(record.provenance);
  const dependencies = parseDependencies(record.dependencies);
  const definition = requireRecord(record.definition, "definition");
  switch (kind) {
    case "table":
      return parseTable(identity, definition, owner, provenance, dependencies);
    case "column":
      return parseColumn(identity, definition, owner, provenance, dependencies);
    case "index":
      return parseIndex(identity, definition, owner, provenance, dependencies);
    case "constraint":
      return parseConstraint(identity, definition, owner, provenance, dependencies);
    case "sequence":
      return parseSequence(identity, definition, owner, provenance, dependencies);
    default:
      return assertNeverKind(kind);
  }
}

function parseTable(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "table") {
    catalogError("OKM1020", "Table identity is not a table.");
  }
  rejectUnknown(definition, ["partition"], "table definition");
  const partition = definition.partition;
  return table({
    namespace: identity.namespace,
    name: identity.name,
    owner,
    provenance,
    dependencies,
    ...(partition === undefined ? {} : { partition: parsePartition(partition) }),
  });
}

function parseColumn(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "column") {
    catalogError("OKM1020", "Column identity is not a column.");
  }
  rejectUnknown(
    definition,
    ["dataType", "defaultExpression", "generated", "identity", "nullable"],
    "column definition",
  );
  const generated = definition.generated;
  const columnIdentity = definition.identity;
  return column({
    parent: identity.parent,
    name: identity.name,
    dataType: requireString(definition.dataType, "data type"),
    nullable: requireBoolean(definition.nullable, "nullable"),
    owner,
    provenance,
    dependencies,
    ...(definition.defaultExpression === undefined
      ? {}
      : { defaultExpression: requireString(definition.defaultExpression, "default") }),
    ...(columnIdentity === undefined ? {} : { identity: parseAlways(columnIdentity) }),
    ...(generated === undefined ? {} : { generated: parseGenerated(generated) }),
  });
}

function parseIndex(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "index") {
    catalogError("OKM1020", "Index identity is not an index.");
  }
  rejectUnknown(
    definition,
    ["columns", "expression", "nameKey", "predicate", "unique"],
    "index definition",
  );
  return index({
    parent: identity.parent,
    name: identity.name,
    nameKey: requireString(definition.nameKey, "name key"),
    columns: requireStrings(definition.columns, "index columns"),
    unique: requireBoolean(definition.unique, "unique"),
    owner,
    provenance,
    dependencies,
    ...(definition.predicate === undefined
      ? {}
      : { predicate: requireString(definition.predicate, "predicate") }),
    ...(definition.expression === undefined
      ? {}
      : { expression: requireString(definition.expression, "expression") }),
  });
}

function parseConstraint(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "constraint") {
    catalogError("OKM1020", "Constraint identity is not a constraint.");
  }
  rejectUnknown(
    definition,
    [
      "columns",
      "constraintKind",
      "deferrable",
      "expression",
      "initially",
      "nameKey",
      "nullsNotDistinct",
      "references",
    ],
    "constraint definition",
  );
  const constraintKind = requireString(definition.constraintKind, "constraint kind");
  if (
    constraintKind !== "primaryKey" &&
    constraintKind !== "unique" &&
    constraintKind !== "foreignKey" &&
    constraintKind !== "check"
  ) {
    catalogError("OKM1020", `Constraint kind ${constraintKind} is not known.`);
  }
  const initially = requireString(definition.initially, "initially");
  if (initially !== "immediate" && initially !== "deferred") {
    catalogError("OKM1020", `Constraint initially ${initially} is not known.`);
  }
  const references = definition.references;
  return constraint({
    parent: identity.parent,
    constraintKind,
    name: identity.name,
    nameKey: requireString(definition.nameKey, "name key"),
    columns: requireStrings(definition.columns, "constraint columns"),
    deferrable: requireBoolean(definition.deferrable, "deferrable"),
    initially,
    nullsNotDistinct: requireBoolean(definition.nullsNotDistinct, "nulls not distinct"),
    owner,
    provenance,
    dependencies,
    ...(definition.expression === undefined
      ? {}
      : { expression: requireString(definition.expression, "expression") }),
    ...(references === undefined ? {} : { references: parseReferences(references) }),
  });
}

function parseSequence(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "sequence") {
    catalogError("OKM1020", "Sequence identity is not a sequence.");
  }
  rejectUnknown(definition, ["cycle", "dataType", "increment", "start"], "sequence definition");
  const dataType = requireString(definition.dataType, "sequence type");
  if (dataType !== "smallint" && dataType !== "integer" && dataType !== "bigint") {
    catalogError("OKM1020", `Sequence type ${dataType} is not known.`);
  }
  return sequence({
    namespace: identity.namespace,
    name: identity.name,
    dataType,
    start: requireString(definition.start, "sequence start"),
    increment: requireString(definition.increment, "sequence increment"),
    cycle: requireBoolean(definition.cycle, "cycle"),
    owner,
    provenance,
    dependencies,
  });
}

function parseIdentity(value: unknown): ObjectIdentity {
  const record = requireRecord(value, "identity");
  const kind = requireString(record.kind, "identity kind");
  switch (kind) {
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
    case "type":
      rejectUnknown(record, ["kind", "name", "namespace"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        namespace: parseNamespace(record.namespace),
      };
    case "column":
    case "index":
    case "constraint":
    case "trigger":
    case "policy":
      rejectUnknown(record, ["kind", "name", "parent"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        parent: parseRef(record.parent),
      };
    case "function":
      rejectUnknown(record, ["argTypes", "kind", "name", "namespace"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        namespace: parseNamespace(record.namespace),
        argTypes: requireStrings(record.argTypes, "argument types"),
      };
    case "grant":
      rejectUnknown(record, ["kind", "object", "privilege", "role"], "identity");
      return {
        kind,
        role: requireString(record.role, "role"),
        privilege: requireString(record.privilege, "privilege"),
        object: parseGrantObject(record.object),
      };
    case "defaultPrivilege":
      rejectUnknown(
        record,
        ["forRole", "grantee", "kind", "namespace", "objectKind", "privilege"],
        "identity",
      );
      return {
        kind,
        forRole: requireString(record.forRole, "forRole"),
        grantee: requireString(record.grantee, "grantee"),
        namespace: parseNamespace(record.namespace),
        objectKind: requireString(record.objectKind, "object kind"),
        privilege: requireString(record.privilege, "privilege"),
      };
    case "role":
    case "extension":
      rejectUnknown(record, ["kind", "name"], "identity");
      return { kind, name: requireString(record.name, "name") };
    default:
      catalogError("OKM1020", `Identity kind ${kind} is not known.`);
  }
}

function parseNamespace(value: unknown): Namespace {
  const record = requireRecord(value, "namespace");
  const form = requireString(record.form, "namespace form");
  if (form === "static") {
    rejectUnknown(record, ["form", "name"], "namespace");
    return staticNamespace(requireString(record.name, "namespace"));
  }
  if (form === "template") {
    rejectUnknown(record, ["form", "pattern"], "namespace");
    return templateNamespace(requireString(record.pattern, "namespace template"));
  }
  catalogError("OKM1020", `Namespace form ${form} is not known.`);
}

function parseRef(value: unknown): ObjectRef {
  const record = requireRecord(value, "parent");
  rejectUnknown(record, ["name", "namespace"], "parent");
  return {
    name: requireString(record.name, "parent name"),
    namespace: parseNamespace(record.namespace),
  };
}

function parseGrantObject(value: unknown): {
  readonly kind: "table" | "sequence" | "namespace";
  readonly namespace: Namespace;
  readonly name: string;
} {
  const record = requireRecord(value, "grant object");
  rejectUnknown(record, ["kind", "name", "namespace"], "grant object");
  const kind = requireString(record.kind, "grant object kind");
  if (kind !== "table" && kind !== "sequence" && kind !== "namespace") {
    catalogError("OKM1020", `Grant object kind ${kind} is not known.`);
  }
  return {
    kind,
    name: requireString(record.name, "grant object name"),
    namespace: parseNamespace(record.namespace),
  };
}

function parsePartition(value: unknown): {
  readonly method: "range" | "list" | "hash";
  readonly columns: readonly string[];
} {
  const record = requireRecord(value, "partition");
  rejectUnknown(record, ["columns", "method"], "partition");
  const method = requireString(record.method, "partition method");
  if (method !== "range" && method !== "list" && method !== "hash") {
    catalogError("OKM1020", `Partition method ${method} is not known.`);
  }
  return { method, columns: requireStrings(record.columns, "partition columns") };
}

function parseReferences(value: unknown): {
  readonly parent: ObjectRef;
  readonly columns: readonly string[];
} {
  const record = requireRecord(value, "references");
  rejectUnknown(record, ["columns", "parent"], "references");
  return {
    parent: parseRef(record.parent),
    columns: requireStrings(record.columns, "referenced columns"),
  };
}

function parseAlways(value: unknown): { readonly always: boolean } {
  const record = requireRecord(value, "identity");
  rejectUnknown(record, ["always"], "identity");
  return { always: requireBoolean(record.always, "always") };
}

function parseGenerated(value: unknown): { readonly stored: boolean; readonly expression: string } {
  const record = requireRecord(value, "generated");
  rejectUnknown(record, ["expression", "stored"], "generated");
  return {
    stored: requireBoolean(record.stored, "stored"),
    expression: requireString(record.expression, "generated expression"),
  };
}

function parseOwner(value: unknown): Owner {
  const owner = requireString(value, "owner");
  if (!isOwner(owner)) {
    catalogError("OKM1020", `Owner ${owner} is not known.`);
  }
  return owner;
}

function parseProvenance(value: unknown): Provenance {
  const record = requireRecord(value, "provenance");
  rejectUnknown(record, ["name", "origin"], "provenance");
  const origin = requireString(record.origin, "provenance origin");
  const name = requireString(record.name, "provenance name");
  if (origin !== "file" && origin !== "trait" && origin !== "extension") {
    catalogError("OKM1020", `Provenance origin ${origin} is not known.`);
  }
  return { origin, name };
}

function parseDependencies(value: unknown): readonly ObjectIdentity[] {
  if (!Array.isArray(value)) {
    catalogError("OKM1020", "Dependencies are not an array.");
  }
  return value.map((item) => {
    const record = requireRecord(item, "dependency");
    rejectUnknown(record, ["target"], "dependency");
    return parseIdentity(record.target);
  });
}

function isBuiltKind(kind: string): kind is CatalogObject["kind"] {
  return (
    kind === "table" ||
    kind === "column" ||
    kind === "index" ||
    kind === "constraint" ||
    kind === "sequence"
  );
}

function isOwner(value: string): value is Owner {
  return (OWNERS as readonly string[]).includes(value);
}

function requireRecord(value: unknown, role: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    catalogError("OKM1020", `${role} is not an object.`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, role: string): string {
  if (typeof value !== "string") {
    catalogError("OKM1020", `${role} is not a string.`);
  }
  return value;
}

function requireBoolean(value: unknown, role: string): boolean {
  if (typeof value !== "boolean") {
    catalogError("OKM1020", `${role} is not a boolean.`);
  }
  return value;
}

function requireStrings(value: unknown, role: string): readonly string[] {
  if (!Array.isArray(value)) {
    catalogError("OKM1020", `${role} is not an array.`);
  }
  return value.map((item) => requireString(item, role));
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  role: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      catalogError("OKM1020", `${role} has unexpected field ${key}.`);
    }
  }
}

function assertNever(value: never): never {
  return catalogError("OKM1020", `Unexpected catalog object ${JSON.stringify(value)}.`);
}

function assertNeverKind(value: never): never {
  return catalogError("OKM1020", `Unexpected kind ${JSON.stringify(value)}.`);
}
