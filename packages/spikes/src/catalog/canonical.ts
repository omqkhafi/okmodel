/**
 * Canonical JSON and deterministic hashes.
 *
 * Key order does not change the encoding. Dependency edges are sorted, so
 * edge order does not change an object's hash either.
 */

import {
  argTypesOf,
  namespaceOf,
  parentOf,
  type CatalogObject,
  type DependencyEdge,
  type ObjectIdentity,
  type Provenance,
} from "./object.js";

/** JSON values the canonical encoder accepts. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/**
 * Encodes a value with object keys sorted at every level.
 *
 * Arrays keep their order. Callers sort sets (dependency edges) before encoding.
 *
 * @param value - JSON value
 * @returns Canonical text
 */
export function canonicalJson(value: Json): string {
  return encode(sortKeys(value));
}

/**
 * Stable identity key.
 *
 * @param identity - Object identity
 * @returns Canonical JSON of the identity
 */
export function identityKey(identity: ObjectIdentity): string {
  return canonicalJson(identityToJson(identity));
}

/**
 * SHA-256 of one object's canonical form.
 *
 * @param object - Catalog object
 * @returns Lowercase hex digest
 */
export function objectHash(object: CatalogObject): string {
  return sha256(canonicalJson(objectToJson(object)));
}

/**
 * SHA-256 of a catalog.
 *
 * Object order does not matter: the digest covers the sorted object hashes.
 *
 * @param objects - Catalog objects
 * @returns Lowercase hex digest
 */
export function catalogHash(objects: readonly CatalogObject[]): string {
  const parts = objects.map((object) => objectHash(object)).sort();
  return sha256(parts.join("\n"));
}

/**
 * SHA-256 of a UTF-8 string.
 *
 * @param text - Input
 * @returns Lowercase hex digest
 */
export function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/**
 * Times {@link catalogHash}.
 *
 * @param objects - Catalog objects
 * @param repeats - Extra repetitions used for the mean. The first call is separate
 * @returns One-shot milliseconds, mean milliseconds, and the object count
 */
export function measureCatalogHash(
  objects: readonly CatalogObject[],
  repeats: number,
): { readonly onceMs: number; readonly meanMs: number; readonly objects: number } {
  const started = performance.now();
  catalogHash(objects);
  const onceMs = performance.now() - started;
  const loopStarted = performance.now();
  for (let index = 0; index < repeats; index += 1) {
    catalogHash(objects);
  }
  const meanMs = (performance.now() - loopStarted) / repeats;
  return { onceMs, meanMs, objects: objects.length };
}

function objectToJson(object: CatalogObject): Json {
  const dependencies = object.dependencies
    .map((edge) => dependencyToJson(edge))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    definition: definitionToJson(object),
    dependencies,
    identity: identityToJson(object.identity),
    kind: object.kind,
    owner: object.owner,
    provenance: provenanceToJson(object.provenance),
  };
}

function identityToJson(identity: ObjectIdentity): Json {
  const json: Record<string, Json> = { kind: identity.kind, name: identity.name };
  const namespace = namespaceOf(identity);
  if (namespace !== undefined) {
    json.namespace = namespace.name;
    json.template = namespace.template;
  }
  const parent = parentOf(identity);
  if (parent !== undefined) json.parent = parent;
  const argTypes = argTypesOf(identity);
  if (argTypes !== undefined) json.argTypes = [...argTypes];
  return json;
}

function dependencyToJson(edge: DependencyEdge): Json {
  return { identity: identityToJson(edge.identity) };
}

function provenanceToJson(provenance: Provenance): Json {
  const json: Record<string, Json> = { source: provenance.source };
  if (provenance.detail !== undefined) json.detail = provenance.detail;
  return json;
}

function definitionToJson(object: CatalogObject): Json {
  switch (object.kind) {
    case "table":
      return {
        partitionColumns: object.definition.partitionBy?.columns ?? [],
        partitionMethod: object.definition.partitionBy?.method ?? "",
        rowSecurity: object.definition.rowSecurity,
      };
    case "column": {
      const column: Record<string, Json> = {
        defaultSql: object.definition.defaultSql ?? "",
        nullable: object.definition.nullable,
        type: object.definition.type,
      };
      if (object.definition.generatedSql !== undefined) {
        column.generatedSql = object.definition.generatedSql;
      }
      return column;
    }
    case "index": {
      const index: Record<string, Json> = {
        columns: object.definition.columns,
        unique: object.definition.unique,
      };
      if (object.definition.expression !== undefined)
        index.expression = object.definition.expression;
      return index;
    }
    case "constraint":
      return {
        columns: object.definition.columns,
        constraintKind: object.definition.constraintKind,
        deferrable: object.definition.deferrable,
        expression: object.definition.expression ?? "",
        initially: object.definition.initially,
        nullsNotDistinct: object.definition.nullsNotDistinct,
        references: object.definition.references ?? { columns: [], table: "" },
      };
    case "sequence":
      return {
        dataType: object.definition.dataType,
        increment: object.definition.increment,
        start: object.definition.start,
      };
    case "extension":
      return { name: object.definition.name };
    case "view":
      return { columns: object.definition.columns, sql: object.definition.sql };
    case "materialized_view":
      return {
        columns: object.definition.columns,
        sql: object.definition.sql,
        withData: object.definition.withData,
      };
    case "function":
      return {
        args: object.definition.args.map((arg) => ({ name: arg.name, type: arg.type })),
        body: object.definition.body,
        bodyStyle: object.definition.bodyStyle,
        language: object.definition.language,
        returns: object.definition.returns,
        volatility: object.definition.volatility,
      };
    case "trigger":
      return {
        events: [...object.definition.events].sort(),
        function: object.definition.function,
        functionArgTypes: object.definition.functionArgTypes,
        level: object.definition.level,
        timing: object.definition.timing,
      };
    case "policy":
      return {
        check: object.definition.check,
        command: object.definition.command,
        permissive: object.definition.permissive,
        using: object.definition.using,
      };
    case "domain":
      return {
        baseType: object.definition.baseType,
        checkSql: object.definition.checkSql ?? "",
        notNull: object.definition.notNull,
      };
    case "partition": {
      const partition: Record<string, Json> = {
        from: object.definition.from,
        parent: object.definition.parent,
        to: object.definition.to,
      };
      if (object.definition.method !== undefined && object.definition.method !== "range") {
        partition.method = object.definition.method;
      }
      if (object.definition.values !== undefined && object.definition.values.length > 0) {
        partition.values = [...object.definition.values];
      }
      if (object.definition.method === "hash") {
        partition.modulus = object.definition.modulus ?? 0;
        partition.remainder = object.definition.remainder ?? 0;
      }
      return partition;
    }
    default:
      return assertNever(object);
  }
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (!isJsonRecord(value)) return value;
  const sorted: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) sorted[key] = sortKeys(item);
  }
  return sorted;
}

function encode(value: Json): string {
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(",")}]`;
  if (isJsonRecord(value)) {
    const keys = Object.keys(value);
    const body = keys.map((key) => `${JSON.stringify(key)}:${encode(value[key] ?? null)}`);
    return `{${body.join(",")}}`;
  }
  return JSON.stringify(value);
}

function isJsonRecord(value: Json): value is { readonly [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected catalog object ${JSON.stringify(value)}`);
}
