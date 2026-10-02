/**
 * Turns a harness fixture into production `table()` and `schema()` calls.
 *
 * The type-cost project prints the same column calls this module builds.
 */

import {
  type FixtureColumn,
  type FixtureTable,
  type SchemaFixture,
} from "../packages/harness/src/fixtures.js";
import { schema, table, t, index, type AnyTable } from "../src/dialects/pg/index.js";
import { type ColumnBuilder, type ColumnFlags } from "../src/dialects/pg/column.js";

/**
 * Column builder call printed into an inferred type-cost project.
 *
 * @param table - Fixture table
 * @param column - Fixture column
 * @returns Source text such as `t.text().nullable()`
 */
export function columnCall(table: FixtureTable, column: FixtureColumn): string {
  if (column.name === "id") {
    return "t.identity()";
  }
  const foreignKey = table.foreignKeys.find((key) => key.columns.includes(column.name));
  let call = baseCall(column.type);
  if (column.nullable) {
    call += ".nullable()";
  }
  if (foreignKey !== undefined) {
    call += `.references("${foreignKey.refTable}")`;
  }
  return call;
}

/**
 * Builds the fixture with `schema()`.
 *
 * @param fixture - Harness fixture
 * @returns A compiled schema
 */
export function fixtureSchema(fixture: SchemaFixture) {
  const tables = fixture.tables.map((item) => buildTable(item));
  return schema({ tables, types: "inferred" });
}

function buildTable(item: FixtureTable): AnyTable {
  const columns: Record<string, ColumnBuilder<unknown, ColumnFlags>> = {};
  for (const column of item.columns) {
    columns[column.name] = buildColumn(item, column) as ColumnBuilder<unknown, ColumnFlags>;
  }
  const unique: Record<string, readonly string[]> = {};
  for (const entry of item.uniques) {
    unique[entry.name] = entry.columns;
  }
  const indexes = item.indexes;
  return table(item.name, columns, {
    ...(item.uniques.length > 0 ? { unique } : {}),
    ...(indexes.length > 0
      ? {
          indexes: (handles) =>
            indexes.map((entry) => {
              const cols = entry.columns.map((name) => {
                const handle = handles[name];
                if (handle === undefined) {
                  throw new Error(`Fixture index ${entry.name} names missing column ${name}.`);
                }
                return handle;
              });
              const first = cols[0];
              if (first === undefined) {
                throw new Error(`Fixture index ${entry.name} has no columns.`);
              }
              return index(first, ...cols.slice(1));
            }),
        }
      : {}),
  }) as AnyTable;
}

function buildColumn(
  item: FixtureTable,
  column: FixtureColumn,
): ColumnBuilder<unknown, ColumnFlags> {
  if (column.name === "id") {
    return t.identity() as ColumnBuilder<unknown, ColumnFlags>;
  }
  let builder = baseBuilder(column.type);
  if (column.nullable) {
    builder = builder.nullable();
  }
  const foreignKey = item.foreignKeys.find((key) => key.columns.includes(column.name));
  if (foreignKey !== undefined) {
    builder = builder.references(foreignKey.refTable);
  }
  return builder as ColumnBuilder<unknown, ColumnFlags>;
}

function baseCall(type: FixtureColumn["type"]): string {
  switch (type) {
    case "int4":
      return "t.integer()";
    case "int8":
      return "t.bigint()";
    case "text":
      return "t.text()";
    case "bool":
      return "t.boolean()";
    case "timestamptz":
      return "t.timestamptz()";
    case "uuid":
      return "t.uuid()";
    case "numeric":
      return "t.numeric()";
    case "jsonb":
      return "t.jsonb()";
    case "bytea":
      return "t.bytea()";
    case "float8":
      return "t.double()";
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

function baseBuilder(type: FixtureColumn["type"]): ColumnBuilder<unknown, ColumnFlags> {
  switch (type) {
    case "int4":
      return t.integer() as ColumnBuilder<unknown, ColumnFlags>;
    case "int8":
      return t.bigint() as ColumnBuilder<unknown, ColumnFlags>;
    case "text":
      return t.text() as ColumnBuilder<unknown, ColumnFlags>;
    case "bool":
      return t.boolean() as ColumnBuilder<unknown, ColumnFlags>;
    case "timestamptz":
      return t.timestamptz() as ColumnBuilder<unknown, ColumnFlags>;
    case "uuid":
      return t.uuid() as ColumnBuilder<unknown, ColumnFlags>;
    case "numeric":
      return t.numeric() as ColumnBuilder<unknown, ColumnFlags>;
    case "jsonb":
      return t.jsonb() as ColumnBuilder<unknown, ColumnFlags>;
    case "bytea":
      return t.bytea() as ColumnBuilder<unknown, ColumnFlags>;
    case "float8":
      return t.double() as ColumnBuilder<unknown, ColumnFlags>;
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}
