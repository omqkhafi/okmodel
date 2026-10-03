/**
 * Renames read off a built schema.
 *
 * Enum labels are a catalog type, not a side file. `renamedFrom` stays on the
 * schema because a rename is an author declaration, not a stored object.
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

/** Renames collected from one schema. */
export type SchemaDeclarations = {
  readonly renames: readonly DeclaredRename[];
};

/**
 * Reads declared renames.
 *
 * SQL names follow `sqlName`, then snake_case when the schema asked for it.
 *
 * @param source - Built schema
 * @returns Rename declarations, in table order
 */
export function schemaDeclarations(source: {
  readonly tables: readonly AnyTable[];
  readonly casing: "snake" | undefined;
}): SchemaDeclarations {
  const renames: DeclaredRename[] = [];
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
    }
  }
  return { renames };
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
