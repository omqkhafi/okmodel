/**
 * Normal form used to compare a catalog with an introspection.
 *
 * Owner and provenance stay on the authoring object. Rewritten SQL bodies are
 * not part of this form. Namespace templates are restored with an explicit binding.
 */

import { canonicalJson, type Json } from "./canonical.js";
import { type IntrospectedObject } from "./introspect.js";
import {
  argTypesOf,
  namespaceOf,
  parentOf,
  type CatalogObject,
  type ObjectKind,
} from "./object.js";
import { type NamespaceBinding } from "./render.js";
import { canonicalRangeBound, normalizeExpression } from "./sql.js";

/** Structural fields that a scratch database can reproduce. */
export type NormalizedObject = {
  readonly kind: ObjectKind;
  readonly namespace: string | undefined;
  readonly template: boolean;
  readonly parent: string | undefined;
  readonly name: string;
  readonly argTypes: readonly string[];
  readonly attributes: Readonly<Record<string, string>>;
};

/**
 * Projects a managed catalog object into the normal form.
 *
 * @param object - Authoring object
 * @returns Fields the database can store
 */
export function normalizeCatalogObject(object: CatalogObject): NormalizedObject {
  const namespace = namespaceOf(object.identity);
  return {
    kind: object.kind,
    namespace: namespace?.name,
    template: namespace?.template ?? false,
    parent: parentOf(object.identity),
    name: object.identity.name,
    argTypes: argTypesOf(object.identity) ?? [],
    attributes: attributesOf(object),
  };
}

/**
 * Projects an introspected row into the normal form.
 *
 * The namespace is still the concrete schema. {@link rebindNamespace} restores
 * a template afterwards.
 *
 * @param object - Row from introspection
 * @returns Normal form in the concrete schema
 */
export function normalizeIntrospected(object: IntrospectedObject): NormalizedObject {
  return {
    kind: object.kind,
    namespace: object.namespace,
    template: false,
    parent: object.parent,
    name: object.name,
    argTypes: object.argTypes ?? [],
    attributes: object.attributes,
  };
}

/**
 * Rewrites a concrete schema name back to the logical namespace.
 *
 * @param object - Introspected normal form
 * @param bindings - Apply bindings
 * @returns The same object, with the logical namespace
 */
export function rebindNamespace(
  object: NormalizedObject,
  bindings: readonly NamespaceBinding[],
): NormalizedObject {
  if (object.namespace === undefined) return object;
  const binding = bindings.find((item) => item.concrete === object.namespace);
  if (binding === undefined) return object;
  return {
    ...object,
    namespace: binding.logical.name,
    template: binding.logical.template,
  };
}

/**
 * Stable key for a normalized object.
 *
 * @param object - Normal form
 * @returns Canonical JSON
 */
export function normalizedKey(object: NormalizedObject): string {
  const json: Json = {
    argTypes: object.argTypes,
    kind: object.kind,
    name: object.name,
    namespace: object.namespace ?? "",
    parent: object.parent ?? "",
    template: object.template,
  };
  return canonicalJson(json);
}

/**
 * Lists missing objects, extra objects, and attribute mismatches.
 *
 * @param expected - Catalog side
 * @param actual - Database side
 * @returns Human-readable differences. Empty when the two sides match
 */
export function diffNormalized(
  expected: readonly NormalizedObject[],
  actual: readonly NormalizedObject[],
): readonly string[] {
  const actualByKey = new Map(actual.map((object) => [normalizedKey(object), object]));
  const expectedKeys = new Set(expected.map((object) => normalizedKey(object)));
  const problems: string[] = [];
  for (const object of expected) {
    const found = actualByKey.get(normalizedKey(object));
    if (found === undefined) {
      problems.push(`missing ${object.kind} ${label(object)}`);
      continue;
    }
    const keys = new Set([...Object.keys(object.attributes), ...Object.keys(found.attributes)]);
    for (const attribute of [...keys].sort()) {
      const left = object.attributes[attribute] ?? "";
      const right = found.attributes[attribute] ?? "";
      if (left !== right) {
        problems.push(
          `${object.kind} ${label(object)} ${attribute}: expected ${left}, got ${right}`,
        );
      }
    }
  }
  for (const object of actual) {
    if (!expectedKeys.has(normalizedKey(object))) {
      problems.push(`extra ${object.kind} ${label(object)}`);
    }
  }
  return problems;
}

