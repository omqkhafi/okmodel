/**
 * Refuses a migration ledger name that already belongs to another table.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves a foreign `okm_meta`, `okm_history`,
 * `okm_backfill`, or `okm_steps` in place. A later read of a ledger column
 * then fails as a raw database error. Apply and push check the catalog
 * schema before any step.
 */

import type { DriverConnection, WireValue } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { qualify } from "../../dialects/pg/ddl.js";

/** Columns a real ledger table has. Extra columns are still the ledger. */
const LEDGERS: readonly { readonly name: string; readonly columns: readonly string[] }[] = [
  { name: "okm_meta", columns: ["id", "catalog_hash", "migration_id"] },
  {
    name: "okm_history",
    columns: ["migration_id", "step_index", "class", "catalog_hash", "applied_at"],
  },
  {
    name: "okm_backfill",
    columns: [
      "migration_id",
      "step_index",
      "last_key",
      "rows_touched",
      "batches",
      "state",
      "updated_at",
    ],
  },
  {
    name: "okm_steps",
    columns: [
      "migration_id",
      "step_index",
      "kind",
      "sql_hash",
      "state",
      "attempt",
      "started_at",
      "finished_at",
      "runner",
      "error_code",
      "error_text",
    ],
  },
];

const LOOKUP = `select c.relname, n.nspname, c.relkind::text,
  coalesce((
    select string_agg(a.attname, chr(31) order by a.attnum)
    from pg_attribute a
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  ), '')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = current_schema()
  and c.relname in ('okm_meta', 'okm_history', 'okm_backfill', 'okm_steps')`;

/**
 * Columns `name` must have when it is one of the four ledger tables.
 *
 * @param name - Relation name
 * @returns The required columns, or `undefined` when `name` is not a ledger
 */
export function ledgerRequiredColumns(name: string): readonly string[] | undefined {
  return LEDGERS.find((ledger) => ledger.name === name)?.columns;
}

/**
 * Whether an existing relation is not okm's ledger.
 *
 * Absent names are not foreign: the following `CREATE TABLE` makes the ledger.
 * A table of another name is not this check. An ordinary table that has every
 * required column is the ledger, including when it has extra columns.
 *
 * @param name - Relation name in the catalog schema
 * @param relkind - `pg_class.relkind` (`r` is an ordinary table)
 * @param columns - Attribute names on that relation
 * @returns `true` when apply and push must refuse
 */
export function ledgerForeign(name: string, relkind: string, columns: readonly string[]): boolean {
  const required = ledgerRequiredColumns(name);
  if (required === undefined) return false;
  if (relkind !== "r") return true;
  const have = new Set(columns);
  for (const column of required) {
    if (!have.has(column)) return true;
  }
  return false;
}

/**
 * OKM1899 for a ledger name another table already owns.
 *
 * @param schema - Schema of the existing relation
 * @param table - Ledger name (`okm_steps` and the other three)
 * @returns Never
 */
export function ledgerNameTaken(schema: string, table: string): never {
  throw new OkmError("OKM1899", `Another table owns the name ${qualify(schema, table)}.`, {
    fix: {
      summary: "Rename that table, or drop it. okm keeps its migration ledger under this name.",
    },
  });
}

/**
 * Refuses when this shape is not the ledger.
 *
 * @param schema - Schema of the existing relation
 * @param table - Relation name
 * @param relkind - `pg_class.relkind`
 * @param columns - Attribute names
 */
export function refuseForeignLedger(
  schema: string,
  table: string,
  relkind: string,
  columns: readonly string[],
): void {
  if (ledgerForeign(table, relkind, columns)) ledgerNameTaken(schema, table);
}

/**
 * Refuses a foreign ledger table in the current schema.
 *
 * Call this after the session search path names the catalog schema, and
 * before `CREATE TABLE IF NOT EXISTS` or any migration step.
 *
 * @param connection - Apply or push connection
 */
export async function assertLedgerTables(connection: DriverConnection): Promise<void> {
  const result = await connection.execute(LOOKUP);
  const found = new Map<string, { schema: string; relkind: string; columns: string }>();
  for (const row of result.rows) {
    const name = textCell(row[0]);
    const schema = textCell(row[1]);
    if (name === "" || schema === "") continue;
    found.set(name, { schema, relkind: textCell(row[2]), columns: textCell(row[3]) });
  }
  for (const ledger of LEDGERS) {
    const relation = found.get(ledger.name);
    if (relation === undefined) continue;
    const columns = relation.columns === "" ? [] : relation.columns.split("\u001f");
    refuseForeignLedger(relation.schema, ledger.name, relation.relkind, columns);
  }
}

function textCell(value: WireValue | undefined): string {
  return typeof value === "string" ? value : "";
}
