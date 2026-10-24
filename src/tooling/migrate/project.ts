/**
 * `okm build`, `okm generate`, `okm check`, and `okm migrate plan`.
 *
 * Build writes the catalog it already validated. Check and dev read
 * `.catalog`, which runs that validation. Generate writes SQL only.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { catalog } from "../../contracts/catalog/build.js";
import {
  catalogFileText,
  catalogHash,
  parseCatalog,
  serializeCatalog,
  startupCatalog,
} from "../../contracts/catalog/document.js";
import { sha256 } from "../../contracts/sha256.js";
import { OkmError } from "../../contracts/error.js";
import { assertProjectWarnings } from "../../runtime/warnings/config.js";
import { tagOutcome } from "../cli/outcome.js";
import { assertSupported, formatEmulation } from "../capabilities/check.js";
import { POSTGRES_FEATURES } from "../capabilities/postgres.js";
import { featuresUsed } from "../capabilities/used.js";
import { errorDoc } from "../errors/registry.js";
import { attachCliDetail } from "../errors/shape.js";
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
import { refuseAmbiguousConfigs } from "./discover.js";
import { asProject, CONFIG_FILE, projectPath, type ProjectContext } from "./paths.js";
import { formatPlanJson } from "./plan-json.js";
import {
  formatPlan,
  planMigration,
  staleRenames,
  type MigrationPlan,
  type PlanStep,
} from "./plan.js";
import { allowFindings, listAllows, type AllowEntry } from "./allows.js";
import { projectFilterUses } from "./filter-scan.js";
import { hasError, lintCatalog, lintPlan, lintRefusal, type Finding } from "./lint.js";
import {
  adviceRefusal,
  schemaAdvice,
  type IgnoreReport,
  type SchemaAdvice,
} from "./schema-rules.js";
import { parseReplace } from "./values.js";

export type { ProjectContext };

type Built = BuiltSchema<readonly AnyTable[]>;

type Previous = {
  readonly catalog: Catalog;
};

/**
 * Validates the schema and writes `.okm/`.
 *
 * @param project - Project directory or {@link ProjectContext}
 * @returns The output directory and emulation notes. Notes are empty when every used feature is native
 */
export async function buildProject(
  project: string | ProjectContext,
): Promise<{ readonly directory: string; readonly emulation: string }> {
  const { cwd } = asProject(project);
  const config = await loadConfig(project);
  const built = withRoles(await loadSchema(cwd, config.schema), config, cwd);
  return {
    directory: writeArtifact(cwd, config, built),
    emulation: featureNotes(built.catalog),
  };
}

/**
 * Plans the current schema against the latest snapshot and writes SQL.
 *
 * An empty plan writes nothing. The file is SQL, not TypeScript.
 *
 * @param project - Project directory or {@link ProjectContext}
 * @param name - Migration name
 * @param flags - `--replace` values
 * @returns The SQL path and lint findings, or `undefined` when nothing changed
 */
