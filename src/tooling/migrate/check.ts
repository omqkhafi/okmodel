/**
 * `okm migrate check` proves a migration history is sound (D196).
 *
 * The command replays every file into a scratch schema through
 * {@link applyTarget}, then plans the introspected schema back to that
 * file's catalog. It also checks the previous catalog, the head, and the
 * linter. Nothing here changes apply.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { catalog } from "../../contracts/catalog/build.js";
import { parseCatalog } from "../../contracts/catalog/document.js";
import { isDomain } from "../../contracts/catalog/enum.js";
import { identityKey } from "../../contracts/catalog/identity.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  TypeDefinition,
} from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { introspectSchema } from "../../dialects/pg/introspect.js";
import { sealViews } from "../../dialects/pg/view/scratch.js";
import { applyTarget, backfillTiming } from "./apply.js";
import { snapshotDifference } from "./snapshot.js";
import { canonicalTypeName } from "./type-name.js";
import { classOf, strictestClass, type MigrationClass } from "./classify.js";
import type { MigrateConfig } from "./config.js";
import { catalogQuery, managedRoleOptions } from "./drift.js";
import { catalogsEqual } from "./equal.js";
import { loadMigrations } from "./files.js";
import { hasError, lintMigrationDirectory, lintRefusal } from "./lint.js";
import { parsePlan, planMigration, type MigrationPlan, type PlanStep } from "./plan.js";
import { selectTarget, type InvokeFlags } from "./policy.js";
import { openProject } from "./project.js";

/** Prefix of the scratch schema. The random suffix makes the name unique. */
export const CHECK_SCHEMA_PREFIX = "okm_check_";

const HISTORY_CODE = "OKM1547";
const PREVIOUS_CODE = "OKM1548";
const STALE_CODE = "OKM1549";

const HISTORY_FIX =
  "Regenerate the migration so the stored catalog matches the schema the SQL applies.";
const FORK_FIX =
  "Generate the later migration from the previous migration's catalog, not from an older parent.";
const PREVIOUS_FIX =
  "Keep every table, column, constraint, and type the previous catalog relies on, or classify the migration as contract.";
const STALE_FIX = "Run okm generate.";

type HistoryEntry = {
  readonly id: string;
  readonly catalogHash: string;
  readonly steps: readonly PlanStep[];
  readonly plan: MigrationPlan;
  readonly catalog: Catalog;
};

type CheckFailure = {
  readonly code: string;
  readonly message: string;
  readonly fix: string;
};

/**
 * Runs `okm migrate check` for the project in `cwd`.
 *
 * A protected target is refused before any statement. The scratch schema is
 * dropped before this returns, including when a check fails. `--allow-protected`
 * does not lift the refusal.
 *
 * @param cwd - Project directory
 * @param flags - `--target` and pooler. Protection is ignored
 * @param options - `--provision` also compares a snapshot install with a full replay
 * @returns One summary line, ending in a newline
 */
export async function checkMigrations(
  cwd: string,
  flags: InvokeFlags,
  options?: { readonly provision?: boolean },
): Promise<string> {
  const opened = await openProject(cwd);
  const target = selectTarget(opened.config, flags.target);
  if (target.protected) {
    throw new OkmError(
      "OKM1850",
      `okm migrate check writes a scratch schema and refuses protected target ${target.name}. Point it at a throwaway Postgres.`,
      {
        kind: "forbidden",
        fix: {
          summary:
            "Point okm migrate check at a throwaway Postgres. --allow-protected does not apply.",
        },
      },
    );
  }
  const directory = join(cwd, opened.config.migrations ?? "migrations");
  const history = readHistory(directory);
  if (options?.provision === true) {
    const equivalence = await proveSnapshot(opened.config, target.url, target.name, flags, history);
    if (equivalence !== undefined) throwFailure([equivalence]);
  }
  const previous = previousFailures(history);
  const stale = staleFailure(history, opened.built.catalog);
  const lint = lintFailure(directory, history, opened.config.lintFrom);
  const replayed = await replayHistory(opened.config, target.url, target.name, flags, history);
  const failures = [...replayed, ...previous, ...stale, ...lint];
  if (failures.length > 0) throwFailure(failures);
  return `ok ${String(history.length)} migrations\n`;
}

