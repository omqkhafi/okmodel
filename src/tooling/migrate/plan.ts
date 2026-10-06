/**
 * Diffs two catalogs into an ordered, classified plan.
 *
 * Renames are applied to a copy of the previous catalog before the diff, so
 * a declared rename is not a drop and an add. An unexplained drop-and-add is
 * OKM1530. The planner never prompts.
 *
 * Picklist and enum removals are expand `UPDATE`s plus a contract swap
 * (D131). Each data step is a backfill: one idempotent `UPDATE` per batch,
 * with `-- backfill` naming the primary key (D195).
 */

import { OkmError } from "../../contracts/error.js";
import { creationOrder, renameColumn, renameTable } from "../../contracts/catalog/document.js";
import { isDomain, sameEnumLabels } from "../../contracts/catalog/enum.js";
import { fitIdentifier } from "../../contracts/catalog/identifier.js";
import { identityKey, identityLabel, staticNamespace } from "../../contracts/catalog/identity.js";
import { compareText } from "../../contracts/catalog/object.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  FunctionObject,
  MaterializedViewObject,
  TableObject,
  ViewColumn,
  ViewObject,
} from "../../contracts/catalog/types.js";
import type { DeclaredRename } from "../../dialects/pg/declarations.js";
import {
  alterColumnSql,
  createObjectSql,
  createTableSql,
  dropObjectSql,
  functionSql,
  identitySequence,
  ownedByView,
  qualify,
  quoteIdent,
  refreshMaterializedViewSql,
  viewSql,
} from "../../dialects/pg/ddl.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import { privilegeSql } from "../../dialects/pg/role/sql.js";
import {
  formatBackfillHeader,
  keyRangePredicate,
  parseBackfillHeader,
  primaryKeyColumns,
  resolveBatchSize,
  type BackfillSpec,
} from "./backfill.js";
import {
  classOf,
  isStepKind,
  strictestClass,
  type MigrationClass,
  type StepKind,
} from "./classify.js";
import { extensionAlterSteps } from "./extensions.js";
import { omitManagedObjects } from "./managed.js";
import {
  concurrentDropIndexSql,
  notNullSteps,
  stepsForExistingTable,
  type SafeStep,
} from "./safe.js";
import { canonicalTypeName } from "./type-name.js";
import { assertNoChains, type Replacement } from "./values.js";

export type { MigrationClass, StepKind };

/**
 * One statement in a plan.
 *
 * `backfill` is data. A step with {@link PlanStep.backfill} is one idempotent
 * `UPDATE` per batch, outside the migration transaction. `transactional: false`
 * also marks a step that cannot share a transaction (`ALTER TYPE … ADD VALUE`,
 * a concurrent index).
 */
export type PlanStep = {
  readonly sql: string;
  readonly class: MigrationClass;
  /**
   * Planner operation. Absent on a step built by hand.
   *
   * The class comes from this kind. A statement with no kind and no class
   * comment is `raw-sql`.
   */
  readonly kind?: StepKind;
  readonly action: "ddl" | "backfill";
  readonly lock: string;
  /**
   * Tables the statement names.
   *
   * Used to look up `pg_class.reltuples` when a plan is printed against a
   * reachable target. {@link formatPlan} does not write this into a file.
   */
  readonly tables?: readonly string[];
  /**
   * Set when the step was emitted by a safe rewrite (D193).
   *
   * Display only. A migration file does not record it.
   */
  readonly safeRewrite?: true;
  readonly transactional: boolean;
  /**
   * Set when the statement is a batched backfill.
   *
   * The header is `table`, `key`, and `batch`. The statement receives `$1`
   * and `$2`. Absent on a data step written without that header.
   */
  readonly backfill?: BackfillSpec;
  /**
   * Set on an extension upgrade the planner could not check.
   *
   * Apply reads `pg_extension_update_paths` before any statement and refuses
   * a missing path. Offline `okm migrate plan` leaves this unverified.
   */
  readonly path?: "unverified";
  /**
   * Set on `CREATE OR REPLACE` of a function whose signature did not change.
   *
   * The statement is expand. The flag says the body or the settings changed.
   */
  readonly behavior?: "change";
  /**
   * `-- okm-allow` lines directly above the statement.
   *
   * A reason silences that code only. An empty reason, or a code the
   * statement did not trigger, is OKM1510 and silences nothing.
   */
  readonly allows?: readonly StepAllow[];
};

/** One `-- okm-allow CODE: reason` line above a statement. */
export type StepAllow = {
  readonly code: string;
  readonly reason: string;
};

/** A named plan and the class of its strictest step. */
export type MigrationPlan = {
  readonly name: string;
  readonly class: MigrationClass;
  readonly steps: readonly PlanStep[];
};

/** What the planner needs besides the two catalogs. */
export type PlanRequest = {
  readonly before: Catalog;
  readonly after: Catalog;
  readonly renames?: readonly DeclaredRename[];
  readonly replacements?: readonly Replacement[];
  readonly schema?: string;
  /** Concrete schema written into the SQL. Identities stay logical. */
  readonly name?: string;
  /**
   * Rows per backfill batch written into the step header.
   *
   * Omitted uses the built-in default of 1000. A later apply reads `batch=`
   * from the file, which overrides `defineConfig({ backfill })`.
   */
  readonly batchSize?: number;
};

type Indexed = {
  readonly key: string;
  readonly object: CatalogObject;
};

type PicklistChange = {
  readonly before: ConstraintObject;
  readonly after: ConstraintObject;
  readonly column: string;
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly nullable: boolean;
};

type EnumColumn = {
  readonly table: string;
  readonly column: string;
  readonly nullable: boolean;
  /** False when the column is new in this plan and holds no previous rows. */
  readonly existed: boolean;
};

type EnumEdit =
  | { readonly kind: "add"; readonly name: string; readonly statements: readonly string[] }
  | {
      readonly kind: "replace";
      readonly name: string;
      readonly labels: readonly string[];
      readonly removed: readonly string[];
      readonly columns: readonly EnumColumn[];
    };

const ACCESS = "ACCESS EXCLUSIVE";
const SHARE = "SHARE";
const SHARE_UPDATE = "SHARE UPDATE EXCLUSIVE";
const ROW = "ROW EXCLUSIVE";

/**
 * Builds a plan from catalog `before` to catalog `after`.
 *
 * @param request - Catalogs, declared renames, and `--replace` flags
 * @returns Steps in apply order, with one class for the plan
 */
