/**
 * Parser-free nullability for one described result column.
 *
 * A column is NOT NULL only when the row description names a base relation
 * column, `attnotnull` is set, the column is not a generated expression, and
 * the statement's lexical screen is clear. An `!` or `?` suffix on the result
 * name overrides that proof. CHECK constraints, views, and stored generated
 * columns are not proof. An unvalidated NOT NULL constraint (`pg_constraint`
 * `contype` `n`, `convalidated` false) also blocks the proof. PostgreSQL 15
 * through 17 store no such row, so `attnotnull` alone still decides there.
 */

import { statementBlocksNotNull } from "./screen.js";

/**
 * Catalog facts for one `pg_attribute` row.
 *
 * `attidentity` is `a`, `d`, or empty. `attgenerated` is `s`, `v`, or empty.
 * Identity is not a generated expression: an identity column with
 * `attnotnull` can still be proven.
 */
export type AttributeFacts = {
  /** `pg_attribute.attnotnull`. */
  readonly attnotnull: boolean;
  /** `a`, `d`, or empty. */
  readonly attidentity: string;
  /** `s` or `v` for a generated expression, or empty. */
  readonly attgenerated: string;
  /** `pg_class.relkind`. */
  readonly relkind: string;
  /**
   * True when a NOT NULL constraint on this column is not validated.
   *
   * PostgreSQL 18 can set `attnotnull` for `NOT VALID`. 15 through 17 never
   * set this.
   */
  readonly notNullInvalid: boolean;
};

/** One described column after the alias suffix is applied. */
export type ColumnNullability = {
  /** Property name. A trailing `!` or `?` is removed. */
  readonly name: string;
  /** True when the value must be typed as nullable. */
  readonly nullable: boolean;
};

/**
 * Catalog read for {@link attributeFacts}. `$1` is the table OID. `$2` is `attnum`.
 *
 * The selected list is the describe spike's query, plus whether a NOT NULL
 * constraint on the column is unvalidated. Only `attnotnull`, `attidentity`,
 * `attgenerated`, `relkind`, and that flag decide the result. Before
 * PostgreSQL 18 the flag is false: `contype` `n` matches no row.
 */
export const NULLABILITY_SQL = `
SELECT
  a.attnotnull,
  a.attidentity,
  a.attgenerated,
  a.atttypid,
  t.typname,
  t.typtype,
  t.typnotnull AS domain_not_null,
  t.typbasetype,
  c.relkind,
  c.relname,
  n.nspname,
  EXISTS (
    SELECT 1
    FROM pg_constraint k
    WHERE k.conrelid = a.attrelid
      AND k.contype = 'n'
      AND a.attnum = ANY (k.conkey)
      AND k.convalidated = false
  ) AS not_null_invalid
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attrelid = $1::oid
  AND a.attnum = $2::int
  AND a.attisdropped = false
`;

/**
 * Reads one nullability row.
 *
 * Boolean columns arrive as `t` or `f`. A short row is ignored.
 *
 * @param row - One result of {@link NULLABILITY_SQL}, in select order
 * @returns The facts, or `undefined` when the row is not usable
 */
export function attributeFacts(row: readonly (string | null)[]): AttributeFacts | undefined {
  const relkind = row[8];
  if (relkind === undefined || relkind === null || relkind.length === 0) return undefined;
  return {
    attnotnull: row[0] === "t" || row[0] === "true",
    attidentity: text(row[1]),
    attgenerated: text(row[2]),
    relkind,
    notNullInvalid: row[11] === "t" || row[11] === "true",
  };
}

/**
 * Decides whether one result column is nullable.
 *
 * A trailing `!` forces NOT NULL. A trailing `?` forces nullable. The suffix
 * is not part of the property name. Anything not proven NOT NULL is nullable.
 *
 * @param sql - The described statement
 * @param field - Result name, table OID, and attnum from the describe
 * @param facts - Catalog row for that attribute. Omitted when the OID is zero
 * @returns The property name and whether it is nullable
 */
export function columnNullability(
  sql: string,
  field: { readonly name: string; readonly tableOid: number; readonly attnum: number },
  facts: AttributeFacts | undefined,
): ColumnNullability {
  const named = propertyName(field.name);
  if (named.force === "notNull") return { name: named.name, nullable: false };
  if (named.force === "nullable") return { name: named.name, nullable: true };
  return { name: named.name, nullable: !proven(sql, field, facts) };
}

function proven(
  sql: string,
  field: { readonly tableOid: number; readonly attnum: number },
  facts: AttributeFacts | undefined,
): boolean {
  if (field.tableOid === 0 || field.attnum === 0) return false;
  if (facts === undefined) return false;
  if (facts.relkind !== "r" && facts.relkind !== "p") return false;
  if (facts.attgenerated.trim() !== "") return false;
  if (!facts.attnotnull) return false;
  if (facts.notNullInvalid) return false;
  return !statementBlocksNotNull(sql);
}

function propertyName(name: string): {
  readonly name: string;
  readonly force?: "notNull" | "nullable";
} {
  if (name.endsWith("!")) return { name: name.slice(0, -1), force: "notNull" };
  if (name.endsWith("?")) return { name: name.slice(0, -1), force: "nullable" };
  return { name };
}

function text(value: string | null | undefined): string {
  return value ?? "";
}