/**
 * Objects in `before` that `after` no longer satisfies.
 *
 * A table, column, constraint, or type that disappeared is a gap. A column
 * whose type changed is a gap. Nullability tightened without a default is a
 * gap. An added object is not.
 *
 * @param before - Previous release catalog
 * @param after - Catalog the migration stores
 * @returns One sentence per gap, in catalog order
 */
export function previousCatalogGaps(before: Catalog, after: Catalog): readonly string[] {
  const afterBy = new Map(after.objects.map((object) => [identityKey(object.identity), object]));
  const gaps: string[] = [];
  for (const object of before.objects) {
    if (!checkedKind(object.kind)) continue;
    const next = afterBy.get(identityKey(object.identity));
    if (next === undefined || next.kind !== object.kind) {
      gaps.push(`${objectLabel(object)} is missing`);
      continue;
    }
    if (object.kind === "column" && next.kind === "column") {
      gaps.push(...columnGaps(object, next));
    }
    if (
      object.kind === "type" &&
      next.kind === "type" &&
      !sameType(object.definition, next.definition)
    ) {
      gaps.push(`${objectLabel(object)} changed`);
    }
  }
  return gaps;
}

/**
 * Class of a migration, from step kinds.
 *
 * A step with no kind is planned from `before` to `after` instead. The
 * `-- class:` comment is not read.
 *
 * @param plan - Parsed migration file
 * @param before - Catalog before the migration
 * @param after - Catalog the file stores
 * @returns The strictest recomputed class
 */
export function recomputedMigrationClass(
  plan: MigrationPlan,
  before: Catalog,
  after: Catalog,
): MigrationClass {
  if (plan.steps.length === 0) return "expand";
  if (plan.steps.some((step) => step.kind === undefined)) {
    return planMigration({ before, after, name: plan.name }).class;
  }
  return strictestClass(plan.steps.map((step) => classOf(step.kind ?? "raw-sql")));
}

/**
 * Whether a previous-catalog gap is allowed.
 *
 * The recomputed class must be `contract`. A file whose steps are classified
 * `expand`, including a hand-edited `-- class:` line, does not allow the gap.
 *
 * @param plan - Parsed migration file
 * @param before - Catalog before the migration
 * @param after - Catalog the file stores
 * @returns `true` when the gap may stand
 */
export function migrationAllowsPreviousGaps(
  plan: MigrationPlan,
  before: Catalog,
  after: Catalog,
): boolean {
  return recomputedMigrationClass(plan, before, after) === "contract" && plan.class !== "expand";
}

function previousFailures(history: readonly HistoryEntry[]): readonly CheckFailure[] {
  const failures: CheckFailure[] = [];
  let before = catalog([]);
  for (const migration of history) {
    const gaps = previousCatalogGaps(before, migration.catalog);
    if (
      gaps.length > 0 &&
      !migrationAllowsPreviousGaps(migration.plan, before, migration.catalog)
    ) {
      const stated =
        migration.plan.class === "expand"
          ? "expand"
          : recomputedMigrationClass(migration.plan, before, migration.catalog);
      failures.push({
        code: PREVIOUS_CODE,
        message: `${migration.id}: previous catalog is not satisfied (${gaps.join("; ")}). The migration is classified ${stated}.`,
        fix: PREVIOUS_FIX,
      });
    }
    before = migration.catalog;
  }
  return failures;
}

function staleFailure(history: readonly HistoryEntry[], head: Catalog): readonly CheckFailure[] {
  const last = history.at(-1)?.catalog ?? catalog([]);
  if (catalogsEqual(last, head)) return [];
  return [
    {
      code: STALE_CODE,
      message: "The last migration's catalog does not match the schema.",
      fix: STALE_FIX,
    },
  ];
}

