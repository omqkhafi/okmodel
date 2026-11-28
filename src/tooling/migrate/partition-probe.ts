/**
 * The row probe that runs before a conversion takes its lock.
 *
 * Apply loads this only when a step carries the marker. A featureless plan
 * does not.
 */

import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";

const MARKER = /\/\* okm-partition-rows (\S+) \| ([\s\S]*?) \*\//;

/**
 * Counts rows that would not fit the partition a conversion attaches.
 *
 * A count above zero throws OKM1932 before the conversion transaction begins.
 *
 * @param connection - The apply connection, outside the conversion transaction
 * @param statements - Step text, including the marker comment
 */
export async function guardPartitionRows(
  connection: DriverConnection,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    const match = MARKER.exec(statement);
    const table = match?.[1];
    const where = match?.[2]?.trim();
    if (table === undefined || where === undefined || where === "false") continue;
    const result = await connection.execute(`select count(*)::text from ${table} where ${where}`);
    const count = Number(result.rows[0]?.[0] ?? 0);
    if (count > 0) {
      throw new OkmError(
        "OKM1932",
        `Table ${table} has ${String(count)} rows outside the partition it would become. Nothing was locked.`,
        {
          fix: {
            summary: "Delete or move those rows, or widen the declared range, before converting.",
          },
        },
      );
    }
  }
}