export function planMigration(input: PlanRequest): MigrationPlan {
  const request: PlanRequest = {
    ...input,
    before: omitManagedObjects(input.before),
    after: omitManagedObjects(input.after),
  };
  const schema = request.schema ?? "public";
  const batchSize = resolveBatchSize(request.batchSize);
  const renames = request.renames ?? [];
  const replacements = request.replacements ?? [];
  assertNoChains(replacements);
  const renamed = applyRenames(request.before, renames);
  const beforeList = index(renamed);
  const afterList = index(request.after);
  const beforeBy = new Map(beforeList.map((item) => [item.key, item.object]));
  const afterBy = new Map(afterList.map((item) => [item.key, item.object]));
  assertUnambiguous(beforeBy, afterBy);

  const dropKeys = new Set<string>();
  const createKeys = new Set<string>();
  const replaces: (
    | { readonly kind: "function"; readonly before: FunctionObject; readonly after: FunctionObject }
    | { readonly kind: "view"; readonly before: ViewObject; readonly after: ViewObject }
  )[] = [];
  const alters: { readonly before: ColumnObject; readonly after: ColumnObject }[] = [];
  for (const item of beforeList) {
    if (!afterBy.has(item.key)) {
      if (item.object.kind === "role") continue;
      dropKeys.add(item.key);
    }
  }
  for (const item of afterList) {
    if (!beforeBy.has(item.key)) createKeys.add(item.key);
  }
  for (const item of afterList) {
    const previous = beforeBy.get(item.key);
    if (previous === undefined || sameDefinition(previous, item.object)) continue;
    if (previous.kind === "extension" && item.object.kind === "extension") continue;
    if (previous.kind === "role" && item.object.kind === "role") continue;
    if (
      previous.kind === "function" &&
      item.object.kind === "function" &&
      canonicalTypeName(previous.definition.returns) ===
        canonicalTypeName(item.object.definition.returns)
    ) {
      replaces.push({ kind: "function", before: previous, after: item.object });
      continue;
    }
    if (previous.kind === "view" && item.object.kind === "view") {
      if (columnsAppended(previous.definition.columns, item.object.definition.columns)) {
        replaces.push({ kind: "view", before: previous, after: item.object });
        continue;
      }
    }
    if (previous.kind === "type" && item.object.kind === "type") {
      refuseDomainBaseChange(previous, item.object);
      continue;
    }
    if (
      previous.kind === "column" &&
      item.object.kind === "column" &&
      columnAlterable(previous, item.object)
    ) {
      alters.push({ before: previous, after: item.object });
      continue;
    }
    dropKeys.add(item.key);
    createKeys.add(item.key);
  }

  const keptNames = pairSameShape(beforeBy, afterBy, dropKeys, createKeys);
  const picklists = picklistChanges(beforeBy, afterBy, request.after);
  const enums = enumEdits(beforeBy, afterBy, schema);
  requireReplacements(picklists, enums, replacements);
  recreateDependents(beforeList, afterList, alters, dropKeys, createKeys, picklists);
  recreateRoutineDependents(afterList, dropKeys, createKeys);
  recreateViewDependents(afterList, dropKeys, createKeys);
  refuseRoutineDrops(beforeBy, afterBy, dropKeys);
  omitOwnedSequences(createKeys, afterBy, request.after);
  omitOwnedSequences(dropKeys, beforeBy, renamed);

  const recreated = new Set<string>();
  for (const key of createKeys) {
    if (dropKeys.has(key)) recreated.add(key);
  }
  const privileges = privilegeSql(renamed.objects, request.after.objects, schema, recreated);
  const steps: PlanStep[] = [];
  steps.push(...renameSteps(request.before, renames, schema));
  for (const item of privileges.revoke) steps.push(step(item.sql, item.kind, "ddl", ACCESS));
  steps.push(...keptNames.map((item) => renameShapeStep(item, schema)));
  steps.push(...enumAddSteps(enums));
  steps.push(...domainCheckSteps(beforeBy, afterBy, schema));
  steps.push(
    ...expandBackfills(picklists, enums, replacements, schema, [renamed, request.after], batchSize),
  );

  const droppedTables = new Set(
    [...dropKeys]
      .map((key) => beforeBy.get(key))
      .filter((object): object is TableObject => object?.kind === "table")
      .map((object) => object.identity.name),
  );
  const deferred = new Set(picklists.map((change) => identityKey(change.before.identity)));
  const typeDrops: CatalogObject[] = [];
  const extensionDrops: CatalogObject[] = [];
  const reverse = [...creationOrder(renamed)].reverse();
  const emitDrop = (object: CatalogObject): void => {
    const key = identityKey(object.identity);
    if (!dropKeys.has(key) || deferred.has(key) || covered(object, droppedTables)) return;
    const sql = dropObjectSql(object, schema);
    const kind = dropKind(object);
    if (sql === undefined || kind === undefined) return;
    if (object.kind === "index" && hasTable(renamed, object.identity.parent.name)) {
      steps.push({
        ...step(concurrentDropIndexSql(sql), "drop-index", "ddl", SHARE_UPDATE, false, [
          object.identity.parent.name,
        ]),
        safeRewrite: true,
      });
      return;
    }
    steps.push(step(sql, kind, "ddl", ACCESS));
  };
  // Triggers drop before functions even when the table drop would remove them.
  // View indexes, then views, drop before the tables they read. Never CASCADE.
  for (const object of reverse) if (object.kind === "trigger") emitDrop(object);
  for (const object of reverse) if (object.kind === "function") emitDrop(object);
  for (const object of reverse) if (ownedByView(object)) emitDrop(object);
  for (const object of reverse) {
    if (object.kind === "view" || object.kind === "materializedView") emitDrop(object);
  }
  for (const object of reverse) {
    if (
      object.kind === "trigger" ||
      object.kind === "function" ||
      object.kind === "view" ||
      object.kind === "materializedView" ||
      ownedByView(object)
    ) {
      continue;
    }
    const key = identityKey(object.identity);
    if (!dropKeys.has(key) || deferred.has(key) || covered(object, droppedTables)) continue;
    if (object.kind === "type") {
      typeDrops.push(object);
      continue;
    }
    if (object.kind === "extension") {
      extensionDrops.push(object);
      continue;
    }
    emitDrop(object);
  }
  for (const object of typeDrops) pushDrop(steps, object, schema);
  for (const object of extensionDrops) pushDrop(steps, object, schema);
  steps.push(...extensionAlterSteps(beforeBy, afterBy, dropKeys));

  for (const change of alters) {
    const aligned = alignedColumnType(change.before, change.after);
    const statements = alterColumnSql(aligned, change.after, schema);
    const kinds = columnAlterKinds(aligned, change.after);
    for (let index = 0; index < statements.length; index += 1) {
      const sql = statements[index];
      const kind = kinds[index];
      if (sql === undefined || kind === undefined) continue;
      if (kind === "set-not-null") {
        pushSafe(
          steps,
          notNullSteps(change.after, schema, "set-not-null", [renamed, request.after]),
        );
        continue;
      }
      steps.push(step(sql, kind, "ddl", ACCESS));
    }
    const identitySql = identityChangeSql(change.before, change.after, schema);
    const identity = identityKind(change.before, change.after);
    if (identitySql !== undefined && identity !== undefined) {
      steps.push(step(identitySql, identity, "ddl", ACCESS));
    }
  }

  const createdTables = new Set(
    [...createKeys]
      .map((key) => afterBy.get(key))
      .filter((object): object is TableObject => object?.kind === "table")
      .map((object) => object.identity.name),
  );
  const emitted = new Set<string>();
  for (const item of privileges.prepare) steps.push(step(item.sql, item.kind, "ddl", ACCESS));
  for (const object of creationOrder(request.after)) {
    if (object.kind !== "extension") continue;
    const key = identityKey(object.identity);
    if (!createKeys.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    const sql = createObjectSql(object, schema);
    const kind = createKind(object, false);
    if (sql === undefined || kind === undefined) continue;
    steps.push(step(sql, kind, "ddl", ACCESS));
  }
  for (const object of creationOrder(request.after)) {
    if (object.kind !== "type") continue;
    const key = identityKey(object.identity);
    if (!createKeys.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    const sql = createObjectSql(object, schema);
    const kind = createKind(object, false);
    if (sql === undefined || kind === undefined) continue;
    steps.push(step(sql, kind, "ddl", ACCESS));
  }
  for (const object of creationOrder(request.after)) {
    if (
      object.kind === "type" ||
      object.kind === "extension" ||
      object.kind === "function" ||
      object.kind === "trigger" ||
      object.kind === "view" ||
      object.kind === "materializedView" ||
      ownedByView(object)
    ) {
      continue;
    }
    const key = identityKey(object.identity);
    if (deferred.has(key)) continue;
    const parent = anchoredParent(object);
    const tableIsNew = parent !== undefined && createdTables.has(parent);
    if (tableIsNew && folded(object, request.after)) continue;
    const wanted = createKeys.has(key) || (tableIsNew && !folded(object, request.after));
    if (!wanted || emitted.has(key)) continue;
    emitted.add(key);
    if (object.kind === "table") {
      steps.push(
        step(createTableSql(object, request.after, schema), "create-table", "ddl", ACCESS),
      );
      continue;
    }
    const sql = createObjectSql(object, schema);
    const kind = createKind(object, tableIsNew);
    if (sql === undefined || kind === undefined) continue;
    if (!tableIsNew && parent !== undefined && hasTable(renamed, parent)) {
      const safe = stepsForExistingTable(object, schema, [renamed, request.after], batchSize);
      if (safe !== undefined) {
        pushSafe(steps, safe);
        continue;
      }
    }
    steps.push(step(sql, kind, "ddl", object.kind === "index" ? SHARE : ACCESS));
  }
  for (const change of replaces) {
    if (sameDefinition(change.before, change.after)) continue;
    const key = identityKey(change.after.identity);
    if (dropKeys.has(key) && createKeys.has(key)) continue;
    const sql =
      change.kind === "function"
        ? functionSql(change.after, schema, true)
        : viewSql(change.after, schema, true);
    const kind = change.kind === "function" ? "replace-function" : "replace-view";
    steps.push({
      sql,
      kind,
      class: classOf(kind),
      action: "ddl",
      lock: ACCESS,
      transactional: true,
      behavior: "change",
    });
  }
  for (const kind of ["function", "trigger", "view", "materializedView"] as const) {
    for (const object of creationOrder(request.after)) {
      if (object.kind !== kind) continue;
      const key = identityKey(object.identity);
      if (!createKeys.has(key) || emitted.has(key)) continue;
      emitted.add(key);
      const sql = createObjectSql(object, schema);
      const created = createKind(object, false);
      if (sql === undefined || created === undefined) continue;
      steps.push(step(sql, created, "ddl", ACCESS));
    }
  }
  for (const object of creationOrder(request.after)) {
    if (!ownedByView(object)) continue;
    const key = identityKey(object.identity);
    if (!createKeys.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    const sql = createObjectSql(object, schema);
    const kind = createKind(object, false);
    if (sql === undefined || kind === undefined) continue;
    steps.push(step(sql, kind, "ddl", SHARE));
  }
  for (const object of creationOrder(request.after)) {
    if (object.kind !== "materializedView") continue;
    const key = identityKey(object.identity);
    if (!createKeys.has(key)) continue;
    assertConcurrentRefresh(object, request.after);
    steps.push(
      step(
        refreshMaterializedViewSql(object, schema, false),
        "refresh-matview",
        "backfill",
        ACCESS,
      ),
    );
  }

  for (const item of privileges.grant) steps.push(step(item.sql, item.kind, "ddl", ACCESS));
  steps.push(
    ...contractSwaps(picklists, enums, replacements, schema, [renamed, request.after], batchSize),
  );
  return {
    name: request.name ?? "migration",
    class: overall(steps),
    steps,
  };
}

/**
 * Prints a plan. The header is the strictest class. Each step prints its
 * class and lock. The text is SQL plus those comments, never TypeScript.
 *
 * `okm generate` calls this with no `lockText`, so a file stays free of row
 * estimates. `okm migrate plan` passes `lockText` only after a reachable
 * target has answered.
 *
 * @param plan - Plan from {@link planMigration}
 * @param lockText - Replaces the lock comment when a target supplied estimates
 * @returns The text `okm generate` writes. `okm migrate plan` uses the same text offline
 */
export function formatPlan(plan: MigrationPlan, lockText?: (step: PlanStep) => string): string {
  const lines = [`-- class: ${plan.class}`, `-- name: ${plan.name}`, ""];
  if (plan.steps.length === 0) {
    lines.push("-- no steps");
    lines.push("");
    return lines.join("\n");
  }
  for (const item of plan.steps) {
    lines.push(`-- class: ${item.class}`);
    if (item.kind !== undefined) lines.push(`-- kind: ${item.kind}`);
    lines.push(`-- action: ${item.action}`);
    lines.push(`-- lock: ${lockText === undefined ? item.lock : lockText(item)}`);
    if (item.backfill !== undefined) lines.push(formatBackfillHeader(item.backfill));
    if (!item.transactional) lines.push("-- transactional: false");
    if (item.path !== undefined) lines.push(`-- path: ${item.path}`);
    if (item.behavior === "change") lines.push("-- behavior: change");
    for (const allow of item.allows ?? []) {
      lines.push(`-- okm-allow ${allow.code}: ${allow.reason}`);
    }
    lines.push(`${item.sql};`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Reads a plan written by {@link formatPlan}.
 *
 * @param text - SQL file text
 * @returns The plan. The header class is kept when the file has no steps
 */
export function parsePlan(text: string): MigrationPlan {
  const lines = text.split("\n");
  let name = "migration";
  let planClass: MigrationClass = "expand";
  let index = 0;
  while (index < lines.length && lines[index] !== "") {
    const line = lines[index] ?? "";
    if (line.startsWith("-- name: ")) name = line.slice("-- name: ".length);
    if (line.startsWith("-- class: ")) planClass = readClass(line.slice("-- class: ".length));
    index += 1;
  }
  const steps: PlanStep[] = [];
  while (index < lines.length) {
    if ((lines[index] ?? "").trim() === "") {
      index += 1;
      continue;
    }
    if (lines[index] === "-- no steps") break;
    let stepClass: MigrationClass = "expand";
    let sawClass = false;
    let stepKind: StepKind | undefined;
    let action: PlanStep["action"] = "ddl";
    let lock = "";
    let transactional = true;
    let backfill: BackfillSpec | undefined;
    let path: PlanStep["path"];
    let behavior: PlanStep["behavior"];
    const allows: StepAllow[] = [];
    const sql: string[] = [];
    while (index < lines.length && (lines[index] ?? "") !== "") {
      const line = lines[index] ?? "";
      index += 1;
      if (line.startsWith("-- class: ")) {
        stepClass = readClass(line.slice("-- class: ".length));
        sawClass = true;
      } else if (line.startsWith("-- kind: ")) {
        const kind = line.slice("-- kind: ".length);
        if (isStepKind(kind)) stepKind = kind;
      } else if (line.startsWith("-- action: "))
        action = line.endsWith("backfill") ? "backfill" : "ddl";
      else if (line.startsWith("-- lock: ")) lock = line.slice("-- lock: ".length);
      else if (line.startsWith("-- backfill ")) backfill = parseBackfillHeader(line);
      else if (line === "-- transactional: false") transactional = false;
      else if (line === "-- path: unverified") path = "unverified";
      else if (line === "-- behavior: change") behavior = "change";
      else if (line.startsWith("-- okm-allow")) allows.push(readAllow(line));
      else if (!line.startsWith("--")) sql.push(line);
    }
    const statement = sql.join("\n").replace(/;\s*$/, "");
    if (statement.length > 0) {
      const kind = sawClass ? stepKind : "raw-sql";
      const classification = sawClass ? stepClass : "unclassified";
      steps.push({
        sql: statement,
        class: classification,
        ...(kind !== undefined ? { kind } : {}),
        action,
        lock,
        transactional,
        ...(backfill !== undefined ? { backfill } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(behavior !== undefined ? { behavior } : {}),
        ...(allows.length > 0 ? { allows } : {}),
      });
    }
  }
  return { name, class: steps.length === 0 ? planClass : overall(steps), steps };
}

const ALLOW = /^-- okm-allow\s+(OKM\d+)\s*(?::\s*(.*))?$/;

function readAllow(line: string): StepAllow {
  const match = ALLOW.exec(line);
  if (match === null) return { code: "", reason: "" };
  return { code: match[1] ?? "", reason: (match[2] ?? "").trim() };
}

function readClass(value: string): MigrationClass {
  if (value === "contract" || value === "unclassified") return value;
  return "expand";
}

/**
 * Renames whose previous name is absent from the last snapshot.
 *
 * No snapshot means nothing is stale: there is no history to disagree with.
 *
 * @param previous - Last migration catalog, or `undefined` when there is none
 * @param renames - Declarations on the current schema
 * @returns Messages, empty when every rename still matches
 */
export function staleRenames(
  previous: Catalog | undefined,
  renames: readonly DeclaredRename[],
): readonly string[] {
  if (previous === undefined) return [];
  const messages: string[] = [];
  for (const rename of renames) {
    if (rename.kind === "table") {
      if (!hasTable(previous, rename.from)) {
        messages.push(`Table renamedFrom ${rename.from} is not in the previous snapshot.`);
      }
      continue;
    }
    const tableRename = renames.find((item) => item.kind === "table" && item.to === rename.table);
    const previousTable = tableRename?.kind === "table" ? tableRename.from : rename.table;
    if (!hasColumn(previous, previousTable, rename.from)) {
      messages.push(
        `Column ${rename.table}.${rename.from} renamedFrom is not in the previous snapshot.`,
      );
    }
  }
  return messages;
}

function applyRenames(source: Catalog, renames: readonly DeclaredRename[]): Catalog {
  let current = source;
  const namespace = staticNamespace("public");
  for (const rename of renames) {
    if (rename.kind !== "table") continue;
    if (!hasTable(current, rename.from)) continue;
    current = renameTable(current, { namespace, from: rename.from, to: rename.to });
  }
  for (const rename of renames) {
    if (rename.kind !== "column") continue;
    const parent = { namespace, name: rename.table };
    if (!hasColumn(current, rename.table, rename.from)) continue;
    current = renameColumn(current, { parent, from: rename.from, to: rename.to });
  }
  return current;
}

function renameSteps(
  source: Catalog,
  renames: readonly DeclaredRename[],
  schema: string,
): PlanStep[] {
  const steps: PlanStep[] = [];
  const tables = new Map<string, string>();
  for (const rename of renames) {
    if (rename.kind !== "table" || !hasTable(source, rename.from)) continue;
    tables.set(rename.to, rename.from);
    steps.push(
      step(
        `alter table ${qualify(schema, rename.from)} rename to ${quoteIdent(rename.to)}`,
        "rename-table",
        "ddl",
        ACCESS,
      ),
    );
    steps.push(...sequenceRenames(source, rename, schema));
  }
  for (const rename of renames) {
    if (rename.kind !== "column") continue;
    const previousTable = tables.get(rename.table) ?? rename.table;
    if (!hasColumn(source, previousTable, rename.from)) continue;
    steps.push(
      step(
        `alter table ${qualify(schema, rename.table)} rename column ${quoteIdent(rename.from)} to ${quoteIdent(rename.to)}`,
        "rename-column",
        "ddl",
        ACCESS,
      ),
    );
  }
  return steps;
}

function sequenceRenames(
  source: Catalog,
  rename: { readonly from: string; readonly to: string },
  schema: string,
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const object of source.objects) {
    if (object.kind !== "column" || object.definition.identity === undefined) continue;
    if (object.identity.parent.name !== rename.from) continue;
    const fromName = fitIdentifier(`${rename.from}_${object.identity.name}_seq`);
    const toName = fitIdentifier(`${rename.to}_${object.identity.name}_seq`);
    if (fromName === toName) continue;
    const owned = source.objects.some(
      (item) => item.kind === "sequence" && item.identity.name === fromName,
    );
    if (!owned) continue;
    steps.push(
      step(
        `alter sequence ${qualify(schema, fromName)} rename to ${quoteIdent(toName)}`,
        "rename-sequence",
        "ddl",
        ACCESS,
      ),
    );
  }
  return steps;
}

function pairSameShape(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  dropKeys: Set<string>,
  createKeys: Set<string>,
): { readonly from: CatalogObject; readonly to: CatalogObject }[] {
  const dropped = [...dropKeys]
    .map((key) => beforeBy.get(key))
    .filter((object): object is CatalogObject => object !== undefined);
  const created = [...createKeys]
    .map((key) => afterBy.get(key))
    .filter((object): object is CatalogObject => object !== undefined);
  const pairs: { from: CatalogObject; to: CatalogObject }[] = [];
  const used = new Set<string>();
  for (const left of dropped) {
    if (left.kind !== "index" && left.kind !== "constraint") continue;
    const leftKey = identityKey(left.identity);
    const hits = created.filter((right) => {
      const key = identityKey(right.identity);
      return key !== leftKey && !used.has(key) && sameShape(left, right);
    });
    const right = hits.length === 1 ? hits[0] : undefined;
    if (right === undefined) continue;
    const rivals = dropped.filter((item) => sameShape(item, right));
    if (rivals.length !== 1) continue;
    const rightKey = identityKey(right.identity);
    used.add(rightKey);
    dropKeys.delete(identityKey(left.identity));
    createKeys.delete(rightKey);
    if (anchoredName(left) !== anchoredName(right)) pairs.push({ from: left, to: right });
  }
  return pairs;
}

function sameShape(left: CatalogObject, right: CatalogObject): boolean {
  if (left.kind !== right.kind) return false;
  if (
    (left.kind !== "index" && left.kind !== "constraint") ||
    (right.kind !== "index" && right.kind !== "constraint")
  ) {
    return false;
  }
  if (left.identity.parent.name !== right.identity.parent.name) return false;
  return stable(withoutNameKey(left.definition)) === stable(withoutNameKey(right.definition));
}

function withoutNameKey(value: object): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete copy.nameKey;
  return copy;
}

function renameShapeStep(
  pair: { readonly from: CatalogObject; readonly to: CatalogObject },
  schema: string,
): PlanStep {
  if (pair.from.kind === "index" && pair.to.kind === "index") {
    return step(
      `alter index ${qualify(schema, pair.from.identity.name)} rename to ${quoteIdent(pair.to.identity.name)}`,
      "rename-index",
      "ddl",
      ACCESS,
    );
  }
  if (pair.from.kind !== "constraint" || pair.to.kind !== "constraint") {
    throw new OkmError("invalid", "A same-shape rename is an index or a constraint.", {
      fix: { summary: "The planner only renames an index or a constraint in place." },
    });
  }
  return step(
    `alter table ${qualify(schema, pair.from.identity.parent.name)} rename constraint ${quoteIdent(pair.from.identity.name)} to ${quoteIdent(pair.to.identity.name)}`,
    "rename-constraint",
    "ddl",
    ACCESS,
  );
}

function assertUnambiguous(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
): void {
  const dropped = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  for (const [key, object] of beforeBy) {
    if (afterBy.has(key)) continue;
    const group = groupOf(object);
    if (group === undefined) continue;
    const list = dropped.get(group) ?? [];
    const name = anchoredName(object);
    if (name === undefined) continue;
    list.push(name);
    dropped.set(group, list);
  }
  for (const [key, object] of afterBy) {
    if (beforeBy.has(key)) continue;
    const group = groupOf(object);
    if (group === undefined) continue;
    const list = added.get(group) ?? [];
    const name = anchoredName(object);
    if (name === undefined) continue;
    list.push(name);
    added.set(group, list);
  }
  for (const [group, names] of added) {
    const gone = dropped.get(group);
    if (gone === undefined || gone.length === 0 || names.length === 0) continue;
    const from = gone[0] ?? "";
    const to = names[0] ?? "";
    const line = group.startsWith("table:")
      ? `Add renamedFrom: "${from}" on ${to}.`
      : `Add .renamedFrom("${from}") on ${to}.`;
    throw new OkmError("OKM1530", `Drop ${from} and add ${to} could be a rename. ${line}`, {
      fix: { summary: line },
    });
  }
}

function anchoredName(object: CatalogObject): string | undefined {
  switch (object.kind) {
    case "grant":
    case "defaultPrivilege":
      return undefined;
    default:
      return object.identity.name;
  }
}

function groupOf(object: CatalogObject): string | undefined {
  if (object.kind === "table") return "table:public";
  if (object.kind === "column") return `column:${object.identity.parent.name}`;
  return undefined;
}

function recreateDependents(
  beforeList: readonly Indexed[],
  afterList: readonly Indexed[],
  alters: readonly { readonly before: ColumnObject; readonly after: ColumnObject }[],
  dropKeys: Set<string>,
  createKeys: Set<string>,
  picklists: readonly PicklistChange[],
): void {
  const changed = new Set(
    alters
      .filter(
        (item) =>
          canonicalTypeName(item.before.definition.dataType) !==
          canonicalTypeName(item.after.definition.dataType),
      )
      .map((item) => identityKey(item.after.identity)),
  );
  if (changed.size === 0) return;
  const deferred = new Set(picklists.map((change) => identityKey(change.before.identity)));
  const afterBy = new Map(afterList.map((item) => [item.key, item.object]));
  for (const item of beforeList) {
    const key = identityKey(item.object.identity);
    if (deferred.has(key) || !afterBy.has(key)) continue;
    if (!dependsOnChanged(item.object, changed)) continue;
    dropKeys.add(key);
    createKeys.add(key);
  }
}

function recreateRoutineDependents(
  afterList: readonly Indexed[],
  dropKeys: Set<string>,
  createKeys: Set<string>,
): void {
  const recreated = new Set<string>();
  for (const item of afterList) {
    if (!dropKeys.has(item.key) || !createKeys.has(item.key)) continue;
    if (
      item.object.kind === "function" ||
      item.object.kind === "column" ||
      item.object.kind === "table"
    ) {
      recreated.add(item.key);
    }
  }
  if (recreated.size === 0) return;
  for (const item of afterList) {
    if (item.object.kind !== "trigger" && item.object.kind !== "function") continue;
    const hit = item.object.dependencies.some((edge) => recreated.has(identityKey(edge.target)));
    if (!hit) continue;
    dropKeys.add(item.key);
    createKeys.add(item.key);
  }
}

function refuseRoutineDrops(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  dropKeys: ReadonlySet<string>,
): void {
  for (const after of afterBy.values()) {
    const key = identityKey(after.identity);
    if (dropKeys.has(key)) continue;
    if (
      after.kind !== "trigger" &&
      after.kind !== "function" &&
      after.kind !== "view" &&
      after.kind !== "materializedView"
    ) {
      continue;
    }
    for (const edge of after.dependencies) {
      const targetKey = identityKey(edge.target);
      if (!dropKeys.has(targetKey)) continue;
      const target = beforeBy.get(targetKey);
      if (target === undefined) continue;
      if (
        target.kind !== "function" &&
        target.kind !== "table" &&
        target.kind !== "column" &&
        target.kind !== "view" &&
        target.kind !== "materializedView"
      ) {
        continue;
      }
      throw new OkmError(
        "OKM1821",
        `${identityLabel(after.identity)} depends on ${identityLabel(target.identity)}, which this plan drops. CASCADE is never used.`,
        { fix: { summary: "Review the dependents the plan lists and recreate them explicitly." } },
      );
    }
  }
}

function dependsOnChanged(object: CatalogObject, columns: ReadonlySet<string>): boolean {
  if (
    object.kind !== "index" &&
    object.kind !== "constraint" &&
    object.kind !== "view" &&
    object.kind !== "materializedView"
  ) {
    return false;
  }
  return object.dependencies.some((edge) => columns.has(identityKey(edge.target)));
}

function recreateViewDependents(
  afterList: readonly Indexed[],
  dropKeys: Set<string>,
  createKeys: Set<string>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of afterList) {
      if (dropKeys.has(item.key) && createKeys.has(item.key)) continue;
      const kind = item.object.kind;
      if (kind !== "view" && kind !== "materializedView" && kind !== "index") continue;
      const hit = item.object.dependencies.some((edge) => {
        const key = identityKey(edge.target);
        return dropKeys.has(key) && createKeys.has(key);
      });
      if (!hit) continue;
      dropKeys.add(item.key);
      createKeys.add(item.key);
      changed = true;
    }
  }
}

function columnsAppended(before: readonly ViewColumn[], after: readonly ViewColumn[]): boolean {
  if (after.length < before.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (left === undefined || right === undefined) return false;
    if (
      left.name !== right.name ||
      canonicalTypeName(left.dataType) !== canonicalTypeName(right.dataType)
    ) {
      return false;
    }
  }
  return true;
}

function assertConcurrentRefresh(object: MaterializedViewObject, source: Catalog): void {
  if (object.definition.refresh !== "concurrently") return;
  const unique = source.objects.some(
    (item) =>
      item.kind === "index" &&
      item.definition.unique &&
      item.identity.parent.name === object.identity.name,
  );
  if (unique) return;
  throw new OkmError(
    "OKM1822",
    `Materialized view ${object.identity.name} refreshes concurrently and has no unique index.`,
    { fix: { summary: "Add a unique index, or refresh without CONCURRENTLY." } },
  );
}

function enumAddSteps(enums: readonly EnumEdit[]): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const change of enums) {
    if (change.kind !== "add") continue;
    for (const sql of change.statements) {
      steps.push(step(sql, "add-enum-value", "ddl", ACCESS, false));
    }
  }
  return steps;
}

function expandBackfills(
  picklists: readonly PicklistChange[],
  enums: readonly EnumEdit[],
  replacements: readonly Replacement[],
  schema: string,
  catalogs: readonly Catalog[],
  batchSize: number,
): PlanStep[] {
  return dataSteps(picklists, enums, replacements, schema, catalogs, batchSize, "expand");
}

function contractSwaps(
  picklists: readonly PicklistChange[],
  enums: readonly EnumEdit[],
  replacements: readonly Replacement[],
  schema: string,
  catalogs: readonly Catalog[],
  batchSize: number,
): PlanStep[] {
  const steps: PlanStep[] = [];
  steps.push(...dataSteps(picklists, enums, replacements, schema, catalogs, batchSize, "contract"));
  for (const change of picklists) {
    const table = qualify(schema, change.after.identity.parent.name);
    const name = quoteIdent(change.after.identity.name);
    const kind = change.removed.length > 0 ? "narrow-check" : "widen-check";
    steps.push(step(`alter table ${table} drop constraint ${name}`, kind, "ddl", ACCESS));
    const expression = change.after.definition.expression ?? "true";
    steps.push(
      step(
        `alter table ${table} add constraint ${name} check (${expression}) not valid`,
        kind,
        "ddl",
        ACCESS,
      ),
    );
    steps.push(step(`alter table ${table} validate constraint ${name}`, kind, "ddl", SHARE_UPDATE));
  }
  for (const change of enums) {
    if (change.kind !== "replace") continue;
    const type = qualify(schema, change.name);
    const old = quoteIdent(`${change.name}_old`);
    const labels = change.labels.map((label) => quoteLiteral(label)).join(", ");
    steps.push(step(`alter type ${type} rename to ${old}`, "rename-enum", "ddl", ACCESS));
    steps.push(step(`create type ${type} as enum (${labels})`, "recreate-enum", "ddl", ACCESS));
    for (const column of change.columns) {
      const table = qualify(schema, column.table);
      const name = quoteIdent(column.column);
      steps.push(
        step(
          `alter table ${table} alter column ${name} type ${type} using ${name}::text::${type}`,
          "set-enum-column",
          "ddl",
          ACCESS,
        ),
      );
    }
    steps.push(
      step(`drop type ${qualify(schema, `${change.name}_old`)}`, "drop-enum", "ddl", ACCESS),
    );
  }
  return steps;
}

function dataSteps(
  picklists: readonly PicklistChange[],
  enums: readonly EnumEdit[],
  replacements: readonly Replacement[],
  schema: string,
  catalogs: readonly Catalog[],
  batchSize: number,
  phase: "expand" | "contract",
): PlanStep[] {
  const steps: PlanStep[] = [];
  const kind = phase === "expand" ? "backfill-expand" : "backfill-contract";
  for (const change of picklists) {
    if (change.removed.length === 0) continue;
    const table = change.after.identity.parent.name;
    for (const value of change.removed) {
      const replacement = findReplacement(replacements, table, change.column, value);
      if (replacement === undefined) continue;
      steps.push(
        backfillStep(
          updateSql(schema, table, change.column, value, replacement.to, catalogs, batchSize),
          kind,
        ),
      );
    }
  }
  for (const change of enums) {
    if (change.kind !== "replace" || change.removed.length === 0) continue;
    for (const column of change.columns) {
      if (!column.existed) continue;
      for (const value of change.removed) {
        const replacement = findReplacement(replacements, column.table, column.column, value);
        if (replacement === undefined) continue;
        steps.push(
          backfillStep(
            updateSql(
              schema,
              column.table,
              column.column,
              value,
              replacement.to,
              catalogs,
              batchSize,
              true,
            ),
            kind,
          ),
        );
      }
    }
  }
  return steps;
}

function requireReplacements(
  picklists: readonly PicklistChange[],
  enums: readonly EnumEdit[],
  replacements: readonly Replacement[],
): void {
  const missing: string[] = [];
  for (const change of picklists) {
    for (const value of change.removed) {
      const table = change.after.identity.parent.name;
      const found = findReplacement(replacements, table, change.column, value);
      if (found === undefined) {
        missing.push(`--replace ${table}.${change.column}.${value}=<new>`);
        continue;
      }
      assertReplacement(
        found,
        change.after.definition.expression,
        change.nullable,
        parseValues(change.after.definition.expression),
      );
    }
  }
  for (const change of enums) {
    if (change.kind !== "replace") continue;
    for (const column of change.columns) {
      if (!column.existed) continue;
      for (const value of change.removed) {
        const found = findReplacement(replacements, column.table, column.column, value);
        if (found === undefined) {
          missing.push(`--replace ${column.table}.${column.column}.${value}=<new>`);
          continue;
        }
        assertReplacement(found, undefined, column.nullable, change.labels);
      }
    }
  }
  if (missing.length > 0) {
    throw new OkmError("OKM1541", `Removed values need a replacement: ${missing.join(", ")}.`, {
      fix: { summary: missing.join(" ") },
    });
  }
}

function assertReplacement(
  replacement: Replacement,
  expression: string | undefined,
  nullable: boolean,
  allowed: readonly string[] | undefined,
): void {
  if (replacement.to === null) {
    if (!nullable) {
      throw new OkmError(
        "OKM1541",
        `--replace ${replacement.table}.${replacement.column}.${replacement.from}=null needs a nullable column.`,
        { fix: { summary: "Pass a value that is in the new list, or make the column nullable." } },
      );
    }
    return;
  }
  const list = allowed ?? (expression === undefined ? [] : (parseValues(expression) ?? []));
  if (!list.includes(replacement.to)) {
    const flag = `--replace ${replacement.table}.${replacement.column}.${replacement.from}=${replacement.to}`;
    throw new OkmError("OKM1541", `${flag} is not in the new list.`, {
      fix: { summary: "The replacement must be in the new list. No chains." },
    });
  }
}

function parseValues(expression: string | undefined): readonly string[] | undefined {
  if (expression === undefined) return undefined;
  return parseInList(expression)?.values;
}

function findReplacement(
  replacements: readonly Replacement[],
  table: string,
  column: string,
  from: string,
): Replacement | undefined {
  return replacements.find(
    (item) => item.table === table && item.column === column && item.from === from,
  );
}

function picklistChanges(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  after: Catalog,
): PicklistChange[] {
  const changes: PicklistChange[] = [];
  for (const [key, object] of beforeBy) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "check") continue;
    const next = afterBy.get(key);
    if (next === undefined || next.kind !== "constraint") continue;
    const left = parseInList(object.definition.expression ?? "");
    const right = parseInList(next.definition.expression ?? "");
    if (left === undefined || right === undefined || left.column !== right.column) continue;
    const removed = left.values.filter((value) => !right.values.includes(value));
    const added = right.values.filter((value) => !left.values.includes(value));
    if (removed.length === 0 && added.length === 0) continue;
    changes.push({
      before: object,
      after: next,
      column: right.column,
      removed,
      added,
      nullable: columnNullable(after, next.identity.parent.name, right.column),
    });
  }
  return changes;
}

