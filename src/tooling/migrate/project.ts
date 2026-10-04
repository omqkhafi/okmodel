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
import { errorDoc } from "../errors/registry.js";
import { assertValidation, writeWouldValidate } from "../../runtime/validate/places.js";
import { schemaDeclarations, type DeclaredRename } from "../../dialects/pg/declarations.js";
import { emitRowTypes } from "../../dialects/pg/emit.js";
import type { BuiltSchema } from "../../dialects/pg/schema.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { type MigrateConfig } from "./config.js";
import { assertTargetAlias, listTargets } from "./policy.js";
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
  const opened = await openProject(cwd);
  assertValidation(opened.built);
  if (schemaRequestsValidation(opened.built) && !projectImportsValidate(cwd)) {
    const doc = errorDoc("OKM1201");
    if (doc === undefined) throw new Error("OKM1201 missing from the error registry.");
    throw new OkmError(doc.code, doc.summary, { fix: { summary: doc.fix } });
  }
  assertTargetAlias(listTargets(opened.config));
  if (opened.config.tables !== undefined) {
    const directory = join(cwd, opened.config.tables);
    const files = existsSync(directory) ? readdirSync(directory) : [];
    const source = readFileSync(join(cwd, opened.config.schema), "utf8");
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

/**
 * The catalogs `okm push` diffs, after stale renames are refused.
 *
 * @param cwd - Project directory
 * @returns The previous snapshot, the current catalog, and declared renames
 */
export async function projectHead(cwd: string): Promise<{
  readonly previous: Catalog;
  readonly catalog: Catalog;
  readonly renames: readonly DeclaredRename[];
}> {
  const opened = await openProject(cwd);
  return { previous: opened.previous, catalog: opened.built.catalog, renames: opened.renames };
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
  const opened = await openProject(cwd);
  const plan = planMigration({
    before: opened.previous,
    after: opened.built.catalog,
    renames: opened.renames,
    replacements: flags.map((flag) => parseReplace(flag)),
    name,
  });
  return { config: opened.config, built: opened.built, plan };
}

async function openProject(cwd: string): Promise<{
  readonly config: MigrateConfig;
  readonly built: Built;
  readonly previous: Catalog;
  readonly renames: readonly DeclaredRename[];
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
  return {
    config,
    built,
    previous: previous?.catalog ?? catalog([]),
    renames: declarations.renames,
  };
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

const SKIP_SCAN = new Set(["node_modules", "dist", "coverage"]);

/**
 * Reports whether any table would validate on write.
 *
 * @param built - The loaded schema
 * @returns Whether OKM1201 applies when `okmodel/validate` was never imported
 */
function schemaRequestsValidation(built: Built): boolean {
  const flag = (built as { readonly validation?: unknown }).validation;
  for (const item of built.tables) {
    if (writeWouldValidate(flag, item, {})) return true;
  }
  return false;
}

/**
 * Reports whether the project imports `okmodel/validate` at runtime.
 *
 * A type-only import does not register the hook, so it does not count.
 *
 * @param cwd - Project directory
 * @returns Whether a runtime import is present
 */
function projectImportsValidate(cwd: string): boolean {
  return directoryImportsValidate(cwd);
}

function directoryImportsValidate(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_SCAN.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (directoryImportsValidate(path)) return true;
      continue;
    }
    if (!/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) continue;
    if (runtimeImportsValidate(readFileSync(path, "utf8"))) return true;
  }
  return false;
}

function runtimeImportsValidate(source: string): boolean {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const pattern = /["']okmodel\/validate(?:\.js)?["']/g;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const lead = text.slice(Math.max(0, index - 240), index);
    const start = Math.max(lead.lastIndexOf("\n"), lead.lastIndexOf(";"));
    const head = lead.slice(start + 1);
    if (/\bimport\s+type\b/.test(head) || /\bexport\s+type\b/.test(head)) continue;
    if (/\bimport\b/.test(head) || /\bexport\b/.test(head)) return true;
  }
  return false;
}
