/**
 * `okm build`, `okm generate`, `okm check`, and `okm migrate plan`.
 *
 * Build writes the catalog it already validated. Check and dev read
 * `.catalog`, which runs that validation. Generate writes SQL only.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { catalog } from "../../contracts/catalog/build.js";
import {
  catalogFileText,
  parseCatalog,
  serializeCatalog,
  startupCatalog,
} from "../../contracts/catalog/document.js";
import { sha256 } from "../../contracts/sha256.js";
import { OkmError } from "../../contracts/error.js";
import { errorDoc } from "../errors/registry.js";
import { assertValidation, writeWouldValidate } from "../../runtime/validate/places.js";
import { schemaDeclarations, type DeclaredRename } from "../../dialects/pg/declarations.js";
import { emitRowTypes, jsonColumnTypes } from "../../dialects/pg/emit.js";
import { stampOwnership, tableOwner } from "../../dialects/pg/owner.js";
import { attachRoles, type RolesInput, type TableExposure } from "../../dialects/pg/role/index.js";
import type { BuiltSchema } from "../../dialects/pg/schema.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { batchSizeField } from "./backfill.js";
import { type MigrateConfig } from "./config.js";
import {
  assertLiveExternal,
  assertSnapshots,
  catalogNamespace,
  couplingFindings,
  externalNamespaceMap,
  loadSnapshots,
  renderExport,
} from "./export.js";
import { placeCatalog } from "./place.js";
import { annotateLock, readRowEstimates, renameAliases, type RowEstimate } from "./estimate.js";
import {
  assertTargetAlias,
  assertTargetPolicy,
  listTargets,
  selectTarget,
  type InvokeFlags,
} from "./policy.js";
import { projectPath } from "./paths.js";
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
  return writeArtifact(cwd, config, withRoles(built, config, cwd));
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
  if (name === "init") writeGitAttributes(cwd);
  writeArtifact(cwd, prepared.config, prepared.built);
  if (prepared.plan.steps.length === 0) return undefined;
  const directory = projectPath(cwd, prepared.config.migrations ?? "migrations");
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
    const directory = projectPath(cwd, opened.config.tables);
    const files = existsSync(directory) ? readdirSync(directory) : [];
    const source = readFileSync(projectPath(cwd, opened.config.schema), "utf8");
    const missing = unlistedTableFiles(source, files);
    if (missing.length > 0) {
      throw new OkmError("OKM1024", `Table file not in schema: ${missing.join(", ")}.`, {
        fix: { summary: "Add the file's table to the schema() call that okm check reads." },
      });
    }
  }
  assertSnapshots(cwd, opened.config, opened.built.catalog);
  const findings = [...lintOpened(opened), ...couplingFindings(opened.built.catalog)];
  if (hasError(findings)) throw lintRefusal(findings);
  const named = flags?.target;
  if (targets.length === 0) return findings;
  if (targets.length > 1 && named === undefined) return findings;
  const target = selectTarget(opened.config, named);
  assertTargetPolicy(target, "check", flags?.allowProtected ?? false);
  assertTargetPolicy(target, "drift", flags?.allowProtected ?? false);
  const { assertAuthorDrift } = await import("./drift.js");
  const allowPooler = flags?.allowPooler === true || opened.config.allowPooler === true;
  await assertLiveExternal(target.url, opened.built.catalog, loadSnapshots(cwd, opened.config));
  await assertAuthorDrift(target.url, opened.built.catalog, opened.config.roles, allowPooler);
  return findings;
}

/**
 * Table files whose names do not appear in the schema module.
 *
 * The stem is compared without case, so `Tasks.ts` matches `tasks` in the
 * schema text. A case-insensitive volume still loads that import.
 *
 * @param schemaSource - Source text of the schema module
 * @param fileNames - File names in the tables directory
 * @returns Files `okm check` reports as OKM1024
 */
export function unlistedTableFiles(
  schemaSource: string,
  fileNames: readonly string[],
): readonly string[] {
  const folded = schemaSource.toLowerCase();
  const missing: string[] = [];
  for (const file of fileNames) {
    if (!file.endsWith(".ts")) continue;
    const stem = basename(file, ".ts");
    if (stem.length === 0 || stem.startsWith(".")) continue;
    if (!folded.includes(stem.toLowerCase())) missing.push(file);
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
    ...placedSchema(opened.config),
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
    estimates = await readRowEstimates(target.url, catalogNamespace(config), names);
  } catch {
    return offline;
  }
  const aliases = renameAliases(plan.steps);
  return formatPlan(plan, (step) => annotateLock(step, estimates, aliases));
}