function refuseDomainBaseChange(before: CatalogObject, after: CatalogObject): void {
  if (before.kind !== "type" || after.kind !== "type") return;
  if (!isDomain(before.definition) || !isDomain(after.definition)) return;
  if (before.definition.base === after.definition.base) return;
  throw new OkmError(
    "OKM1020",
    `Domain ${after.identity.name} cannot change its base type from ${before.definition.base} to ${after.definition.base}. The base type of a domain stays as it was created.`,
    {
      fix: {
        summary: "Keep the base type. Add a new domain when the column needs another type.",
      },
    },
  );
}

function domainCheckSteps(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  schema: string,
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const [key, next] of afterBy) {
    if (next.kind !== "type" || !isDomain(next.definition)) continue;
    const previous = beforeBy.get(key);
    if (previous === undefined || previous.kind !== "type" || !isDomain(previous.definition)) {
      continue;
    }
    if (previous.definition.check === next.definition.check) continue;
    const name = next.identity.name;
    const type = qualify(schema, name);
    const current = quoteIdent(fitIdentifier(`${name}_check`));
    const upcoming = quoteIdent(fitIdentifier(`${name}_check_next`));
    const expression = next.definition.check;
    steps.push(
      step(
        `alter domain ${type} add constraint ${upcoming} check (${expression}) not valid`,
        "add-domain-check",
        "ddl",
        ACCESS,
      ),
    );
    steps.push(
      step(
        `alter domain ${type} validate constraint ${upcoming}`,
        "validate-domain-check",
        "ddl",
        ACCESS,
      ),
    );
    steps.push(
      step(`alter domain ${type} drop constraint ${current}`, "drop-domain-check", "ddl", ACCESS),
    );
    steps.push(
      step(
        `alter domain ${type} rename constraint ${upcoming} to ${current}`,
        "rename-domain-check",
        "ddl",
        ACCESS,
      ),
    );
  }
  return steps;
}

