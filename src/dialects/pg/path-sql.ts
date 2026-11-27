/**
 * SQL for a dotted path.
 *
 * One printer for composite field access and one for a to-one join. The view
 * compiler and the lazy `db.*` path module both call these. Neither function
 * adds a tenant predicate: a view has none, and a query adds it on the join.
 */

import { quoteIdent } from "./ddl.js";

/**
 * Prints `(parent)."field"` for each field, quoted.
 *
 * `(home).city` is valid only in expression context. The quoted form is what
 * `where`, `select`, `orderBy`, and `groupBy` use. `parent` is already SQL,
 * such as `t."home"`.
 *
 * @param parent - SQL of the composite value
 * @param fields - Field names, outer first
 * @returns The field access
 */
export function compositeAccess(parent: string, fields: readonly string[]): string {
  let sql = parent;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined) continue;
    sql = `(${sql}).${quoteIdent(field)}`;
  }
  return sql;
}

/**
 * Prints `left join <table> <alias> on <alias>.<remote> = <parent>.<local>`.
 *
 * `table`, `local`, and `remote` are already quoted. Several pairs are `and`.
 *
 * @param tableSql - Quoted table name
 * @param alias - Join alias
 * @param parentAlias - Alias of the table that holds the foreign key
 * @param pairs - Local (parent) and remote (joined) quoted column names
 * @returns The join clause, with no leading space
 */
export function toOneJoinSql(
  tableSql: string,
  alias: string,
  parentAlias: string,
  pairs: readonly (readonly [local: string, remote: string])[],
): string {
  let on = "";
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair === undefined) continue;
    if (on.length > 0) on += " and ";
    on += `${alias}.${pair[1]} = ${parentAlias}.${pair[0]}`;
  }
  return `left join ${tableSql} ${alias} on ${on}`;
}
