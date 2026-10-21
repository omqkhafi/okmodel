/**
 * Compares `describe()` requirements with a connected server.
 *
 * Doctor and `okm check` share this. Codes stay OKM1802 / OKM1803 for the
 * major and OKM1811 for a missing extension (D300). An extension an applied
 * or pending migration creates is not OKM1811; apply installs it (#400).
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
import { createExtensionName } from "./extensions.js";
import { loadMigrations } from "./files.js";
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

/** Anything that can run one statement: a pool or a reserved connection. */
export type StatementRunner = Pick<DriverPool, "execute">;

/**
 * Notice when several targets exist and `--target` was omitted.
 *
 * @param count - Number of configured targets
 * @returns One line, including the trailing newline
 */
export function serverChecksSkippedNotice(count: number): string {
  return `server checks skipped: ${String(count)} targets, pass --target <name>\n`;
}

/**
 * Extension names `CREATE EXTENSION` steps in the migrations directory create.
 *
 * Applied and pending files both count: doctor and check must not raise
 * OKM1811 for those names (#400).
 *
 * @param directory - Migrations directory
 * @returns Extension names the history will install
 */
export function extensionsCreatedByMigrations(directory: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const migration of loadMigrations(directory)) {
    for (const step of migration.steps) {
      const name = createExtensionName(step.sql);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/**
 * Refuses when the server is older than `minPostgres`.
 *
 * @param url - Target URL
 * @param schema - Schema `describe` reads
 * @throws OkmError OKM1802 or OKM1803
 */
export async function assertSchemaMajor(url: string, schema: RequirementsSchema): Promise<void> {
  const pool = open({ url: driverUrl(url), max: 1 });
  try {
    await assertMajorAgainstPool(pool, schema);
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    await finishQuiet(() => pool.close());
  }
}

/**
 * Refuses when a required extension is missing and no migration creates it.
 *
 * @param url - Target URL
 * @param schema - Schema `describe` reads
 * @param createdByMigrations - Names applied or pending migrations create
 * @throws OkmError OKM1811
 */
export async function assertSchemaExtensions(
  url: string,
  schema: RequirementsSchema,
  createdByMigrations: ReadonlySet<string> = new Set(),
): Promise<void> {
  const pool = open({ url: driverUrl(url), max: 1 });
  try {
    await assertExtensionsAgainstPool(pool, schema, createdByMigrations);
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    await finishQuiet(() => pool.close());
  }
}

/**
 * Major then extensions. Prefer the split helpers when drift runs between.
 *
 * @param url - Target URL
 * @param schema - Schema `describe` reads
 * @param createdByMigrations - Names applied or pending migrations create
 * @throws OkmError OKM1802, OKM1803, or OKM1811
 */
export async function assertSchemaRequirements(
  url: string,
  schema: RequirementsSchema,
  createdByMigrations: ReadonlySet<string> = new Set(),
): Promise<void> {
  const pool = open({ url: driverUrl(url), max: 1 });
  try {
    await assertAgainstPool(pool, schema, createdByMigrations);
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
 * @param createdByMigrations - Names applied or pending migrations create
 */
export async function assertAgainstPool(
  pool: StatementRunner,
  schema: RequirementsSchema,
  createdByMigrations: ReadonlySet<string> = new Set(),
): Promise<void> {
  await assertMajorAgainstPool(pool, schema);
  await assertExtensionsAgainstPool(pool, schema, createdByMigrations);
}

/**
 * Refuses when the server is older than the schema floor, on an open runner.
 *
 * @param pool - Pool or connection
 * @param schema - Schema `describe` reads
 * @throws OkmError OKM1802 or OKM1803
 */
export async function assertMajorAgainstPool(
  pool: StatementRunner,
  schema: RequirementsSchema,
): Promise<void> {
  const description = describe(schema);
  const major = await serverMajor(pool);
  refuseMajor(
    major,
    description.requirements.minVersion.postgres,
    schema.requires?.postgres !== undefined,
  );
}

/**
 * Refuses when a required extension is missing, on an open runner.
 *
 * @param pool - Pool or connection
 * @param schema - Schema `describe` reads
 * @param createdByMigrations - Names applied or pending migrations create
 * @throws OkmError OKM1811
 */
export async function assertExtensionsAgainstPool(
  pool: StatementRunner,
  schema: RequirementsSchema,
  createdByMigrations: ReadonlySet<string>,
): Promise<void> {
  const description = describe(schema);
  if (description.requirements.extensions.length === 0) return;
  const names = description.requirements.extensions.map((item) => item.name);
  const installed = await installedExtensions(pool, names);
  const missingCreated = names.filter(
    (name) => !installed.has(name) && createdByMigrations.has(name),
  );
  const available =
    missingCreated.length === 0
      ? new Set<string>()
      : await availableExtensions(pool, missingCreated);
  for (const item of description.requirements.extensions) {
    if (installed.has(item.name)) continue;
    if (createdByMigrations.has(item.name)) {
      // Not installed yet; an applied or pending migration creates it. Refuse
      // only when the server cannot install that package (#400).
      if (available.has(item.name)) continue;
      throw new OkmError("OKM1811", `Extension ${item.name} is not available on the server.`, {
        fix: {
          summary: `Run okm migrate apply after the extension package is on the server, or remove the declaration. Needed because ${item.reason}.`,
        },
      });
    }
    throw new OkmError("OKM1811", `Extension ${item.name} is not installed on the server.`, {
      fix: {
        summary: `Install the extension, or remove the declaration. Needed because ${item.reason}.`,
      },
    });
  }
}

/**
 * Installed version of each named extension.
 *
 * @param pool - Pool or connection
 * @param names - Extension names
 * @returns Name to `extversion`; a name the server lacks is absent
 */
export async function installedExtensionVersions(
  pool: StatementRunner,
  names: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  if (names.length === 0) return found;
  const result = await pool.execute(
    "select extname, extversion from pg_extension where extname = any($1::text[])",
    [encodeTextArray(names)],
  );
  for (const row of result.rows) {
    const name = cell(row[0]);
    if (name.length > 0) found.set(name, cell(row[1]));
  }
  return found;
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

/**
 * Reads the server's major version.
 *
 * @param pool - Pool or connection
 * @returns The major, or 0 when the server did not answer
 */
export async function serverMajor(pool: StatementRunner): Promise<number> {
  const result = await pool.execute("select current_setting('server_version_num')");
  return Math.floor(Number(cell(result.rows[0]?.[0]) || "0") / 10_000);
}

async function installedExtensions(
  pool: StatementRunner,
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

async function availableExtensions(
  pool: StatementRunner,
  names: readonly string[],
): Promise<ReadonlySet<string>> {
  if (names.length === 0) return new Set();
  const result = await pool.execute(
    "select name from pg_available_extensions where name = any($1::text[])",
    [encodeTextArray(names)],
  );
  const found = new Set<string>();
  for (const row of result.rows) {
    const name = cell(row[0]);
    if (name.length > 0) found.add(name);
  }
  return found;
}

/**
 * Postgres array literal for a `text[]` parameter.
 *
 * @param values - Strings to quote
 * @returns The literal, for example `{"a","b"}`
 */
export function encodeTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
}

function cell(value: WireValue | undefined): string {
  return typeof value === "string" ? value : "";
}
