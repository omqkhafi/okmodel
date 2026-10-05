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
  ColumnObject,
  ConstraintObject,
  IndexObject,
  SequenceObject,
  TableObject,
  TypeObject,
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
  for (const object of ordered) {
    if (object.kind !== "type" || object.owner === "ignored") continue;
    const sql = createObjectSql(object, schema);
    if (sql !== undefined) statements.push(sql);
  }
  for (const object of ordered) {
    if (object.kind === "type" || object.owner === "ignored") continue;
    const key = identityKey(object.identity);
    if (object.kind === "table") {
      statements.push(createTableSql(object, source, schema));
      continue;
    }
    if (folded.has(key)) continue;
    const sql = createObjectSql(object, schema);
    if (sql !== undefined) statements.push(sql);
  }
  return statements;
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
    case "table":
      return undefined;
    default:
      return undefined;
  }
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
    lines.push(`primary key (${cols})`);
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

function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}
