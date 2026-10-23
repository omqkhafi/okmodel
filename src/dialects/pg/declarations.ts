/**
 * Renames read off a built schema.
 *
 * Enum labels are a catalog type, not a side file. `renamedFrom` stays on the
 * schema because a rename is an author declaration, not a stored object.
 */

import type { DeclaredRename } from "../../contracts/catalog/rename.js";
import { ColumnBuilder } from "./column.js";
import { type Casing, namesFor } from "./casing.js";
import type { AnyTable } from "./table.js";

export type { DeclaredRename };

/** Renames collected from one schema. */
export type SchemaDeclarations = {
  readonly renames: readonly DeclaredRename[];
};

/**
 * Reads declared renames.
 *
 * SQL names follow `sqlName`, then the schema casing.
 *
 * @param source - Built schema
 * @returns Rename declarations, in table order
 */
export function schemaDeclarations(source: {
  readonly tables: readonly AnyTable[];
  readonly casing: Casing | undefined;
}): SchemaDeclarations {
  const names = namesFor(source.casing);
  const renames: DeclaredRename[] = [];
  for (const item of source.tables) {
    const tableName = names.table(item);
    const renamed = tableRenamedFrom(item);
    if (renamed !== undefined) {
      renames.push({ kind: "table", from: renamed, to: tableName });
    }
    for (const [field, value] of Object.entries(item.columns)) {
      if (!(value instanceof ColumnBuilder)) continue;
      const state = value.state;
      const columnName = state.sqlName ?? names.name(field);
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

function tableRenamedFrom(item: AnyTable): string | undefined {
  const options = item.options as { readonly renamedFrom?: string } | undefined;
  return options?.renamedFrom;
}
