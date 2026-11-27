/**
 * Nullable virtual columns PostgreSQL rejects before it sees the statement.
 *
 * BUG #19812: a virtual generated column that is nullable and has a limited
 * type (`varchar(n)`, `numeric(p,s)`, `smallint`) is refused. The alternatives
 * are STORED, NOT NULL, or a wider type.
 */

import { definition } from "./misuse.js";

/**
 * Refuses a nullable virtual column whose type is limited.
 *
 * @param dataType - Column type as it will be emitted
 * @param stored - `false` when the column is virtual
 * @param nullable - Whether the column accepts null
 * @param where - Column name for the message
 */
export function refuseLimitedVirtual(
  dataType: string,
  stored: boolean | undefined,
  nullable: boolean,
  where: string,
): void {
  if (stored !== false || !nullable) return;
  const type = dataType.trim().toLowerCase();
  const limited =
    /^(?:character varying|varchar)\s*\(/.test(type) ||
    /^(?:numeric|decimal)\s*\(/.test(type) ||
    type === "smallint" ||
    type === "int2";
  if (!limited) return;
  definition(
    `${where} is a nullable VIRTUAL ${dataType}. PostgreSQL refuses that combination. Use STORED, drop .nullable(), or a wider type (text, integer, or numeric).`,
  );
}