/**
 * Mismatches that mention one kind.
 *
 * @param mismatches - Output of {@link diffNormalized}
 * @param kind - Object kind
 * @returns The subset for that kind
 */
export function mismatchesFor(mismatches: readonly string[], kind: ObjectKind): readonly string[] {
  return mismatches.filter(
    (line) =>
      line.startsWith(`missing ${kind} `) ||
      line.startsWith(`extra ${kind} `) ||
      line.startsWith(`${kind} `),
  );
}

function attributesOf(object: CatalogObject): Readonly<Record<string, string>> {
  switch (object.kind) {
    case "table": {
      const partition = object.definition.partitionBy;
      return {
        partition:
          partition === undefined ? "" : `${partition.method}:${partition.columns.join(",")}`,
        rowSecurity: object.definition.rowSecurity ? "true" : "false",
      };
    }
    case "column":
      return {
        default:
          object.definition.generatedSql === undefined ? (object.definition.defaultSql ?? "") : "",
        generated:
          object.definition.generatedSql === undefined
            ? ""
            : normalizeExpression(object.definition.generatedSql),
        nullable: object.definition.nullable ? "true" : "false",
        type: object.definition.type,
      };
    case "index":
      return {
        columns: object.definition.columns.join(","),
        expression:
          object.definition.expression === undefined
            ? ""
            : normalizeExpression(object.definition.expression),
        unique: object.definition.unique ? "true" : "false",
      };
    case "constraint": {
      const references = object.definition.references;
      return {
        columns: object.definition.columns.join(","),
        constraintKind: object.definition.constraintKind,
        deferrable: object.definition.deferrable ? "true" : "false",
        expression:
          object.definition.constraintKind === "check" && object.definition.expression !== undefined
            ? normalizeExpression(object.definition.expression)
            : "",
        initially: object.definition.deferrable ? object.definition.initially : "",
        nullsNotDistinct: object.definition.nullsNotDistinct ? "true" : "false",
        references:
          references === undefined ? "" : `${references.table}(${references.columns.join(",")})`,
      };
    }
    case "sequence":
      return {
        dataType: object.definition.dataType,
        increment: object.definition.increment,
        start: object.definition.start,
      };
    case "extension":
      return { installed: "true" };
    case "view":
      return { columns: object.definition.columns.join(",") };
    case "materialized_view":
      return {
        columns: object.definition.columns.join(","),
        withData: object.definition.withData ? "true" : "false",
      };
    case "function":
      return {
        language: object.definition.language,
        returns: object.definition.returns,
        volatility: object.definition.volatility,
      };
    case "trigger":
      return {
        events: [...object.definition.events].sort().join(","),
        function: object.definition.function,
        functionArgTypes: object.definition.functionArgTypes.join(","),
        level: object.definition.level,
        timing: object.definition.timing,
      };
    case "policy":
      return {
        check: normalizeExpression(object.definition.check),
        command: object.definition.command,
        permissive: object.definition.permissive ? "true" : "false",
        using: normalizeExpression(object.definition.using),
      };
    case "domain":
      return {
        baseType: object.definition.baseType,
        check:
          object.definition.checkSql === undefined
            ? ""
            : normalizeExpression(object.definition.checkSql),
        notNull: object.definition.notNull ? "true" : "false",
      };
    case "partition":
      return {
        bound: partitionBound(object.definition),
        parent: object.definition.parent,
      };
    default:
      return assertNever(object);
  }
}

function partitionBound(
  definition: Extract<CatalogObject, { kind: "partition" }>["definition"],
): string {
  const method = definition.method ?? "range";
  if (method === "list") return `list:${(definition.values ?? []).join(",")}`;
  if (method === "hash") {
    return `hash:${String(definition.modulus ?? 0)}:${String(definition.remainder ?? 0)}`;
  }
  return canonicalRangeBound(definition.from, definition.to);
}

function label(object: NormalizedObject): string {
  return object.parent === undefined ? object.name : `${object.parent}.${object.name}`;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected catalog object ${JSON.stringify(value)}`);
}
