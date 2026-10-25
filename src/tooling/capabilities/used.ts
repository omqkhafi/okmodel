/**
 * Features a catalog uses.
 *
 * Detection reads catalog objects only, so `describe(describe(s))` reports
 * the same list. Query and transaction features live in the dialect registry.
 * They are not "used" by a schema unless the catalog shows them.
 */

import { isDomain } from "../../contracts/catalog/enum.js";
import type { Catalog, CatalogObject, Namespace } from "../../contracts/catalog/types.js";

const RANGE_TYPES = new Set([
  "int4range",
  "int8range",
  "numrange",
  "daterange",
  "tsrange",
  "tstzrange",
]);

/**
 * Dotted feature keys this catalog uses, sorted.
 *
 * @param catalog - Catalog `schema()` built, or a placed copy
 * @returns Keys present in the Postgres registry that the catalog shows
 */
export function featuresUsed(catalog: Catalog): readonly string[] {
  const used = new Set<string>();
  for (const object of catalog.objects) note(used, object);
  return [...used].sort();
}

function note(used: Set<string>, object: CatalogObject): void {
  if (object.kind === "table") {
    used.add("schema.core");
    if (moved(object.identity.namespace)) used.add("namespace");
  }
  if (object.kind === "type") {
    if (isDomain(object.definition)) used.add("type.domain");
    else used.add("type.enum");
    if (moved(object.identity.namespace)) used.add("namespace");
  }
  if (object.kind === "column") {
    const definition = object.definition;
    if (definition.identity !== undefined) used.add("schema.identity");
    if (scalarType(definition.dataType) === "uuid") used.add("type.uuid");
    if (isUuidV7Default(definition.defaultExpression)) used.add("type.uuidv7");
    if (definition.dataType === "jsonb") used.add("type.jsonb");
    if (definition.dataType.endsWith("[]")) used.add("type.array");
    if (RANGE_TYPES.has(definition.dataType) || definition.dataType.endsWith("multirange")) {
      used.add("type.range");
    }
    if (definition.generated !== undefined) used.add("column.generated");
  }
  if (object.kind === "index") {
    if (object.definition.predicate !== undefined) used.add("index.partial");
    if (object.definition.expression !== undefined) used.add("index.expression");
  }
  if (object.kind === "extension") used.add("extension");
  if (object.kind === "policy") {
    used.add("policies.table");
    used.add("tenancy.rls");
  }
  if (object.kind === "role" || object.kind === "grant" || object.kind === "defaultPrivilege") {
    used.add("roles.grants");
  }
  if (
    (object.kind === "view" || object.kind === "materializedView" || object.kind === "sequence") &&
    moved(object.identity.namespace)
  ) {
    used.add("namespace");
  }
}

/**
 * `uuidv7()` with any letter case and surrounding space.
 *
 * `defaultSql("UUIDV7()")` stores the expression as written.
 *
 * @param expression - Column default, when the column has one
 * @returns Whether the default is the Postgres 18 function
 */
export function isUuidV7Default(expression: string | undefined): boolean {
  return expression !== undefined && expression.trim().toLowerCase() === "uuidv7()";
}

/** Element type of an array, or the type itself. `uuid[]` is `uuid`. */
function scalarType(dataType: string): string {
  return dataType.replace(/\[\]/g, "");
}

function moved(namespace: Namespace): boolean {
  if (namespace.form === "template") return true;
  return namespace.name !== "public";
}
