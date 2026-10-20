/**
 * Engine-version checks `okm migrate apply` and `okm migrate check` run
 * before the first statement.
 *
 * An explicit `uuidv7()` database default needs {@link UUIDV7_POSTGRES}.
 * A bare `t.id()` stores `gen_random_uuid()` and does not match here.
 * Nothing here is reachable from `connect()`.
 */

import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { UUIDV7_POSTGRES, uuidv7NeedsPostgres } from "../../dialects/pg/floor.js";

/** A migration the `uuidv7()` scan can read. Apply and check both pass this. */
type UuidV7Source = {
  readonly id: string;
  readonly steps: readonly { readonly sql: string }[];
};

/** Where a migration sets a `uuidv7()` default. */
export type UuidV7Default = {
  readonly migrationId: string;
  readonly stepIndex: number;
  /** `table.column`, or `undefined` when the statement does not name both. */
  readonly column: string | undefined;
};

const IDENT = String.raw`"(?:[^"]|"")+"|[A-Za-z_][\w$]*`;
const DEFAULT_UUIDV7 = /\bdefault\s+uuidv7\s*\(\s*\)/i;
const TABLE = new RegExp(
  String.raw`^\s*(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table(?:\s+if\s+exists)?(?:\s+only)?)\s+(?:(?:${IDENT})\.)?(${IDENT})`,
  "i",
);
const COLUMN = new RegExp(String.raw`(${IDENT})\s+(?:uuid\b|set\s+default\b)`, "i");

/**
 * Finds the first pending step that sets a `uuidv7()` database default.
 *
 * Only `default uuidv7()` counts, so a string in a data step is not a hit.
 *
 * @param migrations - Migrations in apply order
 * @returns The first hit, or `undefined`
 */
export function findUuidV7Default(migrations: readonly UuidV7Source[]): UuidV7Default | undefined {
  for (const migration of migrations) {
    for (let stepIndex = 0; stepIndex < migration.steps.length; stepIndex += 1) {
      const sql = migration.steps[stepIndex]?.sql ?? "";
      if (!DEFAULT_UUIDV7.test(sql)) continue;
      return { migrationId: migration.id, stepIndex, column: columnOf(sql) };
    }
  }
  return undefined;
}

/**
 * Refuses a run that would set a `uuidv7()` default on a server that has none.
 *
 * The server is asked only when a step needs it, so a schema without the
 * default costs no round trip. A server below 18 that already has a
 * `uuidv7()` function, such as one the application defined, is accepted.
 * `okm migrate apply` and `okm migrate check` both call this before they
 * send a statement, so a missing function is OKM1812 rather than the raw
 * driver error.
 *
 * @param connection - The reserved apply or check connection
 * @param migrations - Migrations in apply order
 * @throws OkmError OKM1812, before any statement of the plan runs
 */
export async function assertUuidV7Available(
  connection: DriverConnection,
  migrations: readonly UuidV7Source[],
): Promise<void> {
  const found = findUuidV7Default(migrations);
  if (found === undefined) return;
  const result = await connection.execute(
    "select current_setting('server_version_num'), to_regprocedure('uuidv7()')::text",
  );
  const row = result.rows[0];
  const major = Math.floor(Number(row?.[0] ?? "0") / 10_000);
  const defined = row?.[1] !== null && row?.[1] !== undefined;
  if (major >= UUIDV7_POSTGRES || defined) return;
  const where = found.column === undefined ? "A column" : `Column ${found.column}`;
  const message = `${where} has a uuidv7() default (migration ${found.migrationId}, step ${String(found.stepIndex)}), and the server is PostgreSQL ${String(major)}. ${uuidv7NeedsPostgres()} Nothing was changed.`;
  throw new OkmError("OKM1812", message, { fix: { summary: uuidv7NeedsPostgres() } });
}

function columnOf(sql: string): string | undefined {
  const table = TABLE.exec(sql)?.[1];
  if (table === undefined) return undefined;
  const line = sql.split("\n").find((text) => DEFAULT_UUIDV7.test(text));
  const column = line === undefined ? undefined : COLUMN.exec(line)?.[1];
  if (column === undefined) return undefined;
  return `${unquote(table)}.${unquote(column)}`;
}

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}
