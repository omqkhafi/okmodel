/**
 * Renames and enum labels read off a built schema.
 *
 * The catalog does not store either one. `okm build` writes them beside the
 * catalog so a later plan can see what the author declared.
 */

import { ColumnBuilder } from "./column.js";
import type { AnyTable } from "./table.js";
import { snakeCase } from "./table.js";

/** A rename the author declared on a table or a column. */
export type DeclaredRename =
  | { readonly kind: "table"; readonly from: string; readonly to: string }
  | {
      readonly kind: "column";
      readonly table: string;
      readonly from: string;
      readonly to: string;
    };

/** Enum labels for one column. The schema stores the current list only. */
export type EnumSnapshot = {
  readonly table: string;
  readonly column: string;
  readonly typeName: string;
  readonly labels: readonly string[];
  readonly nullable: boolean;
};

/** Renames and enums collected from one schema. */
export type SchemaDeclarations = {
  readonly renames: readonly DeclaredRename[];
  readonly enums: readonly EnumSnapshot[];
};

/**
 * Reads declared renames and enum labels.
 *
 * SQL names follow `sqlName`, then snake_case when the schema asked for it.
 * A domain is not an enum, even when it names a type.
 *
 * @param source - Built schema
 * @returns Renames and enum snapshots, in table order
 */
export function schemaDeclarations(source: {
  readonly tables: readonly AnyTable[];
  readonly casing: "snake" | undefined;
}): SchemaDeclarations {
  const renames: DeclaredRename[] = [];
  const enums: EnumSnapshot[] = [];
  for (const item of source.tables) {
    const tableName = sqlTableName(item, source.casing);
    const renamed = tableRenamedFrom(item);
    if (renamed !== undefined) {
      renames.push({ kind: "table", from: renamed, to: tableName });
    }
    for (const [field, value] of Object.entries(item.columns)) {
      if (!(value instanceof ColumnBuilder)) continue;
      const state = value.state;
      const columnName = state.sqlName ?? sqlIdentifier(field, source.casing);
      if (state.renamedFrom !== undefined) {
        renames.push({
          kind: "column",
          table: tableName,
          from: state.renamedFrom,
          to: columnName,
        });
      }
      if (state.typeDependency !== undefined && state.domain === undefined && state.typeLabel) {
        enums.push({
          table: tableName,
          column: columnName,
          typeName: state.typeDependency,
          labels: enumLabels(state.typeLabel),
          nullable: state.nullable,
        });
      }
    }
  }
  return { renames, enums };
}

function sqlTableName(item: AnyTable, casing: "snake" | undefined): string {
  const options = item.options as { readonly sqlName?: string } | undefined;
  return options?.sqlName ?? sqlIdentifier(item.name, casing);
}

function tableRenamedFrom(item: AnyTable): string | undefined {
  const options = item.options as { readonly renamedFrom?: string } | undefined;
  return options?.renamedFrom;
}

function sqlIdentifier(name: string, casing: "snake" | undefined): string {
  return casing === "snake" ? snakeCase(name) : name;
}

function enumLabels(label: string): string[] {
  const labels: string[] = [];
  for (const part of label.split(" | ")) {
    if (part.length === 0) continue;
    const parsed: unknown = JSON.parse(part);
    if (typeof parsed === "string") labels.push(parsed);
  }
  return labels;
}
