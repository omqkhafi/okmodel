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
  settleChecks,
  startupCatalog,
} from "../../contracts/catalog/document.js";
import { sha256 } from "../../contracts/sha256.js";
import { OkmError } from "../../contracts/error.js";
import { assertProjectWarnings } from "../../runtime/warnings/config.js";
import { missingPostgres, tagOutcome } from "../cli/outcome.js";
import { cliNote } from "../cli/notices.js";
import { assertSupported, formatEmulation } from "../capabilities/check.js";
import { POSTGRES_FEATURES } from "../capabilities/postgres.js";
import { featuresUsed } from "../capabilities/used.js";
import { errorDoc } from "../errors/registry.js";
import { attachCliDetail } from "../errors/shape.js";
import { assertValidation, writeWouldValidate } from "../../runtime/validate/places.js";
import { schemaDeclarations, type DeclaredRename } from "../../dialects/pg/declarations.js";
import { emitRowTypes, jsonColumnTypes } from "../../dialects/pg/emit.js";
import { stampOwnership, tableOwner } from "../../dialects/pg/owner.js";
import { grantsNeedRoles } from "../../dialects/pg/role/grants.js";
import { readGrants } from "../../dialects/pg/role/grant-slot.js";
import { attachRoles, type RolesInput, type TableExposure } from "../../dialects/pg/role/index.js";
import type { BuiltSchema } from "../../dialects/pg/schema.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { assertNotEnforcedDeclared } from "./requirements.js";
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
import { OPTIONAL_CONNECT_SECONDS, SKIPPED_READ_NOTE, skippableRead } from "./optional-read.js";
import {
  assertTargetAlias,
  assertTargetPolicy,
  listTargets,
  selectTarget,
  type InvokeFlags,
} from "./policy.js";
import { refuseAmbiguousConfigs } from "./discover.js";
import { asProject, CONFIG_FILE, projectPath, type ProjectContext } from "./paths.js";
import { readUnpulled, unpulledKeys } from "./unpulled.js";
import { formatPlanJson, type WeightEstimate } from "./plan-json.js";
import type { Fill, ProbeCount } from "./data-probe.js";
import {
  columnSwaps,
  formatPlan,
  planStatements,
  requiredChanges,
  staleRenames,
  type ColumnSwap,
  type MigrationPlan,
  type PlanStep,
} from "./plan.js";

/** Flags and the terminal shared by generate and plan. */
type DataOptions = {
  readonly renames?: readonly string[];
  readonly dropAndAdd?: boolean;
  readonly fills?: readonly string[];
  readonly terminal?: boolean;
  readonly ask?: (label: string) => Promise<string>;
  readonly write?: (text: string) => void;
  readonly url?: string;
};
import { allowFindings, listAllows, type AllowEntry } from "./allows.js";
import { acknowledgeDrops, plannedDrops, type ConfirmDrops } from "./confirm-drop.js";
import { projectFilterUses } from "./filter-scan.js";
import {
  hasError,
  lintCatalog,
  lintMigrationDirectory,
  lintPlan,
  lintRefusal,
  type Finding,
} from "./lint.js";
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
 * An empty plan writes nothing. A pending migration that still has an error
 * finding is returned again, so a retry does not look clean. The file is SQL,
 * not TypeScript.
 *
 * @param project - Project directory or {@link ProjectContext}
 * @param name - Migration name
 * @param flags - `--replace` values
 * @param confirm - Asked when the plan drops an object. A reason writes `-- okm-allow` on those steps
 * @returns The SQL path and lint findings, or `undefined` when nothing changed
 * @throws OkmError OKM1510 when `confirm` declines the drops. Nothing is written
 */
export async function generateProject(
  project: string | ProjectContext,
  name: string,
  flags: readonly string[],
  confirm?: ConfirmDrops,
  data?: DataOptions,
): Promise<
  | { readonly path: string; readonly findings: readonly Finding[]; readonly preface?: string }
  | undefined