function enumEdits(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  schema: string,
): EnumEdit[] {
  const edits: EnumEdit[] = [];
  for (const [key, next] of afterBy) {
    if (next.kind !== "type" || isDomain(next.definition)) continue;
    const previous = beforeBy.get(key);
    if (previous === undefined || previous.kind !== "type" || isDomain(previous.definition)) {
      continue;
    }
    const beforeLabels = previous.definition.labels;
    const afterLabels = next.definition.labels;
    if (sameEnumLabels(beforeLabels, afterLabels)) continue;
    const removed = beforeLabels.filter((label) => !afterLabels.includes(label));
    const columns = enumColumns(previous.identity.name, beforeBy, afterBy);
    if (removed.length === 0 && labelSubsequence(beforeLabels, afterLabels)) {
      edits.push({
        kind: "add",
        name: next.identity.name,
        statements: addValueStatements(schema, next.identity.name, beforeLabels, afterLabels),
      });
      continue;
    }
    edits.push({
      kind: "replace",
      name: next.identity.name,
      labels: afterLabels,
      removed,
      columns,
    });
  }
  return edits;
}

function enumColumns(
  typeName: string,
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
): EnumColumn[] {
  const columns: EnumColumn[] = [];
  for (const object of afterBy.values()) {
    if (object.kind !== "column") continue;
    if (!usesType(object, typeName)) continue;
    columns.push({
      table: object.identity.parent.name,
      column: object.identity.name,
      nullable: object.definition.nullable,
      existed: beforeBy.has(identityKey(object.identity)),
    });
  }
  columns.sort((left, right) => {
    const table = compareText(left.table, right.table);
    return table === 0 ? compareText(left.column, right.column) : table;
  });
  return columns;
}

