/**
 * Features a catalog uses.
 *
 * Detection reads catalog objects only, so `describe(describe(s))` reports
 * the same list. Query and transaction features live in the dialect registry.
 * They are not "used" by a schema unless the catalog shows them.
 */

import { isComposite } from "../../contracts/catalog/composite.js";
import { isDomain } from "../../contracts/catalog/enum.js";
import { isRange } from "../../contracts/catalog/range.js";
import { isGeneratedPolicy } from "../../contracts/catalog/policy.js";
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
  noteStandaloneSequences(used, catalog);
  noteRanges(used, catalog);
  return [...used].sort();
}

function note(used: Set<string>, object: CatalogObject): void {
  if (object.kind === "table") {
    used.add("schema.core");
    if (moved(object.identity.namespace)) used.add("namespace");
    const partition = object.definition.partition;
    if (partition !== undefined) {
      if (partition.ownership === "external") used.add("partition.external");
      else if (partition.method === "range") used.add("partition.range");
      else if (partition.method === "list") used.add("partition.list");
      else used.add("partition.hash");
    }
  }
  if (object.kind === "type") {
    if (isDomain(object.definition)) used.add("type.domain");
    else if (isComposite(object.definition)) used.add("type.composite");
    else if (isRange(object.definition)) used.add("type.range");
    else used.add("type.enum");
    if (moved(object.identity.namespace)) used.add("namespace");
  }
  if (object.kind === "column") {
    const definition = object.definition;
    if (definition.identity !== undefined) {
      used.add("schema.identity");
      const identity = definition.identity;
      if (
        identity.always === false ||
        identity.start !== undefined ||
        identity.increment !== undefined ||
        identity.min !== undefined ||
        identity.max !== undefined ||
        identity.cache !== undefined ||
        identity.cycle === true
      ) {
        used.add("identity.options");
      }
    }
    if (definition.defaultExpression?.includes("nextval(")) used.add("sequence.native");
    if (definition.series !== undefined) {
      used.add("sequence.counter");
      if (definition.series.reset !== undefined) used.add("sequence.reset");
      if (definition.series.when !== undefined) used.add("sequence.when");
    }
    if (definition.generated?.expression.includes("lpad(")) used.add("sequence.numbered");
    if (scalarType(definition.dataType) === "uuid") used.add("type.uuid");
    if (isUuidV7Default(definition.defaultExpression)) used.add("type.uuidv7");
    if (definition.dataType === "jsonb") used.add("type.jsonb");
    if (definition.dataType.endsWith("[]")) used.add("type.array");
    if (definition.dataType.startsWith("vector(")) used.add("type.vector");
    if (definition.dataType.startsWith("halfvec(")) used.add("type.halfvec");
    if (RANGE_TYPES.has(definition.dataType) || definition.dataType.endsWith("multirange")) {
      used.add("type.range");
    }
    if (definition.generated !== undefined) {
      used.add("column.generated");
      used.add("column.generatedExpression");
      if (definition.generated.stored === false) used.add("column.generatedVirtual");
    }
  }
  if (object.kind === "constraint" && object.definition.constraintKind === "exclusion") {
    used.add("constraint.exclusion");
  }
  if (
    object.kind === "constraint" &&
    (object.definition.withoutOverlaps === true || object.definition.period === true)
  ) {
    used.add("temporal.keys");
  }
  if (object.kind === "constraint" && object.definition.constraintKind === "foreignKey") {
    if (object.definition.columns.length > 1) used.add("foreignKey.composite");
    if (object.definition.deferrable) used.add("foreignKey.deferrable");
    if (object.definition.references?.onDeleteColumns !== undefined) {
      used.add("foreignKey.setNullColumns");
    }
    if (object.definition.references?.match === "full") used.add("foreignKey.matchFull");
  }
  if (
    object.kind === "constraint" &&
    object.definition.constraintKind === "check" &&
    object.definition.enforced === false
  ) {
    used.add("check.notEnforced");
  }
  if (object.kind === "index") {
    if (object.definition.predicate !== undefined) used.add("index.partial");
    if (object.definition.expression !== undefined) used.add("index.expression");
    if (object.definition.expression?.startsWith("using hnsw ")) used.add("index.hnsw");
    if (object.definition.expression?.startsWith("using ivfflat ")) used.add("index.ivfflat");
    if (object.definition.include !== undefined && object.definition.include.length > 0) {
      used.add("index.covering");
    }
    if (
      object.definition.elements?.some(
        (element) =>
          element.order !== undefined ||
          element.nulls !== undefined ||
          element.opclass !== undefined,
      ) === true
    ) {
      used.add("index.ordering");
    }
    if (object.definition.nullsNotDistinct === true) used.add("index.nullsNotDistinct");
    if (object.definition.storage !== undefined) used.add("index.storage");
  }
  if (object.comment !== undefined) noteComment(used, object);
  if (
    (object.kind === "view" || object.kind === "materializedView") &&
    object.definition.columns.some((column) => column.comment !== undefined)
  ) {
    used.add(object.kind === "view" ? "comment.view" : "comment.matview");
  }
  if (object.kind === "eventTrigger") {
    used.add("trigger.event");
    const preset = object.provenance.name;
    if (
      preset === "guardDdl" ||
      preset === "enableRls" ||
      preset === "auditDdl" ||
      preset === "notifyDdl"
    ) {
      used.add(`trigger.${preset}`);
    }
  }
  if (object.kind === "trigger" && object.definition.referencing !== undefined) {
    used.add("trigger.referencing");
  }
  if (object.kind === "extension") {
    used.add("extension");
    if (object.identity.name === "vector") used.add("ext.pgvector");
  }
  if (object.kind === "policy") {
    used.add("policies.table");
    if (isGeneratedPolicy(object)) {
      used.add("tenancy.rls");
      if (/::(integer|int4|bigint|int8|text)\b/.test(object.definition.expression)) {
        used.add("tenancy.keyTypes");
      }
    } else if (object.definition.restrictive === true) {
      used.add("policies.restrictive");
    } else {
      used.add("policies.permissive");
    }
    if (
      object.definition.expression.includes("::text[]") ||
      object.definition.check?.includes("::text[]")
    ) {
      used.add("session.list");
    }
  }
  if (object.kind === "role" || object.kind === "grant" || object.kind === "defaultPrivilege") {
    used.add("roles.grants");
  }
  if (object.kind === "grant" && object.identity.object.kind === "sequence") {
    used.add("grants.sequence");
  }
  if (object.kind === "grant" && object.identity.object.kind === "procedure") {
    used.add("grants.procedure");
  }
  if (object.kind === "function") {
    const definition = object.definition;
    if (definition.routine === "procedure") {
      used.add("fn.procedure");
      if (definition.commits === true) used.add("fn.procedure.commits");
      if (definition.raises !== undefined && definition.raises.length > 0) used.add("fn.raises");
    }
    if (definition.security === "definer") used.add("fn.definerRevoke");
    if (object.identity.name.startsWith("okm_watch_")) {
      if (definition.body.includes("pg_notify")) used.add("watch.wake");
      if (definition.body.includes("okm_changes")) used.add("watch.feed");
    }
  }
  if (
    (object.kind === "view" || object.kind === "materializedView" || object.kind === "sequence") &&
    moved(object.identity.namespace)
  ) {
    used.add("namespace");
  }
}

