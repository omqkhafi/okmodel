/**
 * `okm build`, `okm generate`, `okm check`, and `okm migrate plan`.
 *
 * Build writes the catalog it already validated. Check and dev read
 * `.catalog`, which runs that validation. Generate writes SQL only.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { catalog } from "../../contracts/catalog/build.js";
import { catalogHash, parseCatalog, serializeCatalog } from "../../contracts/catalog/document.js";
import { OkmError } from "../../contracts/error.js";
import { schemaDeclarations } from "../../dialects/pg/declarations.js";
import { emitRowTypes } from "../../dialects/pg/emit.js";
import type { BuiltSchema } from "../../dialects/pg/schema.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { type MigrateConfig } from "./config.js";
import { formatPlan, planMigration, staleRenames, type MigrationPlan } from "./plan.js";
import { parseReplace } from "./values.js";

type Built = BuiltSchema<readonly AnyTable[]>;

type Previous = {
  readonly catalog: Catalog;
};

/**
 * Validates the schema and writes `.okm/`.
 *
 * @param cwd - Project directory
 * @returns The output directory
 */
export async function buildProject(cwd: string): Promise<string> {
  const config = await loadConfig(cwd);
  const built = await loadSchema(cwd, config.schema);
  return writeArtifact(cwd, config, built);
}

/**
 * Plans the current schema against the latest snapshot and writes SQL.
 *
 * An empty plan writes nothing. The file is SQL, not TypeScript.
 *
 * @param cwd - Project directory
 * @param name - Migration name
 * @param flags - `--replace` values
 * @returns The SQL path, or `undefined` when nothing changed
 */
export async function generateProject(
  cwd: string,
  name: string,
  flags: readonly string[],
): Promise<string | undefined> {
  const prepared = await prepare(cwd, name, flags);
  writeArtifact(cwd, prepared.config, prepared.built);
  if (prepared.plan.steps.length === 0) return undefined;
  const directory = join(cwd, prepared.config.migrations ?? "migrations");
  mkdirSync(directory, { recursive: true });
  const base = `${nextNumber(directory)}_${safeName(name)}`;
  const sqlPath = join(directory, `${base}.sql`);
  writeFileSync(sqlPath, formatPlan(prepared.plan));
  writeFileSync(join(directory, `${base}.catalog.json`), serializeCatalog(prepared.built.catalog));
  return sqlPath;
}

/**
 * Plans and returns the text. Nothing is written.
 *
 * @param cwd - Project directory
 * @param name - Plan name
 * @param flags - `--replace` values
 * @returns The plan
 */
export async function planProject(
  cwd: string,
  name: string,
  flags: readonly string[],
): Promise<MigrationPlan> {
  const prepared = await prepare(cwd, name, flags);
  return prepared.plan;
}

/**
 * Validates the schema, then reports stale renames and unlisted table files.
 *
 * @param cwd - Project directory
 */
export async function checkProject(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const built = await loadSchema(cwd, config.schema);
  const declarations = schemaDeclarations(built);
  const previous = readPrevious(join(cwd, config.migrations ?? "migrations"));
  const stale = staleRenames(previous?.catalog, declarations.renames);
  if (stale.length > 0) {
    throw new OkmError("OKM1020", stale.join(" "), {
      fix: { summary: "Remove renamedFrom once the migration that used it has been applied." },
    });
  }
  if (config.tables !== undefined) {
    const directory = join(cwd, config.tables);
    const files = existsSync(directory) ? readdirSync(directory) : [];
    const source = readFileSync(join(cwd, config.schema), "utf8");
    const missing = unlistedTableFiles(source, files);
    if (missing.length > 0) {
      throw new OkmError("OKM1024", `Table file not in schema: ${missing.join(", ")}.`, {
        fix: { summary: "Add the file's table to the schema() call that okm check reads." },
      });
    }
  }
}

/**
 * Table files whose names do not appear in the schema module.
 *
 * @param schemaSource - Source text of the schema module
 * @param fileNames - File names in the tables directory
 * @returns Files `okm check` reports as OKM1024
 */
export function unlistedTableFiles(
  schemaSource: string,
  fileNames: readonly string[],
): readonly string[] {
  const missing: string[] = [];
  for (const file of fileNames) {
    if (!file.endsWith(".ts")) continue;
    const stem = basename(file, ".ts");
    if (stem.length === 0 || stem.startsWith(".")) continue;
    if (!schemaSource.includes(stem)) missing.push(file);
  }
  return missing;
}