> {
  const { cwd } = asProject(project);
  const opened = await openProject(project);
  const shaped = await shapePlan(opened, name, flags, data, "generate");
  if (shaped.unreachable) cliNote(SKIPPED_READ_NOTE);
  if (shaped.note !== undefined) cliNote(shaped.note);
  if (name === "init") writeGitAttributes(cwd);
  writeArtifact(cwd, shaped.config, shaped.built);
  const directory = projectPath(cwd, shaped.config.migrations ?? "migrations");
  if (shaped.plan.steps.length === 0) return pendingLint(directory);
  let plan = shaped.plan;
  let findings = lintPrepared(shaped);
  const drops = confirm === undefined ? [] : await notedDrops(plan, findings, shaped);
  if (confirm !== undefined && drops.length > 0) {
    const reason = await confirm(drops);
    if (reason === undefined) {
      throw new OkmError(
        "OKM1510",
        "The migration drops data and was not confirmed. Nothing was written.",
        {
          fix: {
            summary: "Put the object back in the schema, or run okm generate again and answer y.",
          },
        },
      );
    }
    plan = acknowledgeDrops(plan, drops, reason);
    findings = lintPrepared({ ...shaped, plan });
  }
  mkdirSync(directory, { recursive: true });
  const base = `${nextNumber(directory)}_${safeName(name)}`;
  const sqlPath = join(directory, `${base}.sql`);
  writeFileSync(sqlPath, formatPlan(plan));
  writeFileSync(join(directory, `${base}.catalog.json`), serializeCatalog(shaped.built.catalog));
  const preface = prefaceOf(sqlPath, shaped);
  return { path: sqlPath, findings, ...(preface === undefined ? {} : { preface }) };
}

/**
 * The pending SQL that still has an error finding, when the new plan is empty.
 *
 * @param directory - Migrations directory
 * @returns That file and its findings, or `undefined` when none remain
 */
async function shapePlan(
  opened: Awaited<ReturnType<typeof openProject>>,
  name: string,
  flags: readonly string[],
  data: DataOptions | undefined,
  mode: "generate" | "plan",
): Promise<{
  readonly config: MigrateConfig;
  readonly built: Built;
  readonly plan: MigrationPlan;
  readonly before: Catalog;
  readonly after: Catalog;
  readonly unreachable: boolean;
  readonly empty: ReadonlyMap<string, ProbeCount>;
  readonly fills: readonly Fill[];
  readonly lines: readonly string[];
  readonly note?: string;
  readonly renamed: boolean;
  readonly schema: string;
  readonly url?: string;
}> {
  const schema = catalogNamespace(opened.config);
  const url = data?.url ?? targetUrl(opened.config);
  const swaps = columnSwaps(opened.previous, opened.built.catalog, opened.renames);
  const choice: { extra: DeclaredRename[]; accept: ColumnSwap[] } = { extra: [], accept: [] };
  if (!swaps.blocked && swaps.clear.length > 0) {
    const { decideSwaps } = await import("./data-questions.js");
    const decidedSwaps = await decideSwaps({
      before: opened.previous,
      after: opened.built.catalog,
      renames: opened.renames,
      schema,
      ...(url === undefined ? {} : { url }),
      terminal: data?.terminal === true && mode === "generate",
      renameFlags: data?.renames ?? [],
      dropAndAdd: data?.dropAndAdd === true,
      ...(data?.ask === undefined ? {} : { ask: data.ask }),
      ...(data?.write === undefined ? {} : { write: data.write }),
    });
    choice.extra.push(...decidedSwaps.extra);
    choice.accept.push(...decidedSwaps.accept);
  }
  const compared = await comparedPlan(
    opened,
    name,
    flags.map((flag) => parseReplace(flag)),
    {
      extraRenames: choice.extra,
      acceptSwaps: choice.accept,
    },
  );
  const live = compared.unreachable ? undefined : url;
  const renames = [...opened.renames, ...choice.extra];
  const changes = requiredChanges(opened.previous, opened.built.catalog, renames);
  let decided: {
    fills: readonly Fill[];
    lines: readonly string[];
    empty: ReadonlyMap<string, ProbeCount>;
    note?: string;
  } = { fills: [], lines: [], empty: new Map() };
  if (changes.length > 0 || (data?.fills?.length ?? 0) > 0) {
    const { decideFills } = await import("./data-questions.js");
    decided = await decideFills({
      before: opened.previous,
      after: opened.built.catalog,
      schema,
      ...(live === undefined ? {} : { url: live }),
      mode,
      terminal: data?.terminal === true && mode === "generate",
      fillFlags: data?.fills ?? [],
      renames,
      ...(data?.ask === undefined ? {} : { ask: data.ask }),
      ...(data?.write === undefined ? {} : { write: data.write }),
    });
  }
  let plan = compared.plan;
  if (decided.fills.length > 0) {
    const { spliceFills } = await import("./data-splice.js");
    plan = spliceFills(
      compared.plan,
      decided.fills,
      [opened.previous, opened.built.catalog, compared.before, compared.after],
      schema,
      opened.config.backfill?.batchSize,
    );
  }
  return {
    config: opened.config,
    built: opened.built,
    plan,
    before: compared.before,
    after: compared.after,
    unreachable: compared.unreachable,
    empty: decided.empty,
    fills: decided.fills,
    lines: decided.lines,
    ...(decided.note === undefined ? {} : { note: decided.note }),
    renamed: choice.extra.length > 0,
    schema,
    ...(live === undefined ? {} : { url: live }),
  };
}

