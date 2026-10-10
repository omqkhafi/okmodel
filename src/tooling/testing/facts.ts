/**
 * What a factory needs from a compiled schema: required columns, foreign keys,
 * and which tables are tenant or global.
 *
 * A table is tenant when its predicate binds a scope, and global when
 * `global("reason")` opted it out. Composite and path use that probe.
 * `schemaPerTenant` and `databasePerTenant` are not in this version.
 */

import type { Catalog, ColumnDefinition } from "../../contracts/catalog/types.js";
import type { QuerySchema, RelationModel, TableModel } from "../../dialects/pg/model.js";
import type { ColumnTenancy } from "../../dialects/pg/tenancy.js";

/** A schema `testing()` can open. `schema()` returns this shape. */
export type TestingSchema = QuerySchema & {
  readonly catalog: Catalog;
};

/** One foreign key, SQL names, child columns aligned with the target columns. */
export type ForeignKey = {
  readonly columns: readonly string[];
  readonly target: string;
  readonly targetColumns: readonly string[];
};

/** One column, with the catalog facts the factory uses to fill a default. */
export type ColumnFacts = {
  readonly field: string;
  readonly sql: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly databaseDefault: boolean;
  readonly identity: boolean;
  readonly generated: boolean;
  readonly guarded: boolean;
  readonly writable: boolean;
  readonly fill: boolean;
  readonly accepts: readonly string[] | undefined;
  readonly encode: (value: unknown) => string;
};

/** One table. */
export type TableFacts = {
  readonly name: string;
  readonly sql: string;
  readonly primary: readonly string[];
  readonly columns: readonly ColumnFacts[];
  readonly relations: readonly RelationModel[];
  readonly foreignKeys: readonly ForeignKey[];
  /** Column tenancy applies a predicate. */
  readonly tenant: boolean;
  /** `global("reason")`. Absent on a tenant table and on a schema with no tenancy. */
  readonly globalReason: string | undefined;
};

/**
 * Scope value used to ask a tenancy object whether a table is tenant.
 *
 * A test tenancy can recognise this probe and still omit the predicate on a
 * real query. That is how the isolation check is shown to fail.
 */
export const tenantProbe = "00000000-0000-4000-8000-000000000001";

/**
 * Reads every table in declaration order.
 *
 * Views and materialized views are in the query model too. They have no rows
 * of their own to insert, so they are left out.
 *
 * @param schema - Compiled schema
 * @returns One facts object per table
 */
export function readFacts(schema: TestingSchema): readonly TableFacts[] {
  const foreign = foreignKeys(schema.catalog);
  const tables = new Set<string>();
  for (const object of schema.catalog.objects) {
    if (object.kind === "table") tables.add(object.identity.name);
  }
  const facts: TableFacts[] = [];
  for (const name of Object.keys(schema.model)) {
    const model = schema.model[name];
    if (model === undefined || !tables.has(model.sql)) continue;
    const keys = foreign.get(model.sql) ?? [];
    facts.push({
      name,
      sql: model.sql,
      primary: model.primary,
      columns: columnsOf(model, schema.catalog),
      relations: model.relations,
      foreignKeys: keys,
      tenant: isTenant(schema.tenancy, model),
      globalReason: globalReason(schema.tenancy, name),
    });
  }
  return facts;
}

/**
 * A column the factory must set when the definition and the overrides omit it.
 *
 * Nullable, a database default, identity, a generated expression, a client
 * fill, and a guarded column are left to the database or the scope (D199).
 *
 * @param column - Column facts
 * @returns Whether the factory fills it
 */
export function isRequired(column: ColumnFacts): boolean {
  if (!column.writable || column.guarded || column.fill) return false;
  if (column.nullable || column.databaseDefault || column.identity || column.generated) {
    return false;
  }
  return true;
}

function columnsOf(model: TableModel, catalog: Catalog): readonly ColumnFacts[] {
  const bySql = new Map<string, ColumnDefinition>();
  for (const object of catalog.objects) {
    if (object.kind !== "column") continue;
    if (object.identity.parent.name !== model.sql) continue;
    bySql.set(object.identity.name, object.definition);
  }
  return model.columns.map((column) => {
    const definition = bySql.get(column.sql);
    return {
      field: column.field,
      sql: column.sql,
      dataType: column.dataType,
      nullable: definition?.nullable === true,
      databaseDefault: definition?.defaultExpression !== undefined,
      identity: definition?.identity !== undefined,
      generated: definition?.generated !== undefined,
      guarded: column.guarded,
      writable: column.writable,
      fill: column.fill !== undefined,
      accepts: column.accepts,
      encode: column.encode,
    };
  });
}

function foreignKeys(catalog: Catalog): ReadonlyMap<string, readonly ForeignKey[]> {
  const map = new Map<string, ForeignKey[]>();
  for (const object of catalog.objects) {
    if (object.kind !== "constraint") continue;
    if (object.definition.constraintKind !== "foreignKey") continue;
    const references = object.definition.references;
    if (references === undefined) continue;
    const table = object.identity.parent.name;
    const list = map.get(table);
    const key: ForeignKey = {
      columns: object.definition.columns,
      target: references.parent.name,
      targetColumns: references.columns,
    };
    if (list === undefined) map.set(table, [key]);
    else list.push(key);
  }
  return map;
}

function globalReason(tenancy: ColumnTenancy | undefined, table: string): string | undefined {
  if (tenancy === undefined) return undefined;
  for (const rule of tenancy.rules(table, undefined, undefined)) {
    if (rule.contribution.startsWith("global ")) return rule.contribution.slice("global ".length);
  }
  return undefined;
}

function isTenant(tenancy: ColumnTenancy | undefined, model: TableModel): boolean {
  if (tenancy === undefined) return false;
  if (globalReason(tenancy, model.name) !== undefined) return false;
  const key = model.columns.find((column) => column.field === tenancy.key);
  try {
    return (
      tenancy.predicate({
        table: model.name,
        fieldSql: (field) => model.columns.find((column) => column.field === field)?.sql,
        encode: key?.encode,
        alias: "t",
        appended: false,
        scope: { value: tenantProbe },
        sink: { text() {}, param() {}, mark() {} },
      }) === true
    );
  } catch {
    return false;
  }
}
