/**
 * Postgres DDL for a catalog.
 *
 * Planning and scratch comparison both render through here, so a statement
 * has one spelling.
 */

import { isDomain } from "../../contracts/catalog/enum.js";
import { fitIdentifier } from "../../contracts/catalog/identifier.js";
import { identityKey } from "../../contracts/catalog/identity.js";
import { creationOrder } from "../../contracts/catalog/document.js";
import type {
  Catalog,
  CatalogObject,
  ObjectRef,
  ColumnObject,
  ConstraintObject,
  FunctionObject,
  IndexObject,
  MaterializedViewObject,
  SequenceObject,
  TableObject,
  TriggerObject,
  TypeObject,
  ViewObject,
} from "../../contracts/catalog/types.js";
import { quoteLiteral } from "./quote.js";

/**
 * Quotes one identifier.
 *
 * @param name - Identifier already checked by the catalog
 * @returns A double-quoted identifier
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Renders a catalog as create statements in dependency order.
 *
 * Columns and primary keys are folded into `CREATE TABLE`. An identity
 * sequence is created by the column, not as its own statement.
 *
 * @param source - Catalog to apply
 * @param schema - Concrete schema name
 * @returns SQL statements
 */
export function renderCatalog(source: Catalog, schema: string): readonly string[] {
  const folded = foldedKeys(source);
  const statements: string[] = [];
  const ordered = creationOrder(source);
  const created = uniqueBeforeForeignKey(ordered);
  for (const object of ordered) {
    if (object.kind !== "type" || object.owner === "ignored") continue;
    const sql = createObjectSql(object, schema);
    if (sql !== undefined) statements.push(sql);
  }
  for (const object of created) {
    if (
      object.kind === "type" ||
      object.kind === "function" ||
      object.kind === "trigger" ||
      object.kind === "view" ||
      object.kind === "materializedView" ||
      ownedByView(object)
    ) {
      continue;
    }
    if (object.owner === "ignored") continue;
    const key = identityKey(object.identity);
    if (object.kind === "table") {
      statements.push(createTableSql(object, source, schema));
      continue;
    }
    if (folded.has(key)) continue;
    const sql = createObjectSql(object, schema);
    if (sql !== undefined) statements.push(sql);
  }
  for (const kind of ["function", "trigger"] as const) {
    for (const object of ordered) {
      if (object.kind !== kind || object.owner === "ignored") continue;
      const sql = createObjectSql(object, schema);
      if (sql !== undefined) statements.push(sql);
    }
  }
  for (const kind of ["view", "materializedView"] as const) {
    for (const object of ordered) {
      if (object.kind !== kind || object.owner === "ignored") continue;
      const sql = createObjectSql(object, schema);
      if (sql !== undefined) statements.push(sql);
    }
  }
  for (const object of ordered) {
    if (!ownedByView(object) || object.owner === "ignored") continue;
    const sql = createObjectSql(object, schema);
    if (sql !== undefined) statements.push(sql);
  }
  return statements;
}

/**
 * Pulls a unique constraint in front of a foreign key that references it.
 *
 * The primary key is created with the table. A foreign key aimed at another
 * unique has to wait for that unique. Create order ties those two by name, so
 * the foreign key can otherwise come first.
 *
 * @param objects - Create order
 * @returns The same objects, with those uniques moved forward
 */
function uniqueBeforeForeignKey(objects: readonly CatalogObject[]): readonly CatalogObject[] {
  const uniques = objects.filter(
    (object): object is ConstraintObject =>
      object.kind === "constraint" && object.definition.constraintKind === "unique",
  );
  if (uniques.length === 0) return objects;
  const emitted = new Set<CatalogObject>();
  const result: CatalogObject[] = [];
  for (const object of objects) {
    if (emitted.has(object)) continue;
    if (object.kind === "constraint" && object.definition.constraintKind === "foreignKey") {
      const target = object.definition.references;
      if (target !== undefined && !coveredByPrimary(objects, target.parent, target.columns)) {
        const columns = target.columns.join("\0");
        for (const unique of uniques) {
          if (emitted.has(unique)) continue;
          if (!sameRef(unique.identity.parent, target.parent)) continue;
          if (unique.definition.columns.join("\0") !== columns) continue;
          result.push(unique);
          emitted.add(unique);
        }
      }
    }
    result.push(object);
    emitted.add(object);
  }
  return result;
}