async function prepare(
  cwd: string,
  name: string,
  flags: readonly string[],
): Promise<{
  readonly config: MigrateConfig;
  readonly built: Built;
  readonly plan: MigrationPlan;
}> {
  const config = await loadConfig(cwd);
  const built = await loadSchema(cwd, config.schema);
  const declarations = schemaDeclarations(built);
  const previous = readPrevious(join(cwd, config.migrations ?? "migrations"));
  const stale = staleRenames(previous?.catalog, declarations.renames);
  if (stale.length > 0) {
    throw new OkmError("OKM1020", stale.join(" "), {
      fix: { summary: "Remove renamedFrom once the migration that used it has been applied." },
    });
  }
  const plan = planMigration({
    before: previous?.catalog ?? catalog([]),
    after: built.catalog,
    renames: declarations.renames,
    replacements: flags.map((flag) => parseReplace(flag)),
    name,
  });
  return { config, built, plan };
}

function writeArtifact(cwd: string, config: MigrateConfig, built: Built): string {
  const directory = join(cwd, config.out ?? ".okm");
  mkdirSync(directory, { recursive: true });
  const text = serializeCatalog(built.catalog);
  writeFileSync(join(directory, "catalog.json"), text);
  writeFileSync(join(directory, "catalog.hash"), `${catalogHash(built.catalog)}\n`);
  writeFileSync(
    join(directory, "types.d.ts"),
    `${emitRowTypes(built)}${referenceAugmentation(built)}`,
  );
  return directory;
}

/**
 * Loads `okmodel.config.ts`.
 *
 * @param cwd - Project directory
 * @returns The config object
 */
export async function loadConfig(cwd: string): Promise<MigrateConfig> {
  const path = join(cwd, "okmodel.config.ts");
  const imported: unknown = await import(`${pathToFileURL(path).href}?okm=${Date.now()}`);
  const record = isRecord(imported) ? imported : {};
  const config = record.default ?? record.config;
  if (!isConfig(config)) {
    throw new OkmError("invalid", "okmodel.config.ts must default-export defineConfig(...).");
  }
  return config;
}

async function loadSchema(cwd: string, spec: string): Promise<Built> {
  const path = join(cwd, spec);
  const imported: unknown = await import(`${pathToFileURL(path).href}?okm=${Date.now()}`);
  const record = isRecord(imported) ? imported : {};
  for (const value of Object.values(record)) {
    if (!isBuilt(value)) continue;
    void value.catalog;
    return value;
  }
  throw new OkmError("invalid", `${spec} must export a schema().`);
}

function readPrevious(directory: string): Previous | undefined {
  if (!existsSync(directory)) return undefined;
  const catalogs = readdirSync(directory)
    .filter((file) => file.endsWith(".catalog.json"))
    .sort();
  const latest = catalogs.at(-1);
  if (latest === undefined) return undefined;
  const text = readFileSync(join(directory, latest), "utf8");
  return { catalog: parseCatalog(text) };
}

function referenceAugmentation(source: Built): string {
  const names = source.tables.map((item) => JSON.stringify(item.name));
  const union = names.length === 0 ? "never" : names.join(" | ");
  return [
    'import type { ColumnFlags, ReferenceOptions } from "okmodel/pg";',
    "",
    'declare module "okmodel/pg" {',
    "  interface ColumnBuilder<TValue, TFlags extends ColumnFlags> {",
    "    references(",
    `      table: ${union},`,
    "      options?: ReferenceOptions,",
    "    ): ColumnBuilder<TValue, TFlags>;",
    "  }",
    "}",
    "",
    `export type TableName = ${union};`,
    "",
  ].join("\n");
}

function nextNumber(directory: string): string {
  let max = 0;
  if (existsSync(directory)) {
    for (const file of readdirSync(directory)) {
      const match = /^(\d+)_/.exec(file);
      const value = match?.[1];
      if (value !== undefined) max = Math.max(max, Number(value));
    }
  }
  return String(max + 1).padStart(4, "0");
}

function safeName(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new OkmError("invalid", `Migration name ${name} must be letters, digits, _ or -.`);
  }
  return name;
}

function isBuilt(value: unknown): value is Built {
  if (!isRecord(value) || !Array.isArray(value.tables)) return false;
  return "catalog" in value;
}

function isConfig(value: unknown): value is MigrateConfig {
  return isRecord(value) && typeof value.schema === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
