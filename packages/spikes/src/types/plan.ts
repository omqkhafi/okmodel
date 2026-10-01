/**
 * Maps a harness fixture column onto the spike builders and the emitted types.
 *
 * Both strategies call this so they describe the same row.
 */

import { type FixtureColumn, type FixtureTable } from "@okmodel/harness/fixtures";

/** How a column appears on insert and update. */
export type WriteMode = "omit" | "optional" | "required";

/** One column, ready to print as a builder call or a declaration field. */
export type ColumnPlan = {
  readonly name: string;
  /** Builder expression, such as `t.text().nullable()`. */
  readonly expression: string;
  /** TypeScript type printed in an emitted declaration, without null. */
  readonly valueType: string;
  readonly nullable: boolean;
  readonly insert: WriteMode;
  readonly update: WriteMode;
};

/**
 * Plans every column of a fixture table.
 *
 * The primary key uses `t.id()` unless branding is turned off.
 *
 * @param table - Fixture table
 * @param options - Set `brandIds` false to emit `t.bigint()` for `id`
 * @returns Columns in fixture order
 */
export function planTable(
  table: FixtureTable,
  options?: { readonly brandIds?: boolean },
): readonly ColumnPlan[] {
  const brandIds = options?.brandIds ?? true;
  return table.columns.map((column) => planColumn(table, column, brandIds));
}

function planColumn(table: FixtureTable, column: FixtureColumn, brandIds: boolean): ColumnPlan {
  const foreignKey = table.foreignKeys.find((key) => key.columns.includes(column.name));
  if (column.name === "id" && brandIds) {
    return {
      name: column.name,
      expression: "t.id()",
      valueType: `TableId<"${table.name}">`,
      nullable: false,
      insert: "omit",
      update: "omit",
    };
  }

  const base = baseExpression(column.type);
  const reference = foreignKey === undefined ? "" : `.references("${foreignKey.refTable}")`;
  const nullable = column.nullable ? ".nullable()" : "";
  const optional = column.nullable;
  return {
    name: column.name,
    expression: `${base}${nullable}${reference}`,
    valueType: valueType(column.type),
    nullable: column.nullable,
    insert: optional ? "optional" : "required",
    update: "optional",
  };
}

function baseExpression(type: FixtureColumn["type"]): string {
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
      return "t.json<{ readonly [key: string]: unknown }>()";
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

function valueType(type: FixtureColumn["type"]): string {
  switch (type) {
    case "int4":
    case "float8":
      return "number";
    case "bool":
      return "boolean";
    case "bytea":
      return "Uint8Array";
    case "jsonb":
      return "{ readonly [key: string]: unknown }";
    case "int8":
    case "text":
    case "timestamptz":
    case "uuid":
    case "numeric":
      return "string";
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}