function coveredByPrimary(
  objects: readonly CatalogObject[],
  parent: ObjectRef,
  columns: readonly string[],
): boolean {
  const key = columns.join("\0");
  return objects.some(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "primaryKey" &&
      sameRef(object.identity.parent, parent) &&
      object.definition.columns.join("\0") === key,
  );
}

function sameRef(left: ObjectRef, right: ObjectRef): boolean {
  if (left.name !== right.name || left.namespace.form !== right.namespace.form) return false;
  if (left.namespace.form === "static" && right.namespace.form === "static") {
    return left.namespace.name === right.namespace.name;
  }
  return left.namespace.form === "template" && right.namespace.form === "template"
    ? left.namespace.pattern === right.namespace.pattern
    : false;
}

/**
 * Reports whether an index belongs to a view or a materialized view.
 *
 * Those indexes are created after the view, not with the tables.
 *
 * @param object - Catalog object
 * @returns `true` when an index edge points at a view
 */
export function ownedByView(object: CatalogObject): boolean {
  if (object.kind !== "index") return false;
  return object.dependencies.some(
    (edge) => edge.target.kind === "view" || edge.target.kind === "materializedView",
  );
}

/**
 * SQL that drops one object.
 *
 * A column or constraint drop is an `ALTER TABLE`. Dropping a table does not
 * use `CASCADE`.
 *
 * @param object - Object to drop
 * @param schema - Concrete schema name
 * @returns The statement, or `undefined` when the object is not dropped alone
 */
export function dropObjectSql(object: CatalogObject, schema: string): string | undefined {
  if (object.owner === "ignored") return undefined;
  switch (object.kind) {
    case "table":
      return `drop table ${qualify(schema, object.identity.name)}`;
    case "column":
      return `alter table ${qualify(schema, object.identity.parent.name)} drop column ${quoteIdent(object.identity.name)}`;
    case "index":
      return `drop index ${qualify(schema, object.identity.name)}`;
    case "constraint":
      return `alter table ${qualify(schema, object.identity.parent.name)} drop constraint ${quoteIdent(object.identity.name)}`;
    case "sequence":
      return `drop sequence ${qualify(schema, object.identity.name)}`;
    case "type":
      return `drop type ${qualify(schema, object.identity.name)}`;
    case "extension":
      return `drop extension ${quoteIdent(object.identity.name)}`;
    case "function":
      return `drop function ${qualify(schema, object.identity.name)}(${object.identity.argTypes.join(", ")})`;
    case "trigger":
      return `drop trigger ${quoteIdent(object.identity.name)} on ${qualify(schema, object.identity.parent.name)}`;
    case "view":
      return `drop view ${qualify(schema, object.identity.name)}`;
    case "materializedView":
      return `drop materialized view ${qualify(schema, object.identity.name)}`;
    default:
      return undefined;
  }
}

/**
 * SQL that creates one object that is not folded into a new table.
 *
 * @param object - Object to create
 * @param schema - Concrete schema name
 * @returns The statement
 */
