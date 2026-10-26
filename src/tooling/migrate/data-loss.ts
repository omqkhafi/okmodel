/**
 * Refuses an `okm push` plan that would drop data.
 *
 * Data loss is a dropped column, a dropped primary key or unique constraint,
 * or a dropped table, when that table has a row. The row check is
 * `select 1 from <table> limit 1` inside the push transaction, before any
 * statement of the plan. A rename, an added object, and an empty table are
 * not data loss. Objects `.okm/pull.json` already names stay OKM1897.
 */

import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import { dropObjectSql, qualify } from "../../dialects/pg/ddl.js";

/** One drop that loses data when its table has a row. */
export type DataLossObject = {
  readonly label: string;
  readonly table: string;
  readonly sql: string;
};

/**
 * Drops in `steps` that lose data when the table has a row.
 *
 * A check, a foreign key, an index, and a sequence are not in the list.
 * Order follows the live catalog.
 *
 * @param steps - Planned statements
 * @param live - Introspected catalog the plan was built from
 * @param schema - Concrete schema the plan qualified
 * @returns Objects, in catalog order
 */
export function dataLossObjects(
  steps: readonly { readonly sql: string; readonly kind?: string }[],
  live: Catalog,
  schema: string,
): readonly DataLossObject[] {
  const sqls = new Set<string>();
  for (const step of steps) {
    if (
      step.kind === "drop-column" ||
      step.kind === "drop-constraint" ||
      step.kind === "drop-table"
    ) {
      sqls.add(step.sql);
    }
  }
  if (sqls.size === 0) return [];
  const found: DataLossObject[] = [];
  const seen = new Set<string>();
  for (const object of live.objects) {
    const loss = lossOf(object, schema, sqls);
    if (loss === undefined || seen.has(loss.label)) continue;
    seen.add(loss.label);
    found.push(loss);
  }
  return found;
}

/**
 * Losses whose statement is one of `steps`.
 *
 * @param steps - Statements in one apply unit
 * @param losses - {@link dataLossObjects}
 * @returns The subset that unit would run
 */
export function lossesIn(
  steps: readonly { readonly sql: string }[],
  losses: readonly DataLossObject[],
): readonly DataLossObject[] {
  if (losses.length === 0 || steps.length === 0) return [];
  const sql = new Set(steps.map((step) => step.sql));
  return losses.filter((item) => sql.has(item.sql));
}

/**
 * `select 1 from <table> limit 1` for one live table.
 *
 * @param schema - Concrete schema
 * @param table - Table name from the catalog
 * @returns The probe statement
 */
export function rowProbeSql(schema: string, table: string): string {
  return `select 1 from ${qualify(schema, table)} limit 1`;
}

/**
 * Refuses when any loss table has a row.
 *
 * Call this inside the push transaction, before the unit's statements.
 * One probe per table. An empty result leaves that table's drops alone.
 *
 * @param connection - Open transaction
 * @param schema - Concrete schema the plan qualified
 * @param losses - Drops in this unit
 */
export async function assertNoDataLoss(
  connection: { execute(sql: string): Promise<{ readonly rows: readonly unknown[] }> },
  schema: string,
  losses: readonly DataLossObject[],
): Promise<void> {
  if (losses.length === 0) return;
  const seen = new Set<string>();
  const populated = new Set<string>();
  for (const item of losses) {
    if (seen.has(item.table)) continue;
    seen.add(item.table);
    const result = await connection.execute(rowProbeSql(schema, item.table));
    if (result.rows.length > 0) populated.add(item.table);
  }
  const labels: string[] = [];
  const named = new Set<string>();
  for (const item of losses) {
    if (!populated.has(item.table) || named.has(item.label)) continue;
    named.add(item.label);
    labels.push(item.label);
  }
  refuseDataLoss(labels);
}

/**
 * Refuses a push that would drop the named objects.
 *
 * @param labels - Objects whose tables have a row, in catalog order
 */
export function refuseDataLoss(labels: readonly string[]): void {
  if (labels.length === 0) return;
  throw new OkmError(
    "OKM1898",
    `okm push would drop ${labels.join(", ")}. Pass --allow-data-loss to apply that plan.`,
    {
      fix: {
        summary:
          "Keep the column, key, or table, or pass --allow-data-loss when those rows can go.",
      },
    },
  );
}

function lossOf(
  object: CatalogObject,
  schema: string,
  sqls: ReadonlySet<string>,
): DataLossObject | undefined {
  if (object.kind !== "table" && object.kind !== "column" && object.kind !== "constraint") {
    return undefined;
  }
  if (object.kind === "constraint") {
    const kind = object.definition.constraintKind;
    if (kind !== "primaryKey" && kind !== "unique") return undefined;
  }
  const sql = dropObjectSql(object, schema);
  if (sql === undefined || !sqls.has(sql)) return undefined;
  if (object.kind === "table") {
    return { label: object.identity.name, table: object.identity.name, sql };
  }
  const table = object.identity.parent.name;
  return { label: `${table}.${object.identity.name}`, table, sql };
}
