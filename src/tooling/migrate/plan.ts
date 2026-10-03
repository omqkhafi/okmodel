/**
 * Diffs two catalogs into an ordered, classified plan.
 *
 * Renames are applied to a copy of the previous catalog before the diff, so
 * a declared rename is not a drop and an add. An unexplained drop-and-add is
 * OKM1530. The planner never prompts.
 *
 * Picklist and enum removals are expand `UPDATE`s plus a contract swap
 * (D131). Those data steps are plain statements here. Batching them is P52.
 */

import { OkmError } from "../../contracts/error.js";
import { creationOrder, renameColumn, renameTable } from "../../contracts/catalog/document.js";
import { identityKey, staticNamespace } from "../../contracts/catalog/identity.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
} from "../../contracts/catalog/types.js";
import type { DeclaredRename, EnumSnapshot } from "../../dialects/pg/declarations.js";
import {
  alterColumnSql,
  createObjectSql,
  createTableSql,
  dropObjectSql,
  identitySequence,
  quoteIdent,
} from "../../dialects/pg/ddl.js";
import { assertNoChains, type Replacement } from "./values.js";

/** Expand, contract, or a step that is neither. */
export type MigrationClass = "expand" | "contract" | "unclassified";

/** One statement in a plan. `backfill` is data; P16B runs it as written. */
export type PlanStep = {
  readonly sql: string;
  readonly class: MigrationClass;
  readonly action: "ddl" | "backfill";
  readonly lock: string;
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
  readonly enumsBefore?: readonly EnumSnapshot[];
  readonly enumsAfter?: readonly EnumSnapshot[];
  readonly schema?: string;
  /** Concrete schema written into the SQL. Identities stay logical. */
  readonly name?: string;
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

type EnumChange = {
  readonly before: EnumSnapshot;
  readonly after: EnumSnapshot;
  readonly removed: readonly string[];
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
export function planMigration(request: PlanRequest): MigrationPlan {
  const schema = request.schema ?? "public";
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
  const alters: { readonly before: ColumnObject; readonly after: ColumnObject }[] = [];
  for (const item of beforeList) {
    if (!afterBy.has(item.key)) dropKeys.add(item.key);
  }
  for (const item of afterList) {
    if (!beforeBy.has(item.key)) createKeys.add(item.key);
  }
  for (const item of afterList) {
    const previous = beforeBy.get(item.key);
    if (previous === undefined || sameDefinition(previous, item.object)) continue;
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
  const enums = enumChanges(request.enumsBefore ?? [], request.enumsAfter ?? []);
  requireReplacements(picklists, enums, replacements);
  recreateDependents(beforeList, afterList, alters, dropKeys, createKeys, picklists);

  const steps: PlanStep[] = [];
  steps.push(...renameSteps(request.before, renames, schema));
  steps.push(...keptNames.map((item) => renameShapeStep(item, schema)));
  steps.push(...expandBackfills(picklists, enums, replacements, schema));

  const droppedTables = new Set(
    [...dropKeys]
      .map((key) => beforeBy.get(key))
      .filter((object): object is CatalogObject => object?.kind === "table")
      .map((object) => object.identity.name),
  );
  const deferred = new Set(picklists.map((change) => identityKey(change.before.identity)));
  for (const object of [...creationOrder(renamed)].reverse()) {
    const key = identityKey(object.identity);
    if (!dropKeys.has(key) || deferred.has(key) || covered(object, droppedTables)) continue;
    const sql = dropObjectSql(object, schema);
    if (sql === undefined) continue;
    steps.push(step(sql, "contract", "ddl", ACCESS));
  }

  for (const change of alters) {
    for (const sql of alterColumnSql(change.before, change.after, schema)) {
      steps.push(step(sql, alterClass(sql), "ddl", ACCESS));
    }
  }

  const createdTables = new Set(
    [...createKeys]
      .map((key) => afterBy.get(key))
      .filter((object): object is CatalogObject => object?.kind === "table")
      .map((object) => object.identity.name),
  );
  const emitted = new Set<string>();
  for (const object of creationOrder(request.after)) {
    const key = identityKey(object.identity);
    if (deferred.has(key)) continue;
    const parent = anchoredParent(object);
    const tableIsNew = parent !== undefined && createdTables.has(parent);
    if (tableIsNew && folded(object, request.after)) continue;
    const wanted = createKeys.has(key) || (tableIsNew && !folded(object, request.after));
    if (!wanted || emitted.has(key)) continue;
    emitted.add(key);
    if (object.kind === "table") {
      steps.push(step(createTableSql(object, request.after, schema), "expand", "ddl", ACCESS));
      continue;
    }
    const sql = createObjectSql(object, schema);
    if (sql === undefined) continue;
    steps.push(step(sql, "expand", "ddl", object.kind === "index" ? SHARE : ACCESS));
  }

  steps.push(...contractSwaps(picklists, enums, replacements, schema));
  return {
    name: request.name ?? "migration",
    class: overall(steps),
    steps,
  };
}

/**
 * Prints a plan. The text is SQL plus class comments, never TypeScript.
 *
 * @param plan - Plan from {@link planMigration}
 * @returns The text `okm generate` writes and `okm migrate plan` prints
 */
export function formatPlan(plan: MigrationPlan): string {
  const lines = [`-- class: ${plan.class}`, `-- name: ${plan.name}`, ""];
  if (plan.steps.length === 0) {
    lines.push("-- no steps");
    lines.push("");
    return lines.join("\n");
  }
  for (const item of plan.steps) {
    lines.push(`-- class: ${item.class}`);
    lines.push(`-- action: ${item.action}`);
    lines.push(`-- lock: ${item.lock}`);
    lines.push(`${item.sql};`);
    lines.push("");
  }
  return lines.join("\n");
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
        "contract",
        "ddl",
        ACCESS,
      ),
    );
  }
  for (const rename of renames) {
    if (rename.kind !== "column") continue;
    const previousTable = tables.get(rename.table) ?? rename.table;
    if (!hasColumn(source, previousTable, rename.from)) continue;
    steps.push(
      step(
        `alter table ${qualify(schema, rename.table)} rename column ${quoteIdent(rename.from)} to ${quoteIdent(rename.to)}`,
        "contract",
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
    if (left.identity.name !== right.identity.name) pairs.push({ from: left, to: right });
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
      "contract",
      "ddl",
      ACCESS,
    );
  }
  if (pair.from.kind !== "constraint" || pair.to.kind !== "constraint") {
    return step("select 1", "unclassified", "ddl", ACCESS);
  }
  return step(
    `alter table ${qualify(schema, pair.from.identity.parent.name)} rename constraint ${quoteIdent(pair.from.identity.name)} to ${quoteIdent(pair.to.identity.name)}`,
    "contract",
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
    list.push(object.identity.name);
    dropped.set(group, list);
  }
  for (const [key, object] of afterBy) {
    if (beforeBy.has(key)) continue;
    const group = groupOf(object);
    if (group === undefined) continue;
    const list = added.get(group) ?? [];
    list.push(object.identity.name);
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
      .filter((item) => item.before.definition.dataType !== item.after.definition.dataType)
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

function dependsOnChanged(object: CatalogObject, columns: ReadonlySet<string>): boolean {
  if (object.kind !== "index" && object.kind !== "constraint") return false;
  return object.dependencies.some((edge) => columns.has(identityKey(edge.target)));
}

function expandBackfills(
  picklists: readonly PicklistChange[],
  enums: readonly EnumChange[],
  replacements: readonly Replacement[],
  schema: string,
): PlanStep[] {
  return dataSteps(picklists, enums, replacements, schema, "expand");
}

function contractSwaps(
  picklists: readonly PicklistChange[],
  enums: readonly EnumChange[],
  replacements: readonly Replacement[],
  schema: string,
): PlanStep[] {
  const steps: PlanStep[] = [];
  steps.push(...dataSteps(picklists, enums, replacements, schema, "contract"));
  for (const change of picklists) {
    const table = qualify(schema, change.after.identity.parent.name);
    const name = quoteIdent(change.after.identity.name);
    steps.push(
      step(
        `alter table ${table} drop constraint ${name}`,
        change.removed.length > 0 ? "contract" : "expand",
        "ddl",
        ACCESS,
      ),
    );
    const expression = change.after.definition.expression ?? "true";
    steps.push(
      step(
        `alter table ${table} add constraint ${name} check (${expression}) not valid`,
        change.removed.length > 0 ? "contract" : "expand",
        "ddl",
        ACCESS,
      ),
    );
    steps.push(
      step(
        `alter table ${table} validate constraint ${name}`,
        change.removed.length > 0 ? "contract" : "expand",
        "ddl",
        SHARE_UPDATE,
      ),
    );
  }
  for (const change of enums) {
    const type = qualify(schema, change.after.typeName);
    if (change.removed.length === 0) {
      for (const label of change.after.labels) {
        if (change.before.labels.includes(label)) continue;
        steps.push(
          step(`alter type ${type} add value ${sqlString(label)}`, "expand", "ddl", ACCESS),
        );
      }
      continue;
    }
    const old = quoteIdent(`${change.after.typeName}_old`);
    const labels = change.after.labels.map((label) => sqlString(label)).join(", ");
    const table = qualify(schema, change.after.table);
    const column = quoteIdent(change.after.column);
    steps.push(step(`alter type ${type} rename to ${old}`, "contract", "ddl", ACCESS));
    steps.push(step(`create type ${type} as enum (${labels})`, "contract", "ddl", ACCESS));
    steps.push(
      step(
        `alter table ${table} alter column ${column} type ${type} using ${column}::text::${type}`,
        "contract",
        "ddl",
        ACCESS,
      ),
    );
    steps.push(step(`drop type ${old}`, "contract", "ddl", ACCESS));
  }
  return steps;
}

function dataSteps(
  picklists: readonly PicklistChange[],
  enums: readonly EnumChange[],
  replacements: readonly Replacement[],
  schema: string,
  phase: "expand" | "contract",
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const change of picklists) {
    if (change.removed.length === 0) continue;
    const table = change.after.identity.parent.name;
    for (const value of change.removed) {
      const replacement = findReplacement(replacements, table, change.column, value);
      if (replacement === undefined) continue;
      steps.push(
        step(
          updateSql(schema, table, change.column, value, replacement.to),
          phase,
          "backfill",
          ROW,
        ),
      );
    }
  }
  for (const change of enums) {
    if (change.removed.length === 0) continue;
    for (const value of change.removed) {
      const replacement = findReplacement(
        replacements,
        change.after.table,
        change.after.column,
        value,
      );
      if (replacement === undefined) continue;
      steps.push(
        step(
          updateSql(schema, change.after.table, change.after.column, value, replacement.to, true),
          phase,
          "backfill",
          ROW,
        ),
      );
    }
  }
  return steps;
}

function requireReplacements(
  picklists: readonly PicklistChange[],
  enums: readonly EnumChange[],
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
    for (const value of change.removed) {
      const found = findReplacement(replacements, change.after.table, change.after.column, value);
      if (found === undefined) {
        missing.push(`--replace ${change.after.table}.${change.after.column}.${value}=<new>`);
        continue;
      }
      assertReplacement(found, undefined, change.after.nullable, change.after.labels);
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

function enumChanges(
  before: readonly EnumSnapshot[],
  after: readonly EnumSnapshot[],
): EnumChange[] {
  const changes: EnumChange[] = [];
  for (const next of after) {
    const previous = before.find(
      (item) => item.table === next.table && item.column === next.column,
    );
    if (previous === undefined) continue;
    const removed = previous.labels.filter((label) => !next.labels.includes(label));
    if (removed.length === 0 && previous.labels.length === next.labels.length) continue;
    changes.push({ before: previous, after: next, removed });
  }
  return changes;
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
  return (
    stable(before.definition.identity) === stable(after.definition.identity) &&
    stable(before.definition.generated) === stable(after.definition.generated)
  );
}

function sameDefinition(left: CatalogObject, right: CatalogObject): boolean {
  return stable(left.definition) === stable(right.definition);
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
  if (object.kind === "sequence" && identitySequence(object, source)) return true;
  return false;
}

function anchoredParent(object: CatalogObject): string | undefined {
  if (object.kind === "column" || object.kind === "index" || object.kind === "constraint") {
    return object.identity.parent.name;
  }
  return undefined;
}

function alterClass(sql: string): MigrationClass {
  if (sql.includes("set data type") || sql.includes("set not null")) return "contract";
  return "expand";
}

function overall(steps: readonly PlanStep[]): MigrationClass {
  if (steps.some((item) => item.class === "contract")) return "contract";
  if (steps.some((item) => item.class === "unclassified")) return "unclassified";
  return "expand";
}

function updateSql(
  schema: string,
  table: string,
  column: string,
  from: string,
  to: string | null,
  cast = false,
): string {
  const value = to === null ? "null" : sqlString(to);
  const compare = cast ? `${quoteIdent(column)}::text` : quoteIdent(column);
  return `update ${qualify(schema, table)} set ${quoteIdent(column)} = ${value} where ${compare} = ${sqlString(from)}`;
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
  classification: MigrationClass,
  action: PlanStep["action"],
  lock: string,
): PlanStep {
  return { sql, class: classification, action, lock };
}

function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
