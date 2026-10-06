/**
 * Reference rows declared on a table (D198).
 *
 * The rows live on the schema, not as a catalog diff. Apply inserts a row
 * when its key is missing and does not update or delete. The statements are
 * not migration steps, so OKM1542 does not see them.
 */

import type { Catalog } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import { qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import { snakeCase, type AnyTable, type ReferenceOption } from "../../dialects/pg/table.js";

/** One value a reference row may store. */
export type ReferenceValue = string | number | boolean | null;

/** One table's reference declaration, in SQL names. */
export type ReferenceTable = {
  readonly table: string;
  readonly key: readonly string[];
  readonly rows: readonly (readonly (readonly [string, ReferenceValue])[])[];
};

/**
 * Reads `reference` from the schema and checks it against the head catalog.
 *
 * A key must be a primary key, a unique constraint, or a unique index, in
 * that column order. The catalog is not given a copy of the rows.
 *
 * @param tables - Tables the schema built
 * @param casing - Schema casing. Absent means names are used as written
 * @param head - Head snapshot the rows will be inserted into
 * @returns One entry per table that declares rows
 */
export function readReference(
  tables: readonly AnyTable[],
  casing: "snake" | undefined,
  head: Catalog,
): readonly ReferenceTable[] {
  const declared: ReferenceTable[] = [];
  for (const item of tables) {
    const options = item.options as
      | { readonly reference?: ReferenceOption; readonly sqlName?: string }
      | undefined;
    const reference = options?.reference;
    if (reference === undefined) continue;
    const table = options?.sqlName ?? (casing === "snake" ? snakeCase(item.name) : item.name);
    const key = keyNames(item, reference, casing);
    if (!headHasTable(head, table)) {
      throw new OkmError(
        "invalid",
        `Table ${item.name} declares reference rows and is not in the head snapshot.`,
        { fix: { summary: "Run okm generate so the snapshot includes the table." } },
      );
    }
    if (!headHasKey(head, table, key)) {
      throw new OkmError(
        "invalid",
        `Reference key ${key.join(", ")} on ${table} is not a primary key or a unique constraint.`,
        {
          fix: {
            summary:
              "Declare the key as the primary key or a unique constraint, in that column order.",
          },
        },
      );
    }
    declared.push({ table, key, rows: rowsOf(item, reference, key, casing) });
  }
  return declared;
}

/**
 * Insert-if-missing statements for one schema.
 *
 * Each row is its own `INSERT … ON CONFLICT DO NOTHING`. There is no
 * `UPDATE` and no `DELETE`.
 *
 * @param tables - Declarations from {@link readReference}
 * @param schema - Schema the statements write
 * @returns SQL in declaration order
 */
export function referenceInserts(
  tables: readonly ReferenceTable[],
  schema: string,
): readonly string[] {
  const statements: string[] = [];
  for (const item of tables) {
    const conflict = item.key.map((name) => quoteIdent(name)).join(", ");
    for (const row of item.rows) {
      const columns = row.map(([name]) => quoteIdent(name)).join(", ");
      const values = row.map(([, value]) => literal(value)).join(", ");
      statements.push(
        `insert into ${qualify(schema, item.table)} (${columns}) values (${values}) on conflict (${conflict}) do nothing`,
      );
    }
  }
  return statements;
}

function keyNames(
  item: AnyTable,
  reference: ReferenceOption,
  casing: "snake" | undefined,
): readonly string[] {
  const names = typeof reference.key === "string" ? [reference.key] : [...reference.key];
  if (names.length === 0) {
    throw new OkmError("invalid", `Table ${item.name} reference key is empty.`, {
      fix: { summary: "Name the column or columns that identify a reference row." },
    });
  }
  return names.map((field) => fieldSql(item, field, casing));
}

function rowsOf(
  item: AnyTable,
  reference: ReferenceOption,
  key: readonly string[],
  casing: "snake" | undefined,
): ReferenceTable["rows"] {
  if (!Array.isArray(reference.rows)) {
    throw new OkmError("invalid", `Table ${item.name} reference rows must be a list.`, {
      fix: { summary: "Pass reference: { key, rows } with one object per row." },
    });
  }
  return reference.rows.map((row, index) => rowOf(item, row, key, casing, index));
}

function rowOf(
  item: AnyTable,
  row: Readonly<Record<string, string | number | boolean | null>>,
  key: readonly string[],
  casing: "snake" | undefined,
  index: number,
): readonly (readonly [string, ReferenceValue])[] {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new OkmError(
      "invalid",
      `Table ${item.name} reference row ${String(index)} is not an object.`,
      {
        fix: { summary: "Each reference row is an object of column names and values." },
      },
    );
  }
  const pairs: (readonly [string, ReferenceValue])[] = [];
  const seen = new Set<string>();
  for (const name of key) {
    const field = fieldFor(item, name, casing);
    if (field === undefined || !Object.hasOwn(row, field)) {
      throw new OkmError(
        "invalid",
        `Table ${item.name} reference row ${String(index)} is missing key ${name}.`,
        { fix: { summary: "Every reference row includes its key columns." } },
      );
    }
    pairs.push([name, valueOf(item, index, field, row[field])]);
    seen.add(field);
  }
  for (const field of Object.keys(row)) {
    if (seen.has(field)) continue;
    pairs.push([fieldSql(item, field, casing), valueOf(item, index, field, row[field])]);
  }
  return pairs;
}

function fieldFor(
  item: AnyTable,
  sqlName: string,
  casing: "snake" | undefined,
): string | undefined {
  for (const field of Object.keys(item.columns)) {
    if (fieldSql(item, field, casing) === sqlName) return field;
  }
  return undefined;
}

function fieldSql(item: AnyTable, field: string, casing: "snake" | undefined): string {
  const column = item.columns[field] as
    | { readonly state?: { readonly sqlName?: string } }
    | undefined;
  if (column === undefined) {
    throw new OkmError(
      "invalid",
      `Table ${item.name} reference names ${field}, which is not a column.`,
      {
        fix: { summary: "Use a column of that table." },
      },
    );
  }
  const named = column.state?.sqlName;
  if (named !== undefined && named.length > 0) return named;
  return casing === "snake" ? snakeCase(field) : field;
}

function valueOf(item: AnyTable, index: number, field: string, value: unknown): ReferenceValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new OkmError(
    "invalid",
    `Table ${item.name} reference row ${String(index)} column ${field} is not a string, number, boolean, or null.`,
    {
      fix: { summary: "Reference values are scalars. A later release can add other column types." },
    },
  );
}

function literal(value: ReferenceValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return quoteLiteral(value);
}

function headHasTable(head: Catalog, table: string): boolean {
  return head.objects.some((object) => object.kind === "table" && object.identity.name === table);
}

function headHasKey(head: Catalog, table: string, key: readonly string[]): boolean {
  const want = key.join("\0");
  for (const object of head.objects) {
    if (object.kind === "constraint" && object.identity.parent.name === table) {
      const kind = object.definition.constraintKind;
      if (
        (kind === "primaryKey" || kind === "unique") &&
        object.definition.columns.join("\0") === want
      ) {
        return true;
      }
    }
    if (
      object.kind === "index" &&
      object.identity.parent.name === table &&
      object.definition.unique &&
      object.definition.predicate === undefined &&
      object.definition.columns.join("\0") === want
    ) {
      return true;
    }
  }
  return false;
}
