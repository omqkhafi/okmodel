/**
 * TypeScript projects that instantiate equality filters and tagged operators
 * on a harness fixture.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type FixtureColumnType, type SchemaFixture } from "@okmodel/harness/fixtures";

import {
  specifier,
  writeEmptyProject,
  writeInferredProject,
  writeProjectConfig,
} from "../types/projects.js";

const safetyRoot = import.meta.dir;
const typesRoot = join(import.meta.dir, "../types");

/** Which filter type the probe instantiates. */
export type OperatorStrategy = "equality" | "tagged";

/**
 * Writes an empty project, the compiler baseline.
 *
 * @param dir - Project directory
 */
export function writeOperatorBaseline(dir: string): void {
  writeEmptyProject(dir);
}

/**
 * Writes fixture column types and a mapped filter type.
 *
 * @param dir - Project directory
 * @param fixture - Harness fixture
 * @param strategy - Equality baseline or tagged operators
 */
export function writeOperatorProject(
  dir: string,
  fixture: SchemaFixture,
  strategy: OperatorStrategy,
): void {
  mkdirSync(dir, { recursive: true });
  const typeName = strategy === "equality" ? "EqWhere" : "Where";
  const file = strategy === "equality" ? "eq-where.ts" : "operators.ts";
  const imported = specifier(dir, join(safetyRoot, file));
  const tables = fixture.tables
    .map((table) => {
      const fields = table.columns
        .map((column) => `    readonly ${column.name}: ${valueType(column.type)};`)
        .join("\n");
      return `  readonly ${table.name}: {\n${fields}\n  };`;
    })
    .join("\n");
  writeFileSync(
    join(dir, "probe.ts"),
    [
      `import type { ${typeName} } from "${imported}";`,
      "",
      "type Apply<T> = { [K in keyof T]-?: T[K] }[keyof T];",
      "",
      "export type Tables = {",
      tables,
      "};",
      "",
      "export type Probe = {",
      `  readonly [K in keyof Tables]: Apply<${typeName}<Tables[K]>>;`,
      "};",
      "",
    ].join("\n"),
  );
  writeProjectConfig(dir, ["probe.ts"]);
}

/**
 * Writes the inferred 200-table schema plus a mapped filter type over each row.
 *
 * @param dir - Project directory
 * @param fixture - Harness fixture
 * @param strategy - Equality baseline or tagged operators
 */
export function writeInferredOperatorProject(
  dir: string,
  fixture: SchemaFixture,
  strategy: OperatorStrategy,
): void {
  writeInferredProject(dir, fixture);
  const typeName = strategy === "equality" ? "EqWhere" : "Where";
  const file = strategy === "equality" ? "eq-where.ts" : "operators.ts";
  const operators = specifier(dir, join(safetyRoot, file));
  const schema = specifier(dir, join(typesRoot, "schema.ts"));
  writeFileSync(
    join(dir, "probe.ts"),
    [
      'import { appSchema } from "./tables.js";',
      `import type { ${typeName} } from "${operators}";`,
      `import type { Row, TableName } from "${schema}";`,
      "",
      "type Names = TableName<typeof appSchema>;",
      "type Apply<T> = { [K in keyof T]-?: T[K] }[keyof T];",
      "export type Probe = {",
      `  readonly [K in Names]: Apply<${typeName}<Row<K, typeof appSchema>>>;`,
      "};",
      "",
    ].join("\n"),
  );
  writeProjectConfig(dir, ["probe.ts", "tables.ts"]);
}

function valueType(type: FixtureColumnType): string {
  switch (type) {
    case "int4":
    case "float8":
      return "number";
    case "bool":
      return "boolean";
    case "jsonb":
      return "{ readonly [key: string]: unknown }";
    case "int8":
    case "text":
    case "timestamptz":
    case "uuid":
    case "numeric":
    case "bytea":
      return "string";
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}
