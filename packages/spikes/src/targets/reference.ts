/**
 * `reference` rows.
 *
 * Insert-if-missing by key. A later apply does not update or delete a row
 * that is already there (section 6.2). Classified `expand`.
 */

import { quoteIdent, quoteLiteral } from "../catalog/sql.js";
import { TargetError } from "./error.js";

/** One required row. Every key column is present. Other columns are inserted only when the row is missing. */
export type ReferenceRow = Readonly<Record<string, string | number>>;

/**
 * Rows the application requires.
 *
 * `key` names the columns that decide whether the row is already present.
 */
export type ReferenceDeclaration = {
  /** Unqualified table name in the target namespace. */
  readonly table: string;
  /** Columns that identify a row. */
  readonly key: readonly string[];
  /** Rows to insert when missing. */
  readonly rows: readonly ReferenceRow[];
};

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL that inserts each declared row when its key is absent.
 *
 * The statements contain no `UPDATE` and no `DELETE`.
 *
 * @param schema - Concrete schema
 * @param references - Declarations
 * @returns One statement per row
 */
export function referenceInserts(
  schema: string,
  references: readonly ReferenceDeclaration[],
): readonly string[] {
  const statements: string[] = [];
  for (const declaration of references) {
    assertIdent(declaration.table, "table");
    if (declaration.key.length === 0) {
      throw new TargetError("OKM1845", `reference ${declaration.table} has no key.`);
    }
    for (const column of declaration.key) assertIdent(column, "key");
    for (const row of declaration.rows) {
      const columns = Object.keys(row);
      for (const column of columns) assertIdent(column, "column");
      for (const column of declaration.key) {
        if (!Object.hasOwn(row, column)) {
          throw new TargetError(
            "OKM1845",
            `reference ${declaration.table} row is missing key ${column}.`,
          );
        }
      }
      const insertColumns = columns.map((column) => quoteIdent(column)).join(", ");
      const values = columns.map((column) => sqlValue(row[column])).join(", ");
      const where = declaration.key
        .map((column) => `${quoteIdent(column)} = ${sqlValue(row[column])}`)
        .join(" and ");
      statements.push(
        `insert into ${quoteIdent(schema)}.${quoteIdent(declaration.table)} (${insertColumns}) select ${values} where not exists (select 1 from ${quoteIdent(schema)}.${quoteIdent(declaration.table)} where ${where})`,
      );
    }
  }
  return statements;
}

function assertIdent(name: string, kind: string): void {
  if (!IDENT.test(name))
    throw new TargetError("OKM1120", `reference ${kind} ${name} is not an identifier.`);
}

function sqlValue(value: string | number | undefined): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TargetError("OKM1845", "reference value is not finite.");
    return String(value);
  }
  if (typeof value === "string") return quoteLiteral(value);
  throw new TargetError("OKM1845", "reference value is missing.");
}
