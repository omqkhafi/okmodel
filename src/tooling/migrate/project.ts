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
import { attachRoles } from "../../dialects/pg/role/index.js";
import type { BuiltSchema } from "../../dialects/pg/schema.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { batchSizeField } from "./backfill.js";
import { type MigrateConfig } from "./config.js";
import { annotateLock, readRowEstimates, type RowEstimate } from "./estimate.js";
import {
  assertTargetAlias,
  assertTargetPolicy,
  listTargets,
  selectTarget,
  type InvokeFlags,
} from "./policy.js";
import { formatPlan, planMigration, staleRenames, type MigrationPlan } from "./plan.js";
import { hasError, lintCatalog, lintPlan, lintRefusal, type Finding } from "./lint.js";
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
  return writeArtifact(cwd, config, withRoles(built, config));
}

/**
 * Plans the current schema against the latest snapshot and writes SQL.
 *
 * An empty plan writes nothing. The file is SQL, not TypeScript.
 *
 * @param cwd - Project directory
 * @param name - Migration name
 * @param flags - `--replace` values
 * @returns The SQL path and lint findings, or `undefined` when nothing changed
 */
export async function generateProject(
  cwd: string,
  name: string,
  flags: readonly string[],
): Promise<{ readonly path: string; readonly findings: readonly Finding[] } | undefined> {
  const prepared = await prepare(cwd, name, flags);
  writeArtifact(cwd, prepared.config, prepared.built);
  if (prepared.plan.steps.length === 0) return undefined;
  const directory = join(cwd, prepared.config.migrations ?? "migrations");
  mkdirSync(directory, { recursive: true });
  const base = `${nextNumber(directory)}_${safeName(name)}`;
  const sqlPath = join(directory, `${base}.sql`);
  writeFileSync(sqlPath, formatPlan(prepared.plan));
  writeFileSync(join(directory, `${base}.catalog.json`), serializeCatalog(prepared.built.catalog));
  return { path: sqlPath, findings: lintPrepared(prepared) };
}

/**
 * Plans and returns the text. Nothing is written.
 *
 * When one target is configured, or `--target` names one, and that database
 * answers, the printed lock lines include `pg_class` row estimates. No
 * target, several targets without `--target`, or a target that cannot be
 * reached leaves the text identical to {@link formatPlan}.
 *
 * @param cwd - Project directory
 * @param name - Plan name
 * @param flags - `--replace` values
 * @param invoke - Target and protection flags, when the command passed them
 * @returns The plan, its lint findings, and the text to print
 */
export async function planProject(
  cwd: string,
  name: string,
  flags: readonly string[],
  invoke?: InvokeFlags,
): Promise<{
  readonly plan: MigrationPlan;
  readonly findings: readonly Finding[];
  readonly text: string;
}> {
  const prepared = await prepare(cwd, name, flags);
  return {
    plan: prepared.plan,
    findings: lintPrepared(prepared),
    text: await displayPlan(prepared.config, prepared.plan, invoke),
  };
}

/**
 * Validates the schema, then reports stale renames and unlisted table files.
 *
 * When exactly one target is configured, or `--target` names one, the
 * read-only `check` and `drift` classes are allowed and a database that
 * already has `okm_meta` is compared with the schema. A difference is
 * OKM1520. Several targets and no `--target` skip that comparison.
 *
 * Lint findings are computed from the plan and the catalog before any
 * connection. An error finding is OKM1510. Warnings are returned.
 *
 * @param cwd - Project directory
 * @param flags - `--target`, when the caller passed one
 * @returns Warning findings. Errors throw
 */