function lintFailure(
  directory: string,
  history: readonly HistoryEntry[],
  lintFrom: string | undefined,
): readonly CheckFailure[] {
  const findings = lintMigrationDirectory(directory, lintIds(history, lintFrom));
  if (!hasError(findings)) return [];
  const refusal = lintRefusal(findings);
  return [{ code: refusal.code, message: refusal.message, fix: refusal.fix.summary }];
}

function lintIds(
  history: readonly HistoryEntry[],
  lintFrom: string | undefined,
): ReadonlySet<string> | undefined {
  if (lintFrom === undefined) return undefined;
  const ids = history.map((migration) => migration.id);
  const start = ids.indexOf(lintFrom);
  if (start < 0) {
    throw new OkmError("invalid", `lintFrom ${lintFrom} is not a migration id.`, {
      fix: {
        summary:
          "Set lintFrom to a migration id. Files before that id are the adoption baseline and are not linted.",
      },
    });
  }
  return new Set(ids.slice(start));
}

async function proveSnapshot(
  config: MigrateConfig,
  url: string,
  target: string,
  flags: InvokeFlags,
  history: readonly HistoryEntry[],
): Promise<CheckFailure | undefined> {
  const head = history.at(-1);
  if (head === undefined) return undefined;
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  const provided = `${CHECK_SCHEMA_PREFIX}p${crypto.randomUUID().replaceAll("-", "")}`;
  const replayed = `${CHECK_SCHEMA_PREFIX}r${crypto.randomUUID().replaceAll("-", "")}`;
  const timing = {
    ...(flags.lockTimeoutMs !== undefined
      ? { lockTimeoutMs: flags.lockTimeoutMs }
      : config.timeouts?.lock !== undefined
        ? { lockTimeoutMs: config.timeouts.lock }
        : {}),
    ...(flags.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: flags.statementTimeoutMs }
      : config.timeouts?.statement !== undefined
        ? { statementTimeoutMs: config.timeouts.statement }
        : {}),
    ...backfillTiming(config.backfill),
  };
  try {
    await sql.unsafe(`create schema ${quoteIdent(provided)}`);
    await sql.unsafe(`create schema ${quoteIdent(replayed)}`);
    const role =
      config.roles === undefined ? {} : { migrationRole: config.roles.migration, schema: provided };
    await applyTarget({
      url,
      target,
      protected: false,
      allowProtected: false,
      allowPooler: flags.allowPooler || config.allowPooler === true,
      searchPath: provided,
      ...timing,
      migrations: history.map((migration) => ({
        id: migration.id,
        catalogHash: migration.catalogHash,
        steps: migration.steps,
      })),
      snapshot: {
        catalog: head.catalog,
        migrationId: head.id,
        catalogHash: head.catalogHash,
        reference: [],
        only: true,
      },
      ...role,
    });
    await applyTarget({
      url,
      target,
      protected: false,
      allowProtected: false,
      allowPooler: flags.allowPooler || config.allowPooler === true,
      searchPath: replayed,
      ...timing,
      migrations: history.map((migration) => ({
        id: migration.id,
        catalogHash: migration.catalogHash,
        steps: retargetSteps(migration.steps, replayed),
      })),
      ...(config.roles !== undefined
        ? { migrationRole: config.roles.migration, schema: replayed }
        : {}),
    });
    const liveProvided = await introspectScratch(sql, provided, config);
    const liveReplayed = await introspectScratch(sql, replayed, config);
    const difference = snapshotDifference(liveProvided, liveReplayed);
    if (difference === undefined) return undefined;
    return {
      code: "OKM1521",
      message: `Provisioning from the snapshot does not match the replayed history.\n${difference}`,
      fix: "Regenerate the snapshot from the history. okm migrate check --provision is the command that reports this.",
    };
  } finally {
    await sql
      .unsafe(`drop schema if exists ${quoteIdent(provided)} cascade`)
      .catch(() => undefined);
    await sql
      .unsafe(`drop schema if exists ${quoteIdent(replayed)} cascade`)
      .catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

async function replayHistory(
  config: MigrateConfig,
  url: string,
  target: string,
  flags: InvokeFlags,
  history: readonly HistoryEntry[],
): Promise<readonly CheckFailure[]> {
  if (history.length === 0) return [];
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  const scratch = `${CHECK_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  const failures: CheckFailure[] = [];
  try {
    await sql.unsafe(`create schema ${quoteIdent(scratch)}`);
    const runner = catalogQuery(sql);
    for (let index = 0; index < history.length; index += 1) {
      const migration = history[index];
      if (migration === undefined) continue;
      await applyTarget({
        url,
        target,
        protected: false,
        allowProtected: false,
        allowPooler: flags.allowPooler || config.allowPooler === true,
        searchPath: scratch,
        ...(flags.lockTimeoutMs !== undefined
          ? { lockTimeoutMs: flags.lockTimeoutMs }
          : config.timeouts?.lock !== undefined
            ? { lockTimeoutMs: config.timeouts.lock }
            : {}),
        ...(flags.statementTimeoutMs !== undefined
          ? { statementTimeoutMs: flags.statementTimeoutMs }
          : config.timeouts?.statement !== undefined
            ? { statementTimeoutMs: config.timeouts.statement }
            : {}),
        ...backfillTiming(config.backfill),
        migrations: [
          {
            id: migration.id,
            catalogHash: migration.catalogHash,
            steps: retargetSteps(migration.steps, scratch),
          },
        ],
        ...(config.roles !== undefined
          ? { migrationRole: config.roles.migration, schema: scratch }
          : {}),
      });
      const live = await introspectScratch(sql, scratch, config);
      const sealed = await sealViews(runner, migration.catalog);
      const back = planMigration({ before: live, after: sealed, name: migration.id });
      if (back.steps.length === 0) continue;
      failures.push(historyFailure(history, index, back));
      break;
    }
  } finally {
    await sql.unsafe(`drop schema if exists ${quoteIdent(scratch)} cascade`).catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
  return failures;
}

/**
 * Introspects one scratch schema as if it were `public`.
 *
 * `pg_get_viewdef` and `format_type` qualify every name that is not on the
 * search path, so the scratch schema has to be the search path while it is
 * read. The connection has one session, so the setting holds.
 */
async function introspectScratch(
  sql: postgres.Sql,
  schema: string,
  config: MigrateConfig,
): Promise<Catalog> {
  await sql.unsafe(`set search_path to ${quoteIdent(schema)}`);
  return introspectSchema(catalogQuery(sql), schema, "public", managedRoleOptions(config.roles));
}

function historyFailure(
  history: readonly HistoryEntry[],
  index: number,
  back: MigrationPlan,
): CheckFailure {
  const migration = history[index];
  const id = migration?.id ?? "migration";
  const fork = migration === undefined ? undefined : forkMessage(history, index);
  if (fork !== undefined) return { code: HISTORY_CODE, message: fork, fix: FORK_FIX };
  const steps = back.steps.map((step) => step.sql).join("\n");
  return {
    code: HISTORY_CODE,
    message: `${id}: history differs from the stored catalog\n${steps}`,
    fix: HISTORY_FIX,
  };
}

function forkMessage(history: readonly HistoryEntry[], index: number): string | undefined {
  const current = history[index];
  const previous = history[index - 1];
  if (current === undefined || previous === undefined) return undefined;
  if (samePlan(previous.catalog, current.catalog, current.plan)) return undefined;
  for (let parentIndex = 0; parentIndex < index; parentIndex += 1) {
    const parent = parentIndex === 0 ? catalog([]) : history[parentIndex - 1]?.catalog;
    if (parent === undefined) continue;
    if (!samePlan(parent, current.catalog, current.plan)) continue;
    return `migration ${current.id} was generated from a different parent than ${previous.id}`;
  }
  return undefined;
}

function samePlan(before: Catalog, after: Catalog, file: MigrationPlan): boolean {
  try {
    return sameSql(planMigration({ before, after, name: "parent" }), file);
  } catch (error) {
    if (error instanceof OkmError && error.code === "OKM1530") return false;
    throw error;
  }
}

function sameSql(planned: MigrationPlan, file: MigrationPlan): boolean {
  if (planned.steps.length !== file.steps.length) return false;
  return planned.steps.every((step, index) => step.sql === file.steps[index]?.sql);
}

function retargetSteps(steps: readonly PlanStep[], schema: string): readonly PlanStep[] {
  const from = `${quoteIdent("public")}.`;
  const to = `${quoteIdent(schema)}.`;
  const fromDefaults = `in schema ${quoteIdent("public")} `;
  const toDefaults = `in schema ${quoteIdent(schema)} `;
  return steps.map((step) => ({
    ...step,
    sql: step.sql.replaceAll(from, to).replaceAll(fromDefaults, toDefaults),
    ...(step.backfill === undefined
      ? {}
      : { backfill: { ...step.backfill, table: step.backfill.table.replaceAll(from, to) } }),
  }));
}

function readHistory(directory: string): readonly HistoryEntry[] {
  return loadMigrations(directory).map((migration) => ({
    id: migration.id,
    catalogHash: migration.catalogHash,
    steps: migration.steps,
    plan: parsePlan(readFileSync(join(directory, `${migration.id}.sql`), "utf8")),
    catalog: parseCatalog(readFileSync(join(directory, `${migration.id}.catalog.json`), "utf8")),
  }));
}

function throwFailure(failures: readonly CheckFailure[]): never {
  const first = failures[0];
  if (first === undefined) throw new Error("okm migrate check has no failure to report.");
  const message =
    failures.length === 1
      ? first.message
      : failures.map((failure) => `${failure.code} ${failure.message}`).join("\n");
  throw new OkmError(first.code, message, { fix: { summary: first.fix } });
}

function checkedKind(kind: CatalogObject["kind"]): boolean {
  return kind === "table" || kind === "column" || kind === "constraint" || kind === "type";
}

function columnGaps(before: ColumnObject, after: ColumnObject): readonly string[] {
  const gaps: string[] = [];
  const place = objectLabel(before);
  if (
    canonicalTypeName(before.definition.dataType) !== canonicalTypeName(after.definition.dataType)
  ) {
    gaps.push(
      `${place} changed type from ${before.definition.dataType} to ${after.definition.dataType}`,
    );
  }
  if (before.definition.nullable && !after.definition.nullable && !columnHasDefault(after)) {
    gaps.push(`${place} nullability tightened without a default`);
  }
  return gaps;
}

function columnHasDefault(column: ColumnObject): boolean {
  return (
    column.definition.defaultExpression !== undefined ||
    column.definition.identity !== undefined ||
    column.definition.generated !== undefined
  );
}

function sameType(before: TypeDefinition, after: TypeDefinition): boolean {
  const beforeDomain = isDomain(before);
  const afterDomain = isDomain(after);
  if (beforeDomain !== afterDomain) return false;
  if (beforeDomain && afterDomain) {
    return (
      canonicalTypeName(before.base) === canonicalTypeName(after.base) &&
      before.check === after.check
    );
  }
  if (!beforeDomain && !afterDomain) {
    if (before.labels.length !== after.labels.length) return false;
    return before.labels.every((label, index) => label === after.labels[index]);
  }
  return false;
}

function objectLabel(object: CatalogObject): string {
  if (object.kind === "column" || object.kind === "constraint") {
    return `${object.kind} ${object.identity.parent.name}.${object.identity.name}`;
  }
  if (object.kind === "table" || object.kind === "type") {
    return `${object.kind} ${object.identity.name}`;
  }
  return object.kind;
}