function usesType(object: CatalogObject, typeName: string): boolean {
  return object.dependencies.some(
    (edge) => edge.target.kind === "type" && edge.target.name === typeName,
  );
}

function labelSubsequence(before: readonly string[], after: readonly string[]): boolean {
  let index = 0;
  for (const label of after) {
    if (before[index] === label) index += 1;
  }
  return index === before.length;
}

function addValueStatements(
  schema: string,
  name: string,
  before: readonly string[],
  after: readonly string[],
): string[] {
  const present = new Set(before);
  const statements: string[] = [];
  const type = qualify(schema, name);
  for (let index = 0; index < after.length; index += 1) {
    const label = after[index];
    if (label === undefined || present.has(label)) continue;
    let beforeNeighbor: string | undefined;
    for (let cursor = index + 1; cursor < after.length; cursor += 1) {
      const next = after[cursor];
      if (next !== undefined && present.has(next)) {
        beforeNeighbor = next;
        break;
      }
    }
    let sql = `alter type ${type} add value ${quoteLiteral(label)}`;
    if (beforeNeighbor !== undefined) {
      sql += ` before ${quoteLiteral(beforeNeighbor)}`;
    } else {
      let afterNeighbor: string | undefined;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const previous = after[cursor];
        if (previous !== undefined && present.has(previous)) {
          afterNeighbor = previous;
          break;
        }
      }
      if (afterNeighbor !== undefined) sql += ` after ${quoteLiteral(afterNeighbor)}`;
    }
    statements.push(sql);
    present.add(label);
  }
  return statements;
}