function targetUrl(config: MigrateConfig, invoke?: InvokeFlags): string | undefined {
  const targets = listTargets(config);
  if (invoke?.target !== undefined) return selectTarget(config, invoke.target).url;
  return targets.length === 1 ? targets[0]?.url : undefined;
}

async function notedDrops(
  plan: MigrationPlan,
  findings: readonly Finding[],
  shaped: { readonly url?: string; readonly schema: string },
): Promise<ReturnType<typeof plannedDrops>> {
  const drops = plannedDrops(plan, findings);
  if (shaped.url === undefined || !drops.some((drop) => drop.sql.includes("drop column")))
    return drops;
  const { dropHolds, probeTarget } = await import("./data-probe.js");
  const parsed = drops.map((drop) => ({ drop, column: columnOfDrop(drop.sql) }));
  const hits = await probeTarget(
    shaped.url,
    shaped.schema,
    parsed.flatMap((item) =>
      item.column === undefined
        ? []
        : [{ table: item.column.table, column: item.column.column, which: "notNull" as const }],
    ),
  );
  if (hits === "unreachable") return drops;
  return parsed.map(({ drop, column }) => {
    if (column === undefined) return drop;
    const count = hits.find(
      (hit) =>
        hit.table === column.table && hit.column === column.column && hit.which === "notNull",
    )?.count;
    const holds = dropHolds(column.column, count);
    return holds.length === 0 ? drop : { ...drop, holds };
  });
}

function columnOfDrop(
  sql: string,
): { readonly table: string; readonly column: string } | undefined {
  const match = /^alter table\s+(\S+)\s+drop column\s+(\S+)/.exec(sql);
  if (match === null) return undefined;
  const tableNames = [...(match[1] ?? "").matchAll(/"((?:[^"]|"")*)"/g)];
  const table = tableNames.at(-1)?.[1]?.replaceAll('""', '"') ?? match[1] ?? "";
  const quoted = /^"((?:[^"]|"")*)"$/.exec(match[2] ?? "");
  const column = quoted === null ? (match[2] ?? "") : (quoted[1] ?? "").replaceAll('""', '"');
  return { table, column };
}

function prefaceOf(
  path: string,
  shaped: {
    readonly lines: readonly string[];
    readonly fills: readonly Fill[];
    readonly renamed: boolean;
    readonly plan: MigrationPlan;
  },
): string | undefined {
  const lines = [...shaped.lines];
  const file = basename(path);
  if (shaped.fills.length > 0) {
    const batch =
      shaped.plan.steps.find((step) => step.backfill !== undefined)?.backfill?.batch ?? 1000;
    lines.push(
      `I wrote ${file}: fill in batches of ${batch.toLocaleString("en-US")}, add the check not valid, fill again, validate, set not null.`,
    );
  } else if (shaped.renamed) {
    lines.push(`I wrote ${file}. Nothing runs until you apply it.`);
  }
  if (lines.length === 0) return undefined;
  return `${lines.join("\n")}\n`;
}

