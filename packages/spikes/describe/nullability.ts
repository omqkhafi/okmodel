/**
 * Catalog reads for the F7a nullability rule.
 *
 * A result column is proven NOT NULL only when RowDescription names a base
 * column and one of these is true: `attnotnull`, an identity column, or a
 * domain with `typnotnull`. Anything else stays nullable. This file is the
 * query the spike ran. It is not shipped.
 */

/** One `pg_attribute` row joined to its type and relation. `$1` oid, `$2` attnum. */
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
  n.nspname
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attrelid = $1::oid
  AND a.attnum = $2::int
  AND a.attisdropped = false
`;

/**
 * Not-null constraints stored in `pg_constraint` (PostgreSQL 18).
 *
 * Older servers accept the `contype` comparison and return no rows.
 * `$1` is the table OID. `$2` is `attnum`.
 */
export const NOT_NULL_CONSTRAINT_SQL = `
SELECT c.oid, c.conname, c.convalidated, pg_get_constraintdef(c.oid) AS def
FROM pg_constraint c
WHERE c.conrelid = $1::oid
  AND c.contype = 'n'
  AND c.conkey = ARRAY[$2::int]::int2[]
`;

/** `pg_type` rows for OIDs a describe returned. `$1` is `oid[]`. */
export const TYPE_LOOKUP_SQL = `
SELECT
  t.oid,
  t.typname,
  t.typtype,
  t.typcategory,
  t.typelem,
  t.typbasetype,
  t.typnotnull,
  n.nspname
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.oid = ANY($1::oid[])
ORDER BY t.oid
`;

/** Columns the nullability query returns. */
export type NullabilityRow = {
  /** `pg_attribute.attnotnull`. */
  readonly attnotnull: boolean;
  /** `a`, `d`, or empty. */
  readonly attidentity: string;
  /** `s` for stored generated, or empty. */
  readonly attgenerated: string;
  /** Column type OID. */
  readonly atttypid: number;
  /** `pg_type.typname`. */
  readonly typname: string;
  /** `b`, `c`, `d`, `e`, `r`, or `m`. */
  readonly typtype: string;
  /** Domain NOT NULL. False for non-domains. */
  readonly domain_not_null: boolean;
  /** Domain base type, or zero. */
  readonly typbasetype: number;
  /** `pg_class.relkind`. */
  readonly relkind: string;
  /** Relation name. */
  readonly relname: string;
  /** Schema name. */
  readonly nspname: string;
};

/**
 * Whether the catalog row proves a base column is NOT NULL.
 *
 * This does not look at the statement. An outer join can still null the
 * column. Generated storage alone is not proof.
 *
 * @param row - One `pg_attribute` lookup
 * @returns True when the column cannot be SQL NULL in a simple reference
 */
export function provenNotNull(row: NullabilityRow): boolean {
  if (row.relkind !== "r" && row.relkind !== "p") return false;
  if (row.attidentity === "a" || row.attidentity === "d") return true;
  if (row.attnotnull) return true;
  if (row.typtype === "d" && row.domain_not_null) return true;
  return false;
}