function parseInList(expression: string): { column: string; values: string[] } | undefined {
  const match = /^\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\((.*)\)\s*\)$/i.exec(expression.trim());
  const column = match?.[1];
  const body = match?.[2];
  if (column === undefined || body === undefined) return undefined;
  const values: string[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? "";
    if (char === " " || char === ",") {
      index += 1;
      continue;
    }
    if (char !== "'") return undefined;
    let end = index + 1;
    let value = "";
    while (end < body.length) {
      const next = body[end] ?? "";
      if (next === "'" && body[end + 1] === "'") {
        value += "'";
        end += 2;
        continue;
      }
      if (next === "'") {
        end += 1;
        break;
      }
      value += next;
      end += 1;
    }
    values.push(value);
    index = end;
  }
  return { column, values };
}

function columnNullable(source: Catalog, table: string, column: string): boolean {
  for (const object of source.objects) {
    if (
      object.kind === "column" &&
      object.identity.parent.name === table &&
      object.identity.name === column
    ) {
      return object.definition.nullable;
    }
  }
  return false;
}

function columnAlterable(before: ColumnObject, after: ColumnObject): boolean {
  return stable(before.definition.generated) === stable(after.definition.generated);
}

/**
 * In-place identity add, drop, or always/by-default change.
 *
 * The sequence is created or dropped by this statement. {@link omitOwnedSequences}
 * keeps the planner from emitting a second sequence statement.
 *
 * @param before - Column already applied
 * @param after - Column the plan must reach
 * @param schema - Concrete schema name
 * @returns The statement, or `undefined` when identity is unchanged
 */
