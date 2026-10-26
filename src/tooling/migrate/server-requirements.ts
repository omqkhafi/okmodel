/**
 * Compares `describe()` requirements with a connected server.
 *
 * Doctor and `okm check` share this. Codes stay OKM1802 / OKM1803 for the
 * major and OKM1811 for a missing extension (D300). A pending `CREATE
 * EXTENSION` step is not OKM1811 while the package is available and the
 * connected role can create it. An untrusted default version needs a
 * superuser. A trusted one needs `CREATE` on the database. An applied step
 * is still OKM1811. The same availability rule applies when the database has
 * no history and no migration files: the initial migration will create every
 * required extension (#400).
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
import { assertRoleCanCreateExtensions, createExtensionName } from "./extensions.js";
import { loadMigrations } from "./files.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { describe } from "./schema-api.js";
import { expandProvisioned } from "./snapshot.js";

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
 * Extension names a not-yet-applied `CREATE EXTENSION` step will install.
 *
 * An applied step does not count, including a step covered by `provisioned@`
 * or `baselined@`. When `okm_history` is absent, every file is pending.
 * `initial` is true when there are no files and no history: the forthcoming
 * initial migration creates every required extension.
 *
 * @param pool - Pool or connection
 * @param directory - Migrations directory
 * @returns Pending names, and whether this database is before its first migration
 */
async function pendingExtensionCreates(
  pool: StatementRunner,
  directory: string,
): Promise<{ readonly names: ReadonlySet<string>; readonly initial: boolean }> {
  const migrations = loadMigrations(directory);
  const applied = await appliedSteps(pool, migrations);
  const names = new Set<string>();
  for (const migration of migrations) {
    migration.steps.forEach((step, index) => {
      if (applied.done.has(`${migration.id}:${String(index)}`)) return;
      const name = createExtensionName(step.sql);
      if (name !== undefined) names.add(name);
    });
  }
  return { names, initial: migrations.length === 0 && !applied.present };
}

async function appliedSteps(
  pool: StatementRunner,
  migrations: readonly { readonly id: string; readonly steps: readonly unknown[] }[],
): Promise<{ readonly present: boolean; readonly done: Set<string> }> {
  const present = await pool.execute("select to_regclass('okm_history') is not null");
  if (!historyPresent(present.rows[0]?.[0])) return { present: false, done: new Set() };
  const rows = await pool.execute("select migration_id, step_index::text from okm_history");
  const done = new Set<string>();
  const ids: string[] = [];
  for (const row of rows.rows) {
    const id = row[0];
    const step = row[1];
    if (typeof id !== "string" || typeof step !== "string") continue;
    done.add(`${id}:${step}`);
    ids.push(id);
  }
  return { present: true, done: expandProvisioned(migrations, done, ids) };
}

function declaredExtensions(schema: RequirementsSchema): ReadonlySet<string> {
  const names = new Set<string>();
  for (const object of schema.catalog.objects) {
    if (object.kind === "extension") names.add(object.identity.name);
  }
  return names;
}

function historyPresent(value: WireValue | undefined): boolean {
  return value === "t" || value === "true";
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
 * @param migrationsDirectory - Migrations directory
 * @throws OkmError OKM1811
 */
export async function assertSchemaExtensions(
  url: string,
  schema: RequirementsSchema,
  migrationsDirectory: string,
): Promise<void> {
  const pool = open({ url: driverUrl(url), max: 1 });
  try {
    await assertExtensionsAgainstPool(pool, schema, migrationsDirectory);
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
 * @param migrationsDirectory - Migrations directory
 * @throws OkmError OKM1802, OKM1803, or OKM1811
 */
export async function assertSchemaRequirements(
  url: string,
  schema: RequirementsSchema,
  migrationsDirectory: string,
): Promise<void> {
  const pool = open({ url: driverUrl(url), max: 1 });
  try {
    await assertAgainstPool(pool, schema, migrationsDirectory);
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
 * @param migrationsDirectory - Migrations directory
 */
export async function assertAgainstPool(
  pool: StatementRunner,
  schema: RequirementsSchema,
  migrationsDirectory: string,
): Promise<void> {
  await assertMajorAgainstPool(pool, schema);
  await assertExtensionsAgainstPool(pool, schema, migrationsDirectory);
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
 * @param migrationsDirectory - Migrations directory
 * @throws OkmError OKM1811
 */
export async function assertExtensionsAgainstPool(
  pool: StatementRunner,
  schema: RequirementsSchema,
  migrationsDirectory: string,
): Promise<void> {
  const description = describe(schema);
  if (description.requirements.extensions.length === 0) return;
  const names = description.requirements.extensions.map((item) => item.name);
  const installed = await installedExtensions(pool, names);
  const pending = await pendingExtensionCreates(pool, migrationsDirectory);
  const declared = declaredExtensions(schema);
  const covered = (name: string): boolean =>
    pending.names.has(name) || (pending.initial && declared.has(name));
  const forthcoming = names.filter((name) => !installed.has(name) && covered(name));
  const available =
    forthcoming.length === 0 ? new Set<string>() : await availableExtensions(pool, forthcoming);
  await assertRoleCanCreateExtensions(
    pool,
    forthcoming.filter((name) => available.has(name)),
  );
  for (const item of description.requirements.extensions) {
    if (installed.has(item.name)) continue;
    if (covered(item.name)) {
      // Not installed yet. A pending step creates it, or the initial
      // migration will create a declared extension. An operator class with
      // no declaration is not created by that migration. An applied step
      // does not hide a later drop. An available package the role cannot
      // create was refused above.
      if (available.has(item.name)) continue;
      if (pending.names.has(item.name)) {
        throw new OkmError("OKM1811", `Extension ${item.name} is not available on the server.`, {
          fix: {
            summary: `Run okm migrate apply after the extension package is on the server, or remove the declaration. Needed because ${item.reason}.`,
          },
        });
      }
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

/**
 * Same refusal as {@link assertRoleCanCreateExtensions}, opening its own pool.
 *
 * `okm migrate check` calls this before the scratch replay, so a role that
 * cannot create the extension fails OKM1811 instead of a permission error.
 *
 * @param url - Target URL
 * @param names - Extensions the history creates
 * @throws OkmError OKM1811
 */
export async function assertCreatableExtensions(
  url: string,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  const pool = open({ url: driverUrl(url), max: 1 });
  try {
    await assertRoleCanCreateExtensions(pool, names);
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    await finishQuiet(() => pool.close());
  }
}

function cell(value: WireValue | undefined): string {
  return typeof value === "string" ? value : "";
}