function lintOpened(opened: {
  readonly built: Built;
  readonly previous: Catalog;
  readonly renames: readonly DeclaredRename[];
  readonly config: MigrateConfig;
}): readonly Finding[] {
  const plan = planMigration({
    before: opened.previous,
    after: opened.built.catalog,
    renames: opened.renames,
    name: "check",
    ...placedSchema(opened.config),
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
  const built = await loadBuiltSchema(cwd, config);
  const declarations = schemaDeclarations(built);
  const previous = readPrevious(projectPath(cwd, config.migrations ?? "migrations"));
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

function withRoles(built: Built, config: MigrateConfig, cwd: string): Built {
  const marks = ownershipMarks(built);
  const stamped = marks.size === 0 ? built.catalog : stampOwnership(built.catalog, marks);
  const placed = placeCatalog(
    stamped,
    catalogNamespace(config),
    externalNamespaceMap(loadSnapshots(cwd, config)),
  );
  const roles = config.roles;
  const catalog =
    roles === undefined ? placed : attachRoles(placed, roles, exposureFor(built, roles));
  if (catalog === built.catalog) return built;
  return { ...built, catalog };
}

function placedSchema(config: MigrateConfig): { readonly schema: string } | undefined {
  const namespace = catalogNamespace(config);
  if (namespace === "public") return undefined;
  return { schema: namespace };
}

function ownershipMarks(built: Built): ReadonlyMap<string, "external" | "ignored"> {
  const marks = new Map<string, "external" | "ignored">();
  const models = built.model as Readonly<Record<string, { readonly sql: string }>>;
  for (const table of built.tables) {
    const owner = tableOwner(table);
    if (owner === undefined) continue;
    const model = models[table.name];
    if (model === undefined) continue;
    marks.set(model.sql, owner);
  }
  return marks;
}

function exposureFor(built: Built, roles: RolesInput): readonly TableExposure[] | undefined {
  if (
    roles.reporting === undefined &&
    (roles.columns === undefined || roles.columns.length === 0)
  ) {
    return undefined;
  }
  return Object.values(built.model).map((model) => ({
    table: model.sql,
    columns: model.columns.map((column) => ({
      field: column.field,
      sql: column.sql,
      hidden: column.hidden === true || column.hidden === "filter",
    })),
  }));
}

const GIT_ATTRIBUTES = [
  "migrations/*.sql text eol=lf",
  "*.catalog.json text eol=lf",
  ".okm/** text eol=lf",
  "",
].join("\n");

/**
 * Writes `.gitattributes` for LF migration and catalog files.
 *
 * An existing file is left unchanged, including one that does not list these
 * patterns. `okm generate init` is the only caller.
 *
 * @param cwd - Project directory
 */
function writeGitAttributes(cwd: string): void {
  const path = projectPath(cwd, ".gitattributes");
  if (existsSync(path)) return;
  writeFileSync(path, GIT_ATTRIBUTES);
}

/**
 * Row types for `.okm/types.d.ts`.
 *
 * `t.jsonb<T>()` is erased at runtime. The type argument is read from the
 * schema file. A bare `t.jsonb()` stays `jsonb<unknown>`.
 *
 * @param cwd - Project directory
 * @param spec - Schema path from the config
 * @param built - Loaded schema
 * @returns Declaration text
 */
function typesText(cwd: string, spec: string, built: Built): string {
  return `${emitRowTypes(built, jsonColumnTypes(readSchemaSource(cwd, spec)))}${referenceAugmentation(built)}`;
}

/**
 * Schema source plus the local files it imports.
 *
 * @param cwd - Project directory
 * @param spec - Schema path from the config
 * @returns The concatenated source
 */
function readSchemaSource(cwd: string, spec: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !existsSync(file)) return;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    parts.push(text);
    for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const rel = match[1];
      if (rel === undefined) continue;
      const base = join(dirname(file), rel);
      const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, "index.ts")];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          visit(candidate);
          break;
        }
      }
    }
  };
  visit(projectPath(cwd, spec));
  return parts.join("\n");
}

function writeArtifact(cwd: string, config: MigrateConfig, built: Built): string {
  const directory = projectPath(cwd, config.out ?? ".okm");
  mkdirSync(directory, { recursive: true });
  const startup = startupCatalog(built.catalog);
  const text = catalogFileText(serializeCatalog(startup));
  writeFileSync(join(directory, "catalog.json"), text);
  writeFileSync(join(directory, "catalog.hash"), `${sha256(text)}\n`);
  writeFileSync(join(directory, "types.d.ts"), typesText(cwd, config.schema, built));
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
  return withRoles(await loadSchema(cwd, config.schema), config, cwd);
}

/**
 * Prints or writes the catalog snapshot.
 *
 * @param cwd - Project directory
 * @param args - Arguments after `export`
 * @returns Stdout
 */
export async function exportProject(cwd: string, args: readonly string[]): Promise<string> {
  const config = await loadConfig(cwd);
  const built = await loadBuiltSchema(cwd, config);
  return renderExport(cwd, config, built.catalog, args);
}

/**
 * Loads `okmodel.config.ts`.
 *
 * @param cwd - Project directory
 * @returns The config object
 */
export async function loadConfig(cwd: string): Promise<MigrateConfig> {
  const path = projectPath(cwd, "okmodel.config.ts");
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
  const path = projectPath(cwd, spec);
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
