/**
 * Catalog read for a NOT NULL constraint that is not validated.
 *
 * PostgreSQL 18 accepts `ADD CONSTRAINT … NOT NULL col NOT VALID`. From then
 * on `pg_attribute.attnotnull` is true while rows with NULL may still exist,
 * and the constraint is a `pg_constraint` row with `contype` `n` and
 * `convalidated` false. PostgreSQL 15 through 17 store no such row, so the
 * expression is NULL there and `attnotnull` alone keeps its old meaning.
 */

/**
 * SQL expression for the unvalidated NOT NULL constraint name of one column.
 *
 * The expression is a scalar subquery. It is the constraint name when one is
 * unvalidated, and NULL otherwise.
 *
 * @param attribute - Alias of the `pg_attribute` row in the enclosing query
 * @returns A parenthesised expression to select or test with `IS NOT NULL`
 */
export function unvalidatedNotNullSql(attribute = "a"): string {
  return `(
    select k.conname
    from pg_constraint k
    where k.conrelid = ${attribute}.attrelid
      and k.contype = 'n'
      and ${attribute}.attnum = any (k.conkey)
      and k.convalidated = false
    limit 1
  )`;
}