function noteRanges(used: Set<string>, catalog: Catalog): void {
  const names = new Set<string>();
  for (const object of catalog.objects) {
    if (object.kind === "type" && isRange(object.definition)) names.add(object.identity.name);
  }
  if (names.size === 0) return;
  for (const object of catalog.objects) {
    if (
      object.kind === "grant" &&
      object.identity.object.kind === "type" &&
      names.has(object.identity.object.name)
    ) {
      used.add("grants.range");
    }
    if (object.kind === "type" && object.comment !== undefined && names.has(object.identity.name)) {
      used.add("comment.range");
    }
  }
}

function noteStandaloneSequences(used: Set<string>, catalog: Catalog): void {
  const identityNames = new Set<string>();
  for (const object of catalog.objects) {
    if (object.kind === "column" && object.definition.identity !== undefined) {
      identityNames.add(`${object.identity.parent.name}_${object.identity.name}_seq`);
    }
    if (object.kind === "column" && object.definition.defaultExpression?.includes("nextval(")) {
      used.add("sequence.native");
    }
  }
  for (const object of catalog.objects) {
    if (object.kind === "sequence" && !identityNames.has(object.identity.name)) {
      used.add("sequence.native");
    }
  }
}

function noteComment(used: Set<string>, object: CatalogObject): void {
  const kind = object.kind;
  if (object.kind === "constraint") {
    const constraintKind = object.definition.constraintKind;
    if (constraintKind === "check" || constraintKind === "foreignKey")
      used.add("comment.constraint");
    return;
  }
  const key =
    kind === "materializedView"
      ? "comment.matview"
      : kind === "function" && object.definition.routine === "procedure"
        ? "comment.procedure"
        : kind === "table" ||
            kind === "column" ||
            kind === "index" ||
            kind === "view" ||
            kind === "function" ||
            kind === "trigger" ||
            kind === "eventTrigger" ||
            kind === "sequence" ||
            kind === "type" ||
            kind === "policy"
          ? `comment.${kind}`
          : undefined;
  if (key !== undefined) used.add(key);
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