export function createObjectSql(object: CatalogObject, schema: string): string | undefined {
  switch (object.kind) {
    case "column":
      return `alter table ${qualify(schema, object.identity.parent.name)} add column ${columnSql(object)}`;
    case "index":
      return createIndexSql(object, schema);
    case "constraint":
      return `alter table ${qualify(schema, object.identity.parent.name)} add constraint ${quoteIdent(object.identity.name)} ${constraintBody(object, schema)}`;
    case "sequence":
      return createSequenceSql(object, schema);
    case "type":
      return createTypeSql(object, schema);
    case "extension":
      return createExtensionSql(object);
    case "function":
      return functionSql(object, schema, false);
    case "trigger":
      return triggerSql(object, schema);
    case "view":
      return viewSql(object, schema, false);
    case "materializedView":
      return materializedViewSql(object, schema);
    case "table":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * `CREATE` or `CREATE OR REPLACE` for one function.
 *
 * A compatible signature change uses replace. The body is the stored source,
 * or the `BEGIN ATOMIC` block when the function is atomic.
 *
 * @param object - Function to render
 * @param schema - Concrete schema name
 * @param replace - `CREATE OR REPLACE` when true
 * @returns The statement
 */
export function functionSql(object: FunctionObject, schema: string, replace: boolean): string {
  const definition = object.definition;
  const args = definition.arguments
    .map((argument) => `${quoteIdent(argument.name)} ${argument.type}`)
    .join(", ");
  const head = `${replace ? "create or replace" : "create"} function ${qualify(schema, object.identity.name)}(${args})`;
  const security = ` security ${definition.security}`;
  const path =
    definition.searchPath === undefined ? "" : ` set search_path to ${definition.searchPath}`;
  const tail = `returns ${definition.returns} language ${definition.language} ${definition.volatility}${security}${path}`;
  if (definition.atomic) return `${head} ${tail} ${definition.body}`;
  return `${head} ${tail} as ${dollarQuote(definition.body)}`;
}

/**
 * `CREATE` or `CREATE OR REPLACE` for one view.
 *
 * Appending columns is replace. The query is the stored text.
 *
 * @param object - View to render
 * @param schema - Concrete schema name
 * @param replace - `CREATE OR REPLACE` when true
 * @returns The statement
 */
export function viewSql(object: ViewObject, schema: string, replace: boolean): string {
  const verb = replace ? "create or replace view" : "create view";
  return `${verb} ${qualify(schema, object.identity.name)} as ${object.definition.query}`;
}

/**
 * `CREATE MATERIALIZED VIEW ... WITH NO DATA`.
 *
 * Populate is a separate planned step. This statement does not read the table.
 *
 * @param object - Materialized view to render
 * @param schema - Concrete schema name
 * @returns The statement
 */
export function materializedViewSql(object: MaterializedViewObject, schema: string): string {
  return `create materialized view ${qualify(schema, object.identity.name)} as ${object.definition.query} with no data`;
}

/**
 * `REFRESH MATERIALIZED VIEW`.
 *
 * A view created `WITH NO DATA` is empty, and Postgres rejects `CONCURRENTLY`
 * until it has been populated once. The plan's populate step passes
 * `populated: false`. A later refresh uses `CONCURRENTLY` when the declaration
 * asked for it.
 *
 * @param object - Materialized view to refresh
 * @param schema - Concrete schema name
 * @param populated - `true` when the view already holds rows
 * @returns The statement
 */
export function refreshMaterializedViewSql(
  object: MaterializedViewObject,
  schema: string,
  populated = false,
): string {
  const concurrently =
    populated && object.definition.refresh === "concurrently" ? " concurrently" : "";
  return `refresh materialized view${concurrently} ${qualify(schema, object.identity.name)}`;
}

function triggerSql(object: TriggerObject, schema: string): string {
  const definition = object.definition;
  const timing = definition.timing === "instead" ? "instead of" : definition.timing;
  const events = definition.events
    .map((event) => {
      if (event !== "update" || definition.updateOf === undefined) return event;
      return `update of ${definition.updateOf.map((column) => quoteIdent(column)).join(", ")}`;
    })
    .join(" or ");
  const when = definition.when === undefined ? "" : ` when (${definition.when})`;
  const args = definition.calls.argTypes.join(", ");
  const fn = `${qualify(schema, definition.calls.name)}(${args})`;
  return `create trigger ${quoteIdent(object.identity.name)} ${timing} ${events} on ${qualify(schema, object.identity.parent.name)} for each ${definition.level}${when} execute function ${fn}`;
}

function dollarQuote(body: string): string {
  let tag = "okm";
  while (body.includes(`$${tag}$`)) tag = `${tag}_`;
  return `$${tag}$${body}$${tag}$`;
}

/**
 * In-place column changes: type, nullability, and default.
 *
 * @param before - Column already applied
 * @param after - Column the plan must reach
 * @param schema - Concrete schema name
 * @returns Statements, empty when the definitions match
 */
export function alterColumnSql(
  before: ColumnObject,
  after: ColumnObject,
  schema: string,
): readonly string[] {
  const statements: string[] = [];
  const table = qualify(schema, after.identity.parent.name);
  const name = quoteIdent(after.identity.name);
  const typeChanged = before.definition.dataType !== after.definition.dataType;
  const collationChanged = before.definition.collation !== after.definition.collation;
  if (typeChanged || collationChanged) {
    const using = typeChanged ? ` using ${name}::${after.definition.dataType}` : "";
    statements.push(
      `alter table ${table} alter column ${name} set data type ${after.definition.dataType}${collateSql(after.definition.collation)}${using}`,
    );
  }
  if (before.definition.nullable !== after.definition.nullable) {
    statements.push(
      `alter table ${table} alter column ${name} ${after.definition.nullable ? "drop not null" : "set not null"}`,
    );
  }
  if (before.definition.defaultExpression !== after.definition.defaultExpression) {
    statements.push(
      after.definition.defaultExpression === undefined
        ? `alter table ${table} alter column ${name} drop default`
        : `alter table ${table} alter column ${name} set default ${after.definition.defaultExpression}`,
    );
  }
  return statements;
}

/**
 * Reports whether a sequence is the one an identity column creates.
 *
 * @param sequence - Sequence object
 * @param source - Catalog that may own it
 * @returns `true` when a column depends on the sequence and declares identity
 */
export function identitySequence(sequence: SequenceObject, source: Catalog): boolean {
  const key = identityKey(sequence.identity);
  return source.objects.some((object) => {
    if (object.kind !== "column" || object.definition.identity === undefined) return false;
    return object.dependencies.some((edge) => identityKey(edge.target) === key);
  });
}

function foldedKeys(source: Catalog): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const object of source.objects) {
    if (object.kind === "column") keys.add(identityKey(object.identity));
    if (object.kind === "constraint" && object.definition.constraintKind === "primaryKey") {
      keys.add(identityKey(object.identity));
    }
    if (object.kind === "sequence" && identitySequence(object, source)) {
      keys.add(identityKey(object.identity));
    }
  }
  return keys;
}