function identityChangeSql(
  before: ColumnObject,
  after: ColumnObject,
  schema: string,
): string | undefined {
  if (stable(before.definition.identity) === stable(after.definition.identity)) return undefined;
  const table = qualify(schema, after.identity.parent.name);
  const name = quoteIdent(after.identity.name);
  const next = after.definition.identity;
  const previous = before.definition.identity;
  if (next === undefined) return `alter table ${table} alter column ${name} drop identity`;
  if (previous === undefined) {
    const generated = next.always ? "always" : "by default";
    return `alter table ${table} alter column ${name} add generated ${generated} as identity`;
  }
  return `alter table ${table} alter column ${name} set generated ${next.always ? "always" : "by default"}`;
}

function omitOwnedSequences(
  keys: Set<string>,
  by: ReadonlyMap<string, CatalogObject>,
  source: Catalog,
): void {
  for (const key of keys) {
    const object = by.get(key);
    if (object?.kind === "sequence" && folded(object, source)) keys.delete(key);
  }
}

function sameDefinition(left: CatalogObject, right: CatalogObject): boolean {
  if (left.kind === "materializedView" && right.kind === "materializedView") {
    return (
      stable(canonicalColumns(left.definition.columns)) ===
        stable(canonicalColumns(right.definition.columns)) &&
      left.definition.query === right.definition.query
    );
  }
  return stable(forComparison(left)) === stable(forComparison(right));
}

/**
 * Definition compared by type spelling.
 *
 * `dataType`, function returns and arguments, trigger argument types, view
 * columns, and a domain base go through {@link canonicalTypeName}. Everything
 * else is compared as stored. A materialized view's `refresh` is not here:
 * Postgres does not store it, so {@link sameDefinition} ignores it.
 *
 * @param object - One side of the diff
 * @returns The definition, with type names in the long spelling
 */
function forComparison(object: CatalogObject): unknown {
  switch (object.kind) {
    case "column":
    case "sequence":
      return { ...object.definition, dataType: canonicalTypeName(object.definition.dataType) };
    case "view":
      return { ...object.definition, columns: canonicalColumns(object.definition.columns) };
    case "function":
      return {
        ...object.definition,
        returns: canonicalTypeName(object.definition.returns),
        arguments: object.definition.arguments.map((argument) => ({
          ...argument,
          type: canonicalTypeName(argument.type),
        })),
      };
    case "trigger":
      return {
        ...object.definition,
        calls: {
          ...object.definition.calls,
          argTypes: object.definition.calls.argTypes.map((typeName) => canonicalTypeName(typeName)),
        },
      };
    case "type":
      if (!isDomain(object.definition)) return object.definition;
      return { ...object.definition, base: canonicalTypeName(object.definition.base) };
    default:
      return object.definition;
  }
}

function canonicalColumns(columns: readonly ViewColumn[]): ViewColumn[] {
  return columns.map((column) => ({ ...column, dataType: canonicalTypeName(column.dataType) }));
}

/**
 * Makes an alias spelling look like the target spelling before `ALTER`.
 *
 * A nullability change must not also emit `SET DATA TYPE` when the two
 * spellings are one type. A real type change keeps both spellings, so the
 * statement uses the schema's type name.
 *
 * @param before - Column already applied
 * @param after - Column the plan must reach
 * @returns `before`, or a copy whose `dataType` matches `after`
 */
function alignedColumnType(before: ColumnObject, after: ColumnObject): ColumnObject {
  if (
    canonicalTypeName(before.definition.dataType) !== canonicalTypeName(after.definition.dataType)
  ) {
    return before;
  }
  if (before.definition.dataType === after.definition.dataType) return before;
  return { ...before, definition: { ...before.definition, dataType: after.definition.dataType } };
}

function covered(object: CatalogObject, tables: ReadonlySet<string>): boolean {
  if (object.kind === "column" || object.kind === "index" || object.kind === "constraint") {
    return tables.has(object.identity.parent.name);
  }
  if (object.kind === "sequence") {
    return object.dependencies.some(
      (edge) => edge.target.kind === "table" && tables.has(edge.target.name),
    );
  }
  return false;
}

function folded(object: CatalogObject, source: Catalog): boolean {
  if (object.kind === "column") return true;
  if (object.kind === "constraint" && object.definition.constraintKind === "primaryKey")
    return true;
  if (object.kind !== "sequence") return false;
  if (identitySequence(object, source)) return true;
  // Introspection stores the identity flag and the sequence, but not the
  // dependency: Postgres records it as an internal dependency. The default
  // name is still table_column_seq, which is what the column creates.
  const name = object.identity.name;
  return source.objects.some((column) => {
    if (column.kind !== "column" || column.definition.identity === undefined) return false;
    return name === `${column.identity.parent.name}_${column.identity.name}_seq`;
  });
}