export async function checkProject(cwd: string, flags?: InvokeFlags): Promise<readonly Finding[]> {
  const opened = await openProject(cwd);
  assertValidation(opened.built);
  if (schemaRequestsValidation(opened.built) && !projectImportsValidate(cwd)) {
    const doc = errorDoc("OKM1201");
    if (doc === undefined) throw new Error("OKM1201 missing from the error registry.");
    throw new OkmError(doc.code, doc.summary, { fix: { summary: doc.fix } });
  }
  const targets = listTargets(opened.config);
  assertTargetAlias(targets);
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
  const findings = lintOpened(opened);
  if (hasError(findings)) throw lintRefusal(findings);
  const named = flags?.target;
  if (targets.length === 0) return findings;
  if (targets.length > 1 && named === undefined) return findings;
  const target = selectTarget(opened.config, named);
  assertTargetPolicy(target, "check", flags?.allowProtected ?? false);
  assertTargetPolicy(target, "drift", flags?.allowProtected ?? false);
  const { assertAuthorDrift } = await import("./drift.js");
  await assertAuthorDrift(target.url, opened.built.catalog, opened.config.roles);
  return findings;
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
  readonly before: Catalog;
  readonly after: Catalog;
}> {
  const opened = await openProject(cwd);
  const plan = planMigration({
    before: opened.previous,
    after: opened.built.catalog,
    renames: opened.renames,
    replacements: flags.map((flag) => parseReplace(flag)),
    name,
    ...batchSizeField(opened.config.backfill?.batchSize),
  });
  return {
    config: opened.config,
    built: opened.built,
    plan,
    before: opened.previous,
    after: opened.built.catalog,
  };
}

function lintPrepared(prepared: {
  readonly plan: MigrationPlan;
  readonly before: Catalog;
  readonly after: Catalog;
}): readonly Finding[] {
  return lintPlan(prepared.plan, prepared.before, prepared.after);
}

/**
 * Prints estimates when a selected target answers.
 *
 * A connection or query failure returns the offline text and does not throw.
 * Protection and an unknown `--target` still throw: those are the same
 * refusals the other read-only commands use. A pooler is not refused.
 *
 * @param config - Project config
 * @param plan - Plan to print
 * @param invoke - Target flags
 * @returns Offline text, or the same text with lock estimates
 */
async function displayPlan(
  config: MigrateConfig,
  plan: MigrationPlan,
  invoke: InvokeFlags | undefined,
): Promise<string> {
  const offline = formatPlan(plan);
  const targets = listTargets(config);
  if (targets.length === 0) return offline;
  assertTargetAlias(targets);
  const named = invoke?.target;
  if (named === undefined && targets.length !== 1) return offline;
  const target = selectTarget(config, named);
  assertTargetPolicy(target, "plan", invoke?.allowProtected ?? false);
  let estimates: ReadonlyMap<string, RowEstimate>;
  try {
    const names = plan.steps.flatMap((step) => step.tables ?? []);
    estimates = await readRowEstimates(target.url, "public", names);
  } catch {
    return offline;
  }
  return formatPlan(plan, (step) => annotateLock(step, estimates));
}

function lintOpened(opened: {
  readonly built: Built;
  readonly previous: Catalog;
  readonly renames: readonly DeclaredRename[];
  readonly config: { readonly backfill?: { readonly batchSize?: number } };
}): readonly Finding[] {
  const plan = planMigration({
    before: opened.previous,
    after: opened.built.catalog,
    renames: opened.renames,
    name: "check",
    ...batchSizeField(opened.config.backfill?.batchSize),
  });
  return [
    ...lintPlan(plan, opened.previous, opened.built.catalog),
    ...lintCatalog(opened.built.catalog),
  ];
}

/**
 * Loads the config, the schema, and the previous catalog snapshot.
 *
 * A `renamedFrom` that the previous catalog does not contain is OKM1020.
 *
 * @param cwd - Project directory
 * @returns The loaded project
 */
export async function openProject(cwd: string): Promise<{
  readonly config: MigrateConfig;
  readonly built: Built;
  readonly previous: Catalog;
  readonly renames: readonly DeclaredRename[];
}> {
  const config = await loadConfig(cwd);
  const built = withRoles(await loadSchema(cwd, config.schema), config);
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

function withRoles(built: Built, config: MigrateConfig): Built {
  if (config.roles === undefined) return built;
  return { ...built, catalog: attachRoles(built.catalog, config.roles) };
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
 * Loads the schema named by `config`.
 *
 * @param cwd - Project directory
 * @param config - Project config
 * @returns The built schema, with roles attached when the config declares them
 */
export async function loadBuiltSchema(cwd: string, config: MigrateConfig): Promise<Built> {
  return withRoles(await loadSchema(cwd, config.schema), config);
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

/**
 * Loads the module named by `spec` and returns the schema it exports.
 *
 * @param cwd - Project directory
 * @param spec - Path from `defineConfig({ schema })`, relative to `cwd`
 * @returns The built schema
 */
export async function loadSchema(cwd: string, spec: string): Promise<Built> {
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