/**
 * `CREATE TABLE` for one table, including its columns and primary key.
 *
 * @param tableObject - Table to create
 * @param source - Catalog that holds the columns
 * @param schema - Concrete schema name
 * @returns The statement
 */
export function createTableSql(tableObject: TableObject, source: Catalog, schema: string): string {
  const parent = tableObject.identity.name;
  const columns = source.objects.filter(
    (object): object is ColumnObject =>
      object.kind === "column" && object.identity.parent.name === parent,
  );
  const primary = source.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "primaryKey" &&
      object.identity.parent.name === parent,
  );
  const lines = columns.map((column) => columnSql(column));
  if (primary !== undefined) {
    const cols = primary.definition.columns.map((name) => quoteIdent(name)).join(", ");
    lines.push(`constraint ${quoteIdent(primary.identity.name)} primary key (${cols})`);
  }
  const partition = tableObject.definition.partition;
  const tail =
    partition === undefined
      ? ""
      : ` partition by ${partition.method} (${partition.columns.map((name) => quoteIdent(name)).join(", ")})`;
  return `create table ${qualify(schema, parent)} (\n  ${lines.join(",\n  ")}\n)${tail}`;
}

function collateSql(collation: string | undefined): string {
  if (collation === undefined) return "";
  return ` collate ${quoteIdent(collation)}`;
}