export async function generateProject(
  project: string | ProjectContext,
  name: string,
  flags: readonly string[],
): Promise<{ readonly path: string; readonly findings: readonly Finding[] } | undefined> {
  const { cwd } = asProject(project);
  const prepared = await prepare(project, name, flags);
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
 * @param project - Project directory or {@link ProjectContext}
 * @param name - Plan name
 * @param flags - `--replace` values
 * @param invoke - Target and protection flags, when the command passed them
 * @returns The plan, its lint findings, the human text, and the `--json` document. Both forms use the same lock lines
 */
export async function planProject(
  project: string | ProjectContext,
  name: string,
  flags: readonly string[],
  invoke?: InvokeFlags,
): Promise<{
  readonly plan: MigrationPlan;
  readonly findings: readonly Finding[];
  readonly text: string;
  readonly json: string;
}> {
  const prepared = await prepare(project, name, flags);
  const findings = lintPrepared(prepared);
  const lockText = await planLockText(prepared.config, prepared.plan, invoke);
  return {
    plan: prepared.plan,
    findings,
    text: formatPlan(prepared.plan, lockText),
    json: formatPlanJson(prepared.plan, findings, lockText, {
      dialect: "postgres",
      fromCatalogHash: catalogHash(prepared.before),
      toCatalogHash: catalogHash(prepared.after),
    }),
  };
}

/**
 * Lint warnings from {@link checkProject}, plus an optional server-check notice.
 */
export type CheckProjectResult = {
  readonly findings: readonly Finding[];
  /**
   * Printed when several targets exist and `--target` was omitted.
   * Server major, extension, and drift checks did not run.
   */
  readonly notice?: string;
  /**
   * Emulated features this schema uses. Absent when there are none.
   * A refused feature throws OKM1860 before this returns.
   */
  readonly emulation?: string;
  /**
   * Project ignores from `defineConfig({ warnings })`, with `applied` or
   * `stale` on a rule `okm check` evaluates.
   *
   * Absent when the config lists none. `okm check` prints them.
   */
  readonly ignores?: readonly IgnoreReport[];
  /**
   * Schema rule findings (OKM2101 to OKM2103) that are not ignored and not
   * `off`. Absent when there are none. A finding at level `error` throws
   * instead.
   */
  readonly advice?: readonly SchemaAdvice[];
  /**
   * Every `-- okm-allow` line in the migrations directory.
   *
   * Empty when there are none. A weak reason is already a warning in
   * `findings`.
   */
  readonly allows: readonly AllowEntry[];
};

/**
 * Validates the schema, then reports stale renames and unlisted table files.
 *
 * When exactly one target is configured, or `--target` names one, the
 * read-only `check` and `drift` classes are allowed and a database that
 * already has `okm_meta` is compared with the schema. A difference is
 * OKM1520. Several targets and no `--target` skip that comparison and print
 * {@link serverChecksSkippedNotice}.
 *
 * The Postgres major (OKM1802 / OKM1803) is checked before author drift. A
 * missing extension is OKM1811 only when no applied or pending migration
 * creates it; that check runs after drift (#400).
 *
 * Lint findings are computed from the plan and the catalog before any
 * connection. An error finding is OKM1510. Warnings are returned.
 *
 * @param project - Project directory or {@link ProjectContext}
 * @param flags - `--target`, when the caller passed one
 * @returns Warning findings and an optional skip notice. Errors throw
 */
export async function checkProject(
  project: string | ProjectContext,
  flags?: InvokeFlags,
): Promise<CheckProjectResult> {
  const opened = await openProject(project);
  const { cwd } = opened;
  const emulation = featureNotes(opened.built.catalog);
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
      throw attachCliDetail(
        new OkmError("OKM1024", `Table file not in schema: ${missing.join(", ")}.`, {
          fix: { summary: "Add the file's table to the schema() call that okm check reads." },
        }),
        { location: { file: projectPath(cwd, opened.config.schema) } },
      );
    }
  }
  assertSnapshots(cwd, opened.config, opened.built.catalog);
  const { rawOnlineCheck } = await import("../describe/command.js");
  const allows = listAllows(projectPath(cwd, opened.config.migrations ?? "migrations"));
  const findings = [...(await offlineFindings(opened))];
  if (hasError(findings)) throw lintRefusal(findings);
  findings.push(...allowFindings(allows));
  const { advice, ignores } = schemaAdvice(
    opened.built,
    projectFilterUses(cwd, opened.config),
    opened.config.warnings ?? {},
  );
  const refusal = adviceRefusal(advice);
  if (refusal !== undefined) throw refusal;
  const named = flags?.target;
  const finish = (result: Omit<CheckProjectResult, "allows">): CheckProjectResult => {
    const listed = {
      ...result,
      ...(advice.length > 0 ? { advice } : {}),
      ...(ignores.length > 0 ? { ignores } : {}),
      allows,
    };
    return checked(listed, emulation);
  };
  if (targets.length === 0) return finish({ findings });
  if (targets.length > 1 && named === undefined) {
    const { serverChecksSkippedNotice } = await import("./server-requirements.js");
    return finish({ findings, notice: serverChecksSkippedNotice(targets.length) });
  }
  const target = selectTarget(opened.config, named);
  assertTargetPolicy(target, "check", flags?.allowProtected ?? false);
  assertTargetPolicy(target, "drift", flags?.allowProtected ?? false);
  const { assertAuthorDrift } = await import("./drift.js");
  const allowPooler = flags?.allowPooler === true || opened.config.allowPooler === true;
  await assertLiveExternal(target.url, opened.built.catalog, loadSnapshots(cwd, opened.config));
  const { assertSchemaMajor, assertSchemaExtensions, extensionsCreatedByMigrations } =
    await import("./server-requirements.js");
  const created = extensionsCreatedByMigrations(
    projectPath(cwd, opened.config.migrations ?? "migrations"),
  );
  await assertSchemaMajor(target.url, opened.built);
  await assertAuthorDrift(target.url, opened.built.catalog, opened.config.roles, allowPooler);
  await assertSchemaExtensions(target.url, opened.built, created);
  await rawOnlineCheck(cwd, opened.config, target.url, allowPooler);
  return finish({ findings });
}