function pendingLint(
  directory: string,
): { readonly path: string; readonly findings: readonly Finding[] } | undefined {
  const findings = lintMigrationDirectory(directory);
  if (!hasError(findings)) return undefined;
  const id = findings.find((item) => item.severity === "error")?.place.split(" ")[0];
  const path = id === undefined ? directory : join(directory, `${id}.sql`);
  return { path, findings };
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
  data?: DataOptions,
): Promise<{
  readonly plan: MigrationPlan;
  readonly findings: readonly Finding[];
  readonly text: string;
  readonly json: string;
}> {
  const opened = await openProject(project);
  const url = data?.url ?? targetUrl(opened.config, invoke);
  const prepared = await shapePlan(
    opened,
    name,
    flags,
    { ...data, ...(url === undefined ? {} : { url }) },
    "plan",
  );
  const findings = lintPrepared(prepared);
  const locks = await planLockText(prepared.config, prepared.plan, invoke, prepared.unreachable);
  if (prepared.unreachable || locks.skipped) cliNote(SKIPPED_READ_NOTE);
  let show = locks.annotate;
  let rows:
    | readonly ({ readonly emptyRows: number | string; readonly fill?: string } | undefined)[]
    | undefined;
  if (prepared.empty.size > 0) {
    const { annotateProbe, stepData } = await import("./data-probe.js");
    show = (step) => {
      const base = locks.annotate === undefined ? step.lock : locks.annotate(step);
      return annotateProbe(step, base, prepared.empty, prepared.fills);
    };
    rows = prepared.plan.steps.map((step) => stepData(step, prepared.empty, prepared.fills));
  }
  return {
    plan: prepared.plan,
    findings,
    text: formatPlan(prepared.plan, show),
    json: formatPlanJson(
      prepared.plan,
      findings,
      show,
      {
        dialect: "postgres",
        fromCatalogHash: catalogHash(prepared.before),
        toCatalogHash: catalogHash(prepared.after),
      },
      rows,
      locks.weigh,
    ),
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
  const { assertSchemaMajor, assertSchemaExtensions } = await import("./server-requirements.js");
  const directory = projectPath(cwd, opened.config.migrations ?? "migrations");
  await assertSchemaMajor(target.url, opened.built);
  await assertAuthorDrift(
    target.url,
    opened.built.catalog,
    opened.config.roles,
    allowPooler,
    unpulledKeys(readUnpulled(cwd)),
  );
  await assertSchemaExtensions(target.url, opened.built, directory);
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
 * A connection or query failure returns no callback and `skipped: true`, and
 * does not throw. The printed lock is then the offline lock. `known` says a
 * read of this target has already failed in this command, so it is not tried
 * again. Protection and an unknown `--target` still throw: those are the same
 * refusals the other read-only commands use. A pooler is not refused.
 *
 * @param config - Project config
 * @param plan - Plan to annotate
 * @param invoke - Target flags
 * @param known - `true` when the live comparison already found the target unreachable
 * @returns Annotated locks, or none for the offline lock text, and whether the read was skipped
 */
async function planLockText(
  config: MigrateConfig,
  plan: MigrationPlan,
  invoke: InvokeFlags | undefined,
  known: boolean,
): Promise<{
  readonly annotate?: (step: PlanStep) => string;
  readonly weigh?: (step: PlanStep) => WeightEstimate | undefined;
  readonly skipped: boolean;
}> {
  const targets = listTargets(config);
  if (targets.length === 0) return { skipped: false };
  assertTargetAlias(targets);
  const named = invoke?.target;
  if (named === undefined && targets.length !== 1) return { skipped: false };
  const target = selectTarget(config, named);
  assertTargetPolicy(target, "plan", invoke?.allowProtected ?? false);
  if (known) return { skipped: true };
  let estimates: ReadonlyMap<string, RowEstimate>;
  try {
    const names = plan.steps.flatMap((step) => step.tables ?? []);
    estimates = await readRowEstimates(target.url, catalogNamespace(config), names);
  } catch {
    return { skipped: true };
  }
  const aliases = renameAliases(plan.steps);
  if (!plan.steps.some((step) => step.weight !== undefined)) {
    return { annotate: (step) => annotateLock(step, estimates, aliases), skipped: false };
  }
  const { planCounts, weightPhrase, widest, estimateMs } = await import("./weight.js");
  const counts = await planCounts(target.url, catalogNamespace(config), plan.steps, estimates);
  return {
    annotate: (step) => {
      const base = annotateLock(step, estimates, aliases);
      if (step.weight === undefined) return base;
      const big = widest(step, counts);
      return `${base}; ${weightPhrase(step.weight, big?.table ?? "", big?.count)}`;
    },
    weigh: (step) => {
      const big = step.weight === undefined ? undefined : widest(step, counts);
      if (step.weight === undefined || big === undefined) return undefined;
      return {
        estimatedRows: big.count.least
          ? `${big.count.rows.toLocaleString("en-US")} or more`
          : Math.round(big.count.rows),
        estimateMs: estimateMs(step.weight, big.count.rows),
      };
    },
    skipped: false,
  };
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
    ...(await lintOpened(opened)),
    ...couplingFindings(opened.built.catalog),
    ...(await rawOfflineFindings(opened.cwd, opened.config)),
  ];
}

async function lintOpened(opened: {
  readonly built: Built;
  readonly previous: Catalog;
  readonly renames: readonly DeclaredRename[];
  readonly config: MigrateConfig;
}): Promise<readonly Finding[]> {
  const compared = await comparedPlan(opened, "check");
  return [
    ...lintPlan(compared.plan, compared.before, compared.after),
    ...lintCatalog(opened.built.catalog),
  ];
}

/**
 * Plans `previous` against the schema.
 *
 * An empty plan does not connect. A first migration has nothing to compare
 * against and does not connect. One target with steps reprints both catalogs
 * and plans again, so server normalisation is not a migration. That read is
 * optional (D329): a connection that fails or a missing `postgres` package
 * keeps the unsealed plan and sets `unreachable`.
 */
async function comparedPlan(
  opened: {
    readonly built: Built;
    readonly previous: Catalog;
    readonly renames: readonly DeclaredRename[];
    readonly config: MigrateConfig;
  },
  name: string,
  replacements: ReturnType<typeof parseReplace>[] = [],
  choice?: {
    readonly extraRenames?: readonly DeclaredRename[];
    readonly acceptSwaps?: readonly {
      readonly table: string;
      readonly from: string;
      readonly to: string;
    }[];
  },
): Promise<{
  readonly plan: MigrationPlan;
  readonly before: Catalog;
  readonly after: Catalog;
  readonly unreachable: boolean;
}> {
  const input = {
    before: opened.previous,
    after: opened.built.catalog,
    renames: [...opened.renames, ...(choice?.extraRenames ?? [])],
    replacements,
    ...(choice?.acceptSwaps !== undefined && choice.acceptSwaps.length > 0
      ? { acceptSwaps: choice.acceptSwaps }
      : {}),
    name,
    ...placedSchema(opened.config),
    ...batchSizeField(opened.config.backfill?.batchSize),
  };
  const draft = planStatements(input);
  const plain = {
    plan: draft,
    before: opened.previous,
    after: opened.built.catalog,
    unreachable: false,
  };
  if (draft.steps.length === 0 || opened.previous.objects.length === 0) return plain;
  const targets = listTargets(opened.config);
  const target = targets.length === 1 ? targets[0] : undefined;
  if (target === undefined) return plain;
  const sealed = await sealCatalogs(target.url, opened.previous, opened.built.catalog);
  if (sealed === undefined) return { ...plain, unreachable: true };
  return {
    plan: planStatements({
      ...input,
      before: sealed.before,
      after: sealed.after,
      postgres: sealed.postgres,
      authored: { before: opened.previous, after: opened.built.catalog },
    }),
    before: sealed.before,
    after: sealed.after,
    unreachable: false,
  };
}

async function sealCatalogs(
  url: string,
  before: Catalog,
  after: Catalog,
): Promise<
  { readonly before: Catalog; readonly after: Catalog; readonly postgres: number } | undefined
> {
  try {
    const [{ catalogQuery, sealAuthored }, { driverUrl }, postgres] = await Promise.all([
      import("./drift.js"),
      import("./driver-url.js"),
      import("postgres"),
    ]);
    const sql = postgres.default(driverUrl(url), {
      max: 1,
      connect_timeout: OPTIONAL_CONNECT_SECONDS,
      idle_timeout: 1,
      onnotice: () => {},
    });
    try {
      const version = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
      const runner = catalogQuery(sql);
      return {
        before: await sealAuthored(runner, before),
        after: await sealAuthored(runner, after),
        postgres: Math.floor(Number(version[0]?.v ?? "0") / 10_000),
      };
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof OkmError || !skippableRead(error)) throw error;
    return undefined;
  }
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
  assertNotEnforcedDeclared(built.catalog, built.requires?.postgres);
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
  const grants = tableGrantMap(built);
  if ((grants.size > 0 || catalogRememberedGrants(placed)) && roles === undefined) {
    throw grantsNeedRoles("the schema");
  }
  const catalog =
    roles === undefined
      ? placed
      : attachRoles(
          placed,
          roles,
          exposureFor(built, roles),
          grants,
          postgresFloor(built.requires?.postgres),
        );
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

function postgresFloor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /(\d+)/.exec(value);
  if (match === null) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : undefined;
}

function catalogRememberedGrants(source: Catalog): boolean {
  for (const object of source.objects) {
    if (
      object.kind !== "view" &&
      object.kind !== "materializedView" &&
      object.kind !== "function"
    ) {
      continue;
    }
    const namespace = object.identity.namespace;
    const schema = namespace.form === "static" ? namespace.name : undefined;
    if (schema === undefined) continue;
    if (readGrants(object.kind, schema, object.identity.name) !== undefined) return true;
  }
  return false;
}

function tableGrantMap(built: Built): ReadonlyMap<string, unknown> {
  const map = new Map<string, unknown>();
  const models = built.model as Readonly<Record<string, { readonly sql: string }>>;
  for (const table of built.tables) {
    const options = (table as { readonly options?: { readonly grants?: unknown } }).options;
    if (options?.grants === undefined) continue;
    map.set(models[table.name]?.sql ?? table.name, options.grants);
  }
  return map;
}

function exposureFor(built: Built, roles: RolesInput): readonly TableExposure[] | undefined {
  if (roles.reporting === undefined) return undefined;
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
      new OkmError("OKM1895", `Missing ${configPath}.`, {
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
  let imported: unknown;
  try {
    imported = await import(`${pathToFileURL(path).href}?okm=${Date.now()}`);
  } catch (error) {
    throw loadFailure(error, spec);
  }
  const record = isRecord(imported) ? imported : {};
  for (const value of Object.values(record)) {
    if (!isBuilt(value)) continue;
    void value.catalog;
    settleChecks(value.catalog);
    return value;
  }
  throw new OkmError("invalid", `${spec} must export a schema().`);
}

/**
 * The error for a schema file that threw while it loaded.
 *
 * Only an unmapped throw gets the new fix text. An OKM code, a driver error,
 * and a missing `postgres` package keep what they carry.
 */
function loadFailure(error: unknown, spec: string): unknown {
  if (error instanceof OkmError || missingPostgres(error) !== undefined) return error;
  const mapped = OkmError.from(error);
  if (mapped.code !== "driver") return error;
  return new OkmError(mapped.code, mapped.message, {
    kind: mapped.kind,
    cause: error,
    fix: {
      summary: `I could not load ${spec}, so I changed nothing. Fix the error above in that file or in what it imports, then run the command again.`,
    },
  });
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