function createTypeSql(object: TypeObject, schema: string): string {
  if (isDomain(object.definition)) {
    const name = object.identity.name;
    const constraint = quoteIdent(fitIdentifier(`${name}_check`));
    return `create domain ${qualify(schema, name)} as ${object.definition.base} constraint ${constraint} check (${object.definition.check})`;
  }
  const labels = object.definition.labels.map((label) => quoteLiteral(label)).join(", ");
  return `create type ${qualify(schema, object.identity.name)} as enum (${labels})`;
}

function columnSql(column: ColumnObject): string {
  const definition = column.definition;
  let sql = `${quoteIdent(column.identity.name)} ${definition.dataType}${collateSql(definition.collation)}`;
  if (definition.identity !== undefined) {
    sql += definition.identity.always
      ? " generated always as identity"
      : " generated by default as identity";
  } else if (definition.generated !== undefined) {
    sql += ` generated always as (${definition.generated.expression}) stored`;
  }
  if (!definition.nullable) sql += " not null";
  if (definition.defaultExpression !== undefined) sql += ` default ${definition.defaultExpression}`;
  return sql;
}

function createIndexSql(object: IndexObject, schema: string): string {
  const unique = object.definition.unique ? "unique " : "";
  const where =
    object.definition.predicate === undefined ? "" : ` where ${object.definition.predicate}`;
  const expression = object.definition.expression;
  const name = quoteIdent(object.identity.name);
  const on = qualify(schema, object.identity.parent.name);
  if (expression !== undefined && expression.startsWith("using ")) {
    return `create ${unique}index ${name} on ${on} ${expression}${where}`;
  }
  const target =
    expression !== undefined
      ? `(${expression})`
      : object.definition.columns.map((column) => quoteIdent(column)).join(", ");
  return `create ${unique}index ${name} on ${on} (${target})${where}`;
}

function createExtensionSql(object: CatalogObject & { readonly kind: "extension" }): string {
  const version = object.definition.version;
  const pinned =
    version !== undefined && /^\d+(?:\.\d+)*$/.test(version)
      ? ` version ${quoteLiteral(version)}`
      : "";
  return `create extension ${quoteIdent(object.identity.name)} schema ${quoteIdent(object.definition.schema)}${pinned}`;
}

function createSequenceSql(object: SequenceObject, schema: string): string {
  const definition = object.definition;
  const cycle = definition.cycle ? " cycle" : "";
  return `create sequence ${qualify(schema, object.identity.name)} as ${definition.dataType} start ${definition.start} increment ${definition.increment}${cycle}`;
}

function constraintBody(object: ConstraintObject, schema: string): string {
  const definition = object.definition;
  const columns = definition.columns.map((name) => quoteIdent(name)).join(", ");
  switch (definition.constraintKind) {
    case "primaryKey":
      return `primary key (${columns})`;
    case "unique": {
      const nulls = definition.nullsNotDistinct ? " nulls not distinct" : "";
      return `unique${nulls} (${columns})${deferClause(definition)}`;
    }
    case "check":
      return `check (${definition.expression ?? "true"})${deferClause(definition)}`;
    case "foreignKey": {
      const references = definition.references;
      const target =
        references === undefined
          ? ""
          : ` references ${qualify(schema, references.parent.name)} (${references.columns.map((name) => quoteIdent(name)).join(", ")})`;
      const onDelete =
        references?.onDelete === undefined ? "" : ` on delete ${references.onDelete}`;
      const onUpdate =
        references?.onUpdate === undefined ? "" : ` on update ${references.onUpdate}`;
      return `foreign key (${columns})${target}${onDelete}${onUpdate}${deferClause(definition)}`;
    }
    default:
      return definition.constraintKind;
  }
}

function deferClause(definition: ConstraintObject["definition"]): string {
  if (!definition.deferrable) return "";
  return ` deferrable initially ${definition.initially}`;
}

/**
 * Quotes a schema-qualified name.
 *
 * @param schema - Concrete schema name
 * @param name - Object name
 * @returns `"schema"."name"`
 */
export function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}
