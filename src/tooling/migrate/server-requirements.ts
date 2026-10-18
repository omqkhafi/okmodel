/**
 * Compares `describe()` requirements with a connected server.
 *
 * Doctor and `okm check` share this. Codes stay OKM1802 / OKM1803 for the
 * major and OKM1811 for a missing extension (D300).
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { OkmError } from "../../contracts/error.js";
import type { DriverPool, WireValue } from "../../contracts/driver.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import {
  POSTGRES_FLOOR,
  serverNeedsPostgres,
  type PostgresMajor,
} from "../../dialects/pg/floor.js";
import { driverUrl } from "./driver-url.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { describe } from "./schema-api.js";

/**
 * Schema shape `describe` and the server check need.
 *
 * The catalog is enough when `requires` is absent: the floor is then the
 * project minimum, raised by features such as `uuidv7()`.
 */
export type RequirementsSchema = {
  readonly catalog: Catalog;
  readonly requires?: { readonly postgres?: string } | undefined;
};

/**
 * Refuses when the server is older than `minPostgres` or lacks an extension.
 *
 * @param url - Target URL
 * @param schema - Schema `describe` reads
 * @throws OkmError OKM1802, OKM1803, or OKM1811
 */
export async function assertSchemaRequirements(
  url: string,
  schema: RequirementsSchema,
): Promise<void> {
  const pool = open({ url: driverUrl(url), max: 1 });
  try {
    await assertAgainstPool(pool, schema);
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    await finishQuiet(() => pool.close());
  }
}

/**
 * Same checks as {@link assertSchemaRequirements} on an open pool.
 *
 * @param pool - Open connection
 * @param schema - Schema `describe` reads
 */
export async function assertAgainstPool(
  pool: DriverPool,
  schema: RequirementsSchema,
): Promise<void> {
  const description = describe(schema);
  const major = await serverMajor(pool);
  refuseMajor(major, description.minPostgres, schema.requires?.postgres !== undefined);
  if (description.extensions.length === 0) return;
  const installed = await installedExtensions(
    pool,
    description.extensions.map((item) => item.name),
  );
  for (const item of description.extensions) {
    if (installed.has(item.name)) continue;
    throw new OkmError("OKM1811", `Extension ${item.name} is not installed on the server.`, {
      fix: {
        summary: `Install the extension, or remove the declaration. Needed because ${item.reason}.`,
      },
    });
  }
}

function refuseMajor(server: number, need: PostgresMajor, declared: boolean): void {
  if (server >= need) return;
  if (!declared && need === POSTGRES_FLOOR) {
    throw new OkmError("OKM1803", serverNeedsPostgres(server, POSTGRES_FLOOR), {
      fix: { summary: `Upgrade to PostgreSQL ${String(POSTGRES_FLOOR)} or higher.` },
    });
  }
  throw new OkmError("OKM1802", serverNeedsPostgres(server, need), {
    fix: { summary: "Upgrade the server, or lower minPostgres to a major the server meets." },
  });
}

async function serverMajor(pool: DriverPool): Promise<number> {
  const result = await pool.execute("select current_setting('server_version_num')");
  return Math.floor(Number(cell(result.rows[0]?.[0]) || "0") / 10_000);
}

async function installedExtensions(
  pool: DriverPool,
  names: readonly string[],
): Promise<ReadonlySet<string>> {
  if (names.length === 0) return new Set();
  const result = await pool.execute(
    "select extname from pg_extension where extname = any($1::text[])",
    [encodeTextArray(names)],
  );
  const found = new Set<string>();
  for (const row of result.rows) {
    const name = cell(row[0]);
    if (name.length > 0) found.add(name);
  }
  return found;
}

function encodeTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
}

function cell(value: WireValue | undefined): string {
  return typeof value === "string" ? value : "";
}
