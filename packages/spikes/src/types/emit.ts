/**
 * Writes declaration text for fixture row, insert, and update types.
 *
 * This is the build step the emitted strategy measures. It does not call `tsc`.
 */

import { type SchemaFixture } from "@okmodel/harness/fixtures";

import { type ColumnPlan, type WriteMode, planTable } from "./plan.js";

/**
 * Emits `.d.ts` source for every table in a fixture.
 *
 * @param fixture - Harness fixture, seed and size included in the header
 * @param options - Set `brandIds` false to match an unbranded inferred project
 * @returns Module source
 */
export function emitDeclarations(
  fixture: SchemaFixture,
  options?: { readonly brandIds?: boolean },
): string {
  const brandIds = options?.brandIds ?? true;
  const lines: string[] = [
    "/**",
    ` * Emitted row types for seed ${String(fixture.seed)}, ${String(fixture.tableCount)} tables.`,
    " * Written by the types spike. Not a TypeScript language-service hover.",
    " */",
    "",
    'export type TableId<TName extends string> = string & { readonly "~table": TName };',
    "",
  ];
  const rowNames: string[] = [];
  const insertNames: string[] = [];
  const updateNames: string[] = [];
  for (const table of fixture.tables) {
    const columns = planTable(table, { brandIds });
    const rowName = `Row_${table.name}`;
    const insertName = `Insert_${table.name}`;
    const updateName = `Update_${table.name}`;
    rowNames.push(`${table.name}: ${rowName}`);
    insertNames.push(`${table.name}: ${insertName}`);
    updateNames.push(`${table.name}: ${updateName}`);
    lines.push(`export interface ${rowName} {`);
    lines.push(fields(columns, "row"));
    lines.push("}", "");
    lines.push(`export interface ${insertName} {`);
    lines.push(fields(columns, "insert"));
    lines.push("}", "");
    lines.push(`export interface ${updateName} {`);
    lines.push(fields(columns, "update"));
    lines.push("}", "");
  }
  lines.push("export interface Rows {");
  lines.push(members(rowNames));
  lines.push("}", "");
  lines.push("export interface Inserts {");
  lines.push(members(insertNames));
  lines.push("}", "");
  lines.push("export interface Updates {");
  lines.push(members(updateNames));
  lines.push("}", "");
  lines.push("export type Row<N extends keyof Rows> = Rows[N];", "");
  lines.push("export type Insert<N extends keyof Inserts> = Inserts[N];", "");
  lines.push("export type Update<N extends keyof Updates> = Updates[N];", "");
  return lines.join("\n");
}

function members(entries: readonly string[]): string {
  return entries.map((entry) => `  readonly ${entry};`).join("\n");
}

function fields(columns: readonly ColumnPlan[], kind: "row" | "insert" | "update"): string {
  const printed: string[] = [];
  for (const column of columns) {
    const mode = kind === "row" ? "required" : kind === "insert" ? column.insert : column.update;
    if (mode === "omit") {
      continue;
    }
    printed.push(`  ${field(column, mode)};`);
  }
  return printed.join("\n");
}

function field(column: ColumnPlan, mode: WriteMode): string {
  const optional = mode === "optional" ? "?" : "";
  const nullish = column.nullable ? " | null" : "";
  return `readonly ${column.name}${optional}: ${column.valueType}${nullish}`;
}