function anchoredParent(object: CatalogObject): string | undefined {
  if (object.kind === "column" || object.kind === "index" || object.kind === "constraint") {
    return object.identity.parent.name;
  }
  return undefined;
}

function overall(steps: readonly PlanStep[]): MigrationClass {
  return strictestClass(steps.map((item) => item.class));
}

function updateSql(
  schema: string,
  table: string,
  column: string,
  from: string,
  to: string | null,
  catalogs: readonly Catalog[],
  batchSize: number,
  cast = false,
): { readonly sql: string; readonly backfill: BackfillSpec } {
  const key = primaryKeyColumns(catalogs, table);
  const qualified = qualify(schema, table);
  const value = to === null ? "null" : quoteLiteral(to);
  const compare = cast ? `${quoteIdent(column)}::text` : quoteIdent(column);
  const where = `${compare} = ${quoteLiteral(from)}`;
  const backfill: BackfillSpec = {
    table: qualified,
    key: key.map((item) => item.quoted),
    batch: batchSize,
  };
  return {
    sql: `update ${qualified} set ${quoteIdent(column)} = ${value} where ${where} and ${keyRangePredicate(key)}`,
    backfill,
  };
}

function backfillStep(
  planned: { readonly sql: string; readonly backfill: BackfillSpec },
  kind: StepKind,
): PlanStep {
  return {
    ...step(planned.sql, kind, "backfill", ROW, false),
    backfill: planned.backfill,
  };
}

function hasTable(source: Catalog, name: string): boolean {
  return source.objects.some((object) => object.kind === "table" && object.identity.name === name);
}

function hasColumn(source: Catalog, table: string, name: string): boolean {
  return source.objects.some(
    (object) =>
      object.kind === "column" &&
      object.identity.parent.name === table &&
      object.identity.name === name,
  );
}

function index(source: Catalog): Indexed[] {
  return source.objects.map((object) => ({ key: identityKey(object.identity), object }));
}

function step(
  sql: string,
  kind: StepKind,
  action: PlanStep["action"],
  lock: string,
  transactional = true,
  extraTables?: readonly string[],
): PlanStep {
  const tables = touchedTables(sql, lock, extraTables);
  return {
    sql,
    kind,
    class: classOf(kind),
    action,
    lock,
    transactional,
    ...(tables.length > 0 ? { tables } : {}),
  };
}

function pushSafe(steps: PlanStep[], safe: readonly SafeStep[]): void {
  for (const item of safe) {
    steps.push({
      ...step(item.sql, item.kind, item.action, item.lock, item.transactional),
      safeRewrite: true,
      ...(item.backfill !== undefined ? { backfill: item.backfill } : {}),
    });
  }
}

const TABLE_PREFIX =
  /\b(?:create|alter|drop)\s+table(?:\s+if\s+exists)?\s+|\bupdate\s+|\binsert\s+into\s+|\breferences\s+|\bon\s+table\s+|\bon\s+/gi;

/**
 * Tables named by a statement or by a lock comment.
 *
 * A schema-qualified identifier after a table keyword counts. A following dot
 * is a column (`"public"."tasks"."id"`) and is skipped. `rename to` is not a
 * keyword here, so the new name of a rename is not treated as a second table.
 *
 * @param sql - Statement text
 * @param lock - Lock comment, which may name a second relation
 * @param extra - Tables the SQL does not name, such as the parent of a dropped index
 * @returns Names in first-seen order, without duplicates
 */
function touchedTables(
  sql: string,
  lock: string,
  extra: readonly string[] | undefined,
): readonly string[] {
  const names: string[] = [];
  const text = `${sql}\n${lock}`;
  TABLE_PREFIX.lastIndex = 0;
  for (let match = TABLE_PREFIX.exec(text); match !== null; match = TABLE_PREFIX.exec(text)) {
    const found = readQualified(text, match.index + match[0].length);
    if (found !== undefined) pushTable(names, found.name);
  }
  for (const name of extra ?? []) pushTable(names, name);
  return names;
}

function pushTable(names: string[], name: string): void {
  if (!names.includes(name)) names.push(name);
}

function readQualified(
  text: string,
  start: number,
): { readonly name: string; readonly end: number } | undefined {
  const schema = readIdent(text, start);
  if (schema === undefined) return undefined;
  if (text[schema.end] !== "." || text[schema.end + 1] !== '"') return undefined;
  const name = readIdent(text, schema.end + 1);
  if (name === undefined || text[name.end] === ".") return undefined;
  return name;
}

function readIdent(
  text: string,
  start: number,
): { readonly name: string; readonly end: number } | undefined {
  if (text[start] !== '"') return undefined;
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      if (text[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }
      return { name: value, end: index + 1 };
    }
    value += char ?? "";
    index += 1;
  }
  return undefined;
}

function pushDrop(steps: PlanStep[], object: CatalogObject, schema: string): void {
  const sql = dropObjectSql(object, schema);
  const kind = dropKind(object);
  if (sql === undefined || kind === undefined) return;
  steps.push(step(sql, kind, "ddl", ACCESS));
}

function createKind(object: CatalogObject, tableIsNew: boolean): StepKind | undefined {
  switch (object.kind) {
    case "table":
      return "create-table";
    case "column":
      return requiredColumn(object) && !tableIsNew ? "add-column-required" : "add-column";
    case "index":
      return "create-index";
    case "constraint":
      return "add-constraint";
    case "sequence":
      return "create-sequence";
    case "type":
      return isDomain(object.definition) ? "create-domain" : "create-enum";
    case "extension":
      return "create-extension";
    case "function":
      return "create-function";
    case "trigger":
      return "create-trigger";
    case "view":
      return "create-view";
    case "materializedView":
      return "create-matview";
    default:
      return undefined;
  }
}

function dropKind(object: CatalogObject): StepKind | undefined {
  switch (object.kind) {
    case "table":
      return "drop-table";
    case "column":
      return "drop-column";
    case "index":
      return "drop-index";
    case "constraint":
      return "drop-constraint";
    case "sequence":
      return "drop-sequence";
    case "type":
      return isDomain(object.definition) ? "drop-domain" : "drop-enum";
    case "extension":
      return "drop-extension";
    case "function":
      return "drop-function";
    case "trigger":
      return "drop-trigger";
    case "view":
      return "drop-view";
    case "materializedView":
      return "drop-matview";
    default:
      return undefined;
  }
}

function requiredColumn(column: ColumnObject): boolean {
  const definition = column.definition;
  return (
    !definition.nullable &&
    definition.defaultExpression === undefined &&
    definition.identity === undefined &&
    definition.generated === undefined
  );
}

function columnAlterKinds(before: ColumnObject, after: ColumnObject): readonly StepKind[] {
  const kinds: StepKind[] = [];
  if (
    before.definition.dataType !== after.definition.dataType ||
    before.definition.collation !== after.definition.collation
  ) {
    kinds.push("set-column-type");
  }
  if (before.definition.nullable !== after.definition.nullable) {
    kinds.push(after.definition.nullable ? "drop-not-null" : "set-not-null");
  }
  if (before.definition.defaultExpression !== after.definition.defaultExpression) {
    kinds.push(after.definition.defaultExpression === undefined ? "drop-default" : "set-default");
  }
  return kinds;
}

function identityKind(before: ColumnObject, after: ColumnObject): StepKind | undefined {
  if (stable(before.definition.identity) === stable(after.definition.identity)) return undefined;
  const next = after.definition.identity;
  const previous = before.definition.identity;
  if (next === undefined) return "drop-identity";
  if (previous === undefined) return "add-identity";
  return next.always ? "set-identity-always" : "set-identity-by-default";
}

function stable(value: unknown): string {
  return JSON.stringify(order(value));
}

function order(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => order(item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) next[key] = order(record[key]);
    return next;
  }
  return value;
}