/**
 * Postgres features this catalog uses, or OKM1860 when one is refused.
 *
 * @param catalog - Catalog about to be written or checked
 * @returns Emulation notes, or `""` when every used feature is native
 */
function featureNotes(catalog: Catalog): string {
  return formatEmulation(assertSupported(featuresUsed(catalog), POSTGRES_FEATURES, "postgres"));
}

function checked(result: CheckProjectResult, emulation: string): CheckProjectResult {
  if (emulation.length === 0) return result;
  return { ...result, emulation };
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
 * @param project - Project directory or {@link ProjectContext}
 * @returns The previous snapshot, the current catalog, and declared renames
 */
export async function projectHead(project: string | ProjectContext): Promise<{
  readonly previous: Catalog;
  readonly catalog: Catalog;
  readonly renames: readonly DeclaredRename[];
}> {
  const opened = await openProject(project);
  return { previous: opened.previous, catalog: opened.built.catalog, renames: opened.renames };
}

async function prepare(
  project: string | ProjectContext,
  name: string,
  flags: readonly string[],
): Promise<{
  readonly config: MigrateConfig;
  readonly built: Built;
  readonly plan: MigrationPlan;
  readonly before: Catalog;
  readonly after: Catalog;
}> {
  const opened = await openProject(project);
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
 * Lock callback when a selected target answers.
 *
 * A connection or query failure returns `undefined` and does not throw.
 * The printed lock is then the offline lock. Protection and an unknown
 * `--target` still throw: those are the same refusals the other read-only
 * commands use. A pooler is not refused.
 *
 * @param config - Project config
 * @param plan - Plan to annotate
 * @param invoke - Target flags
 * @returns Annotated locks, or `undefined` for the offline lock text
 */
async function planLockText(
  config: MigrateConfig,
  plan: MigrationPlan,
  invoke: InvokeFlags | undefined,
): Promise<((step: PlanStep) => string) | undefined> {
  const targets = listTargets(config);
  if (targets.length === 0) return undefined;
  assertTargetAlias(targets);
  const named = invoke?.target;
  if (named === undefined && targets.length !== 1) return undefined;
  const target = selectTarget(config, named);
  assertTargetPolicy(target, "plan", invoke?.allowProtected ?? false);
  let estimates: ReadonlyMap<string, RowEstimate>;
  try {
    const names = plan.steps.flatMap((step) => step.tables ?? []);
    estimates = await readRowEstimates(target.url, catalogNamespace(config), names);
  } catch {
    return undefined;
  }
  const aliases = renameAliases(plan.steps);
  return (step) => annotateLock(step, estimates, aliases);
}

/**
 * Findings `okm check` computes before it connects: the plan lint, the type
 * preferences, cross-catalog keys, and typed raw drift.
 *
 * @param opened - Result of {@link openProject}
 * @returns Findings of every severity, in the order `okm check` reports them
 */
export async function offlineFindings(opened: {
  readonly cwd: string;
  readonly built: Built;
  readonly previous: Catalog;
  readonly renames: readonly DeclaredRename[];
  readonly config: MigrateConfig;
}): Promise<readonly Finding[]> {
  const { rawOfflineFindings } = await import("../describe/command.js");
  return [
    ...lintOpened(opened),
    ...couplingFindings(opened.built.catalog),
    ...(await rawOfflineFindings(opened.cwd, opened.config)),
  ];
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
 * @param project - Project directory or {@link ProjectContext}
 * @returns The loaded project
 */
export async function openProject(project: string | ProjectContext): Promise<{
  readonly cwd: string;
  readonly config: MigrateConfig;
  readonly built: Built;
  readonly previous: Catalog;
  readonly renames: readonly DeclaredRename[];
}> {
  const { cwd } = asProject(project);
  const config = await loadConfig(project);
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
    cwd,
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
 * Text `okm generate init` and `okm init` write for LF migration files.
 *
 * An existing `.gitattributes` is left unchanged. These commands do not
 * append to a file the project already has.
 *
 * @returns The file body, including the trailing newline
 */
export function migrationGitAttributes(): string {
  return GIT_ATTRIBUTES;
}

/**
 * Writes `.gitattributes` for LF migration and catalog files.
 *
 * An existing file is left unchanged, including one that does not list these
 * patterns.
 *
 * @param cwd - Project directory
 */
function writeGitAttributes(cwd: string): void {
  const path = projectPath(cwd, ".gitattributes");
  if (existsSync(path)) return;
  writeFileSync(path, migrationGitAttributes());
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
  writeNamespace(directory, catalogNamespace(config));
  return directory;
}

/**
 * Records the catalog schema next to the hash.
 *
 * `connect()` reads this file. `public` deletes a stale file so the startup
 * query stays the unqualified text.
 *
 * @param directory - `.okm` directory
 * @param namespace - Schema from `defineConfig`
 */
function writeNamespace(directory: string, namespace: string): void {
  const path = join(directory, "namespace");
  if (namespace === "public") {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  writeFileSync(path, `${namespace}\n`);
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
export async function exportProject(
  project: string | ProjectContext,
  args: readonly string[],
): Promise<string> {
  const { cwd } = asProject(project);
  const config = await loadConfig(project);
  const built = await loadBuiltSchema(cwd, config);
  return renderExport(cwd, config, built.catalog, args);
}

/**
 * Loads `okmodel.config.ts` (or the path from `--config`).
 *
 * The file is the nearest config upward from the working directory. Two
 * configs at that same distance are OKM1891. `--config` skips the search.
 *
 * @param project - Project directory or {@link ProjectContext}
 * @returns The config object
 */
export async function loadConfig(project: string | ProjectContext): Promise<MigrateConfig> {
  const resolved = asProject(project);
  if (resolved.ambiguous !== undefined) refuseAmbiguousConfigs(resolved.ambiguous);
  const { configPath } = resolved;
  if (!existsSync(configPath)) {
    throw tagOutcome(
      new OkmError("invalid", `Missing ${configPath}.`, {
        fix: {
          summary: `Create ${configPath}, or pass --config <path>.`,
        },
      }),
      "usage",
    );
  }
  const imported: unknown = await import(`${pathToFileURL(configPath).href}?okm=${Date.now()}`);
  const record = isRecord(imported) ? imported : {};
  const config = record.default ?? record.config;
  if (!isConfig(config)) {
    throw tagOutcome(
      new OkmError("invalid", `${CONFIG_FILE} must default-export defineConfig(...).`),
      "usage",
    );
  }
  try {
    assertProjectWarnings(config.warnings);
  } catch (error) {
    if (error instanceof OkmError) throw tagOutcome(error, "usage");
    throw error;
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
    throw tagOutcome(
      new OkmError("invalid", `Migration name ${name} must be letters, digits, _ or -.`),
      "usage",
    );
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
