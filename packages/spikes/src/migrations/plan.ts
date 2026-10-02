/**
 * Migration plan from catalog A to catalog B.
 *
 * Drops run in drop order. A column type change or a declared rename drops
 * dependent views, indexes, and constraints first, then alters, then recreates
 * those dependents. No statement uses `CASCADE`.
 */

import { identityKey } from "../catalog/canonical.js";
import { assertCatalog, dropOrder, creationOrder, recreatePlan } from "../catalog/graph.js";
import {
  namespaceOf,
  parentOf,
  type CatalogObject,
  type ColumnObject,
  type ConstraintObject,
} from "../catalog/object.js";
import { renderCatalog, type NamespaceBinding } from "../catalog/render.js";
import { quoteIdent } from "../catalog/sql.js";
import { diffCatalog, mappedKey, type ColumnRename } from "./diff.js";
import { MigrationError } from "./error.js";
import { lockForStatement, lockInfo, type LockInfo } from "./lock.js";
import { qualifyObject } from "./names.js";

/** Why a step is in the plan. */
export type PlanAction = "drop" | "create" | "alter" | "replace";

/** One statement, with the lock it takes. */
export type PlanStep = {
  readonly sql: string;
  readonly lock: LockInfo;
  readonly action: PlanAction;
};

/** Ordered steps that take catalog A to catalog B. */
export type MigrationPlan = {
  readonly steps: readonly PlanStep[];
};

/**
 * Plans SQL that turns `before` into `after`.
 *
 * Both catalogs must be internally valid. An ambiguous column rename throws
 * {@link MigrationError} with code OKM1530. A statement that would use
 * `CASCADE` throws OKM1821.
 *
 * @param before - Catalog already applied
 * @param after - Target catalog
 * @param bindings - Logical namespace to concrete schema
 * @param renames - Declared column renames
 * @returns Steps in apply order
 */
export function planMigration(
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
  renames: readonly ColumnRename[] = [],
): MigrationPlan {
  assertCatalog(before);
  assertCatalog(after);
  const diff = diffCatalog(before, after, renames);
  const toDrop = new Set<string>();
  for (const object of diff.drop) toDrop.add(identityKey(object.identity));
  for (const pair of diff.matched) {
    const change = classify(pair.before, pair.after);
    if (change === "recreate") toDrop.add(identityKey(pair.before.identity));
    if (change === "recreate-table") {
      toDrop.add(identityKey(pair.before.identity));
      for (const dependent of recreatePlan(before, pair.before.identity).drop) {
        toDrop.add(identityKey(dependent.identity));
      }
    }
    if (
      change === "inplace-column" &&
      pair.before.kind === "column" &&
      pair.after.kind === "column" &&
      columnForcesRecreate(pair.before, pair.after)
    ) {
      for (const dependent of dependentsOfColumn(before, pair.before)) {
        toDrop.add(identityKey(dependent.identity));
      }
    }
  }

  const steps: PlanStep[] = [];
  for (const object of dropOrder(before)) {
    if (!toDrop.has(identityKey(object.identity))) continue;
    if (coveredByDroppedTable(object, before, toDrop)) continue;
    const sql = dropSql(object, bindings);
    if (sql !== undefined) steps.push(step(sql, "drop"));
  }

  for (const pair of diff.matched) {
    if (pair.before.kind !== "column" || pair.after.kind !== "column") continue;
    if (classify(pair.before, pair.after) !== "inplace-column") continue;
    if (coveredByDroppedTable(pair.before, before, toDrop)) continue;
    for (const sql of columnAlterSql(pair.before, pair.after, bindings)) {
      steps.push(step(sql, "alter"));
    }
  }

  for (const pair of diff.matched) {
    if (pair.before.kind !== "domain" || pair.after.kind !== "domain") continue;
    if (classify(pair.before, pair.after) !== "inplace-domain") continue;
    for (const sql of domainAlterSql(pair.before, pair.after, bindings)) {
      steps.push(step(sql, "alter"));
    }
  }

  for (const pair of diff.matched) {
    if (pair.after.kind !== "function") continue;
    if (classify(pair.before, pair.after) !== "replace-function") continue;
    const sql = renderCatalog([pair.after], bindings, { partial: true })[0];
    if (sql === undefined) {
      throw new MigrationError("OKM1821", `Function ${pair.after.identity.name} rendered no SQL.`);
    }
    steps.push(
      step(
        sql.replace(/^create function\b/i, "create or replace function"),
        "replace",
        functionLock(pair.after),
      ),
    );
  }

  steps.push(...createSteps(before, after, bindings, renames, toDrop));
  return { steps };
}

/**
 * SQL text of a plan, in order.
 *
 * @param plan - Planned steps
 * @returns Statements
 */
export function planSql(plan: MigrationPlan): readonly string[] {
  return plan.steps.map((item) => item.sql);
}

function createSteps(
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
  renames: readonly ColumnRename[],
  toDrop: ReadonlySet<string>,
): readonly PlanStep[] {
  const beforeByMapped = new Map(before.map((object) => [mappedKey(object, renames), object]));
  const createKeys = new Set<string>();
  for (const object of after) {
    const prior = beforeByMapped.get(identityKey(object.identity));
    if (prior === undefined || toDrop.has(identityKey(prior.identity))) {
      createKeys.add(identityKey(object.identity));
    }
  }
  const creatingTables = new Set(
    after
      .filter((object) => object.kind === "table" && createKeys.has(identityKey(object.identity)))
      .map((object) => identityKey(object.identity)),
  );
  const steps: PlanStep[] = [];
  for (const object of creationOrder(after)) {
    if (!createKeys.has(identityKey(object.identity))) continue;
    if (isFoldedIntoNewTable(object, after, creatingTables)) continue;
    if (object.kind === "column") {
      steps.push(step(addColumnSql(object, bindings), "create"));
      continue;
    }
    if (object.kind === "constraint" && object.definition.constraintKind === "primary_key") {
      steps.push(step(addPrimaryKeySql(object, bindings), "create"));
      continue;
    }
    if (object.kind === "table") {
      const subset = [object, ...after.filter((child) => isFoldedChild(child, object))];
      for (const sql of renderCatalog(subset, bindings, { partial: true })) {
        steps.push(step(sql, "create"));
      }
      continue;
    }
    if (object.kind === "function") {
      for (const sql of renderCatalog([object], bindings, { partial: true })) {
        steps.push(step(sql, "create", functionLock(object)));
      }
      continue;
    }
    for (const sql of renderCatalog([object], bindings, { partial: true })) {
      steps.push(step(sql, "create"));
    }
  }
  return steps;
}

type Change =
  | "same"
  | "inplace-column"
  | "inplace-domain"
  | "replace-function"
  | "recreate"
  | "recreate-table";

function classify(before: CatalogObject, after: CatalogObject): Change {
  if (before.kind === "column" && after.kind === "column") {
    if ((before.definition.generatedSql ?? "") !== (after.definition.generatedSql ?? "")) {
      return "recreate";
    }
    const changed =
      before.identity.name !== after.identity.name ||
      before.definition.type !== after.definition.type ||
      before.definition.nullable !== after.definition.nullable ||
      (before.definition.defaultSql ?? "") !== (after.definition.defaultSql ?? "");
    return changed ? "inplace-column" : "same";
  }
  if (before.kind === "function" && after.kind === "function") {
    const changed =
      before.definition.body !== after.definition.body ||
      before.definition.bodyStyle !== after.definition.bodyStyle ||
      before.definition.language !== after.definition.language ||
      before.definition.returns !== after.definition.returns ||
      before.definition.volatility !== after.definition.volatility ||
      before.definition.args.map((arg) => arg.name).join(",") !==
        after.definition.args.map((arg) => arg.name).join(",");
    return changed ? "replace-function" : "same";
  }
  if (before.kind === "domain" && after.kind === "domain") {
    if (
      before.definition.baseType !== after.definition.baseType ||
      before.definition.notNull !== after.definition.notNull
    ) {
      return "recreate";
    }
    if ((before.definition.checkSql ?? "") !== (after.definition.checkSql ?? ""))
      return "inplace-domain";
    return "same";
  }
  if (before.kind === "table" && after.kind === "table") {
    return tableSignature(before) === tableSignature(after) ? "same" : "recreate-table";
  }
  return snapshot(before) === snapshot(after) ? "same" : "recreate";
}

function columnForcesRecreate(before: ColumnObject, after: ColumnObject): boolean {
  return (
    before.identity.name !== after.identity.name || before.definition.type !== after.definition.type
  );
}

function tableSignature(table: Extract<CatalogObject, { kind: "table" }>): string {
  const partition = table.definition.partitionBy;
  const key = partition === undefined ? "" : `${partition.method}:${partition.columns.join(",")}`;
  return `${key}|${table.definition.rowSecurity ? "1" : "0"}`;
}

function snapshot(object: CatalogObject): string {
  return JSON.stringify(object.definition);
}

function dependentsOfColumn(
  objects: readonly CatalogObject[],
  column: ColumnObject,
): readonly CatalogObject[] {
  const columnKey = identityKey(column.identity);
  const seeds = new Set<string>([columnKey]);
  for (const object of objects) {
    if (namesColumn(object, column)) seeds.add(identityKey(object.identity));
  }
  const dropKeys = new Set<string>();
  for (const key of seeds) {
    if (key !== columnKey) dropKeys.add(key);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const object of objects) {
      const key = identityKey(object.identity);
      if (key === columnKey || dropKeys.has(key)) continue;
      if (object.kind === "table" && object.identity.name === column.identity.parent) continue;
      const hits = object.dependencies.some(
        (edge) => seeds.has(identityKey(edge.identity)) || dropKeys.has(identityKey(edge.identity)),
      );
      if (!hits && !seeds.has(key)) continue;
      dropKeys.add(key);
      grew = true;
    }
  }
  return objects.filter((object) => dropKeys.has(identityKey(object.identity)));
}

function namesColumn(object: CatalogObject, column: ColumnObject): boolean {
  if (parentOf(object.identity) !== column.identity.parent) return false;
  const namespace = namespaceOf(object.identity)?.name;
  if (namespace !== namespaceOf(column.identity)?.name) return false;
  if (object.kind === "index") {
    return (
      object.definition.columns.includes(column.identity.name) ||
      mentions(object.definition.expression, column.identity.name)
    );
  }
  if (object.kind === "constraint") {
    return (
      object.definition.columns.includes(column.identity.name) ||
      mentions(object.definition.expression, column.identity.name)
    );
  }
  return false;
}

function mentions(expression: string | undefined, name: string): boolean {
  if (expression === undefined) return false;
  return new RegExp(`\\b${name}\\b`).test(expression);
}

function coveredByDroppedTable(
  object: CatalogObject,
  objects: readonly CatalogObject[],
  toDrop: ReadonlySet<string>,
): boolean {
  if (object.kind === "partition" || object.kind === "table") return false;
  if (object.kind === "trigger" && triggerFunctionIsDropped(object, objects, toDrop)) return false;
  const parent = parentOf(object.identity);
  if (parent === undefined) return false;
  const namespace = namespaceOf(object.identity)?.name;
  const table = objects.find(
    (item) =>
      item.kind === "table" &&
      item.identity.name === parent &&
      namespaceOf(item.identity)?.name === namespace,
  );
  return table !== undefined && toDrop.has(identityKey(table.identity));
}

function triggerFunctionIsDropped(
  trigger: Extract<CatalogObject, { kind: "trigger" }>,
  objects: readonly CatalogObject[],
  toDrop: ReadonlySet<string>,
): boolean {
  const namespace = namespaceOf(trigger.identity)?.name;
  const fn = objects.find(
    (item) =>
      item.kind === "function" &&
      item.identity.name === trigger.definition.function &&
      namespaceOf(item.identity)?.name === namespace &&
      item.identity.argTypes.join(",") === trigger.definition.functionArgTypes.join(","),
  );
  return fn !== undefined && toDrop.has(identityKey(fn.identity));
}

function isFoldedIntoNewTable(
  object: CatalogObject,
  objects: readonly CatalogObject[],
  creatingTables: ReadonlySet<string>,
): boolean {
  if (object.kind === "column") return parentTableIsNew(object, objects, creatingTables);
  if (object.kind === "constraint" && object.definition.constraintKind === "primary_key") {
    return parentTableIsNew(object, objects, creatingTables);
  }
  return false;
}

function isFoldedChild(
  child: CatalogObject,
  table: Extract<CatalogObject, { kind: "table" }>,
): boolean {
  if (child.kind === "column") {
    return (
      child.identity.parent === table.identity.name &&
      child.identity.namespace.name === table.identity.namespace.name
    );
  }
  if (child.kind === "constraint" && child.definition.constraintKind === "primary_key") {
    return (
      child.identity.parent === table.identity.name &&
      child.identity.namespace.name === table.identity.namespace.name
    );
  }
  return false;
}

function parentTableIsNew(
  object: ColumnObject | ConstraintObject,
  objects: readonly CatalogObject[],
  creatingTables: ReadonlySet<string>,
): boolean {
  const table = objects.find(
    (item) =>
      item.kind === "table" &&
      item.identity.name === object.identity.parent &&
      item.identity.namespace.name === object.identity.namespace.name,
  );
  return table !== undefined && creatingTables.has(identityKey(table.identity));
}

function dropSql(object: CatalogObject, bindings: readonly NamespaceBinding[]): string | undefined {
  switch (object.kind) {
    case "column":
      return `alter table ${qualifyObject(object, object.identity.parent, bindings)} drop column ${quoteIdent(object.identity.name)}`;
    case "constraint":
      return `alter table ${qualifyObject(object, object.identity.parent, bindings)} drop constraint ${quoteIdent(object.identity.name)}`;
    case "index":
      return `drop index ${qualifyObject(object, object.identity.name, bindings)}`;
    case "table":
    case "partition":
      return `drop table ${qualifyObject(object, object.identity.name, bindings)}`;
    case "sequence":
      return `drop sequence ${qualifyObject(object, object.identity.name, bindings)}`;
    case "domain":
      return `drop domain ${qualifyObject(object, object.identity.name, bindings)}`;
    case "function":
      return `drop function ${qualifyObject(object, object.identity.name, bindings)}(${object.identity.argTypes.join(", ")})`;
    case "trigger":
      return `drop trigger ${quoteIdent(object.identity.name)} on ${qualifyObject(object, object.identity.parent, bindings)}`;
    case "view":
      return `drop view ${qualifyObject(object, object.identity.name, bindings)}`;
    case "materialized_view":
      return `drop materialized view ${qualifyObject(object, object.identity.name, bindings)}`;
    case "policy":
      return `drop policy ${quoteIdent(object.identity.name)} on ${qualifyObject(object, object.identity.parent, bindings)}`;
    case "extension":
      return `drop extension ${quoteIdent(object.identity.name)}`;
    default:
      return undefined;
  }
}

function addColumnSql(column: ColumnObject, bindings: readonly NamespaceBinding[]): string {
  return `alter table ${qualifyObject(column, column.identity.parent, bindings)} add column ${columnLine(column)}`;
}

function columnLine(column: ColumnObject): string {
  if (column.definition.generatedSql !== undefined) {
    const nullable = column.definition.nullable ? "" : " not null";
    return `${quoteIdent(column.identity.name)} ${column.definition.type} generated always as (${column.definition.generatedSql}) stored${nullable}`;
  }
  const nullable = column.definition.nullable ? "" : " not null";
  const defaultSql =
    column.definition.defaultSql === undefined ? "" : ` default ${column.definition.defaultSql}`;
  return `${quoteIdent(column.identity.name)} ${column.definition.type}${nullable}${defaultSql}`;
}

function addPrimaryKeySql(
  constraint: ConstraintObject,
  bindings: readonly NamespaceBinding[],
): string {
  const columns = constraint.definition.columns.map((column) => quoteIdent(column)).join(", ");
  return `alter table ${qualifyObject(constraint, constraint.identity.parent, bindings)} add constraint ${quoteIdent(constraint.identity.name)} primary key (${columns})`;
}

function columnAlterSql(
  before: ColumnObject,
  after: ColumnObject,
  bindings: readonly NamespaceBinding[],
): readonly string[] {
  const table = qualifyObject(before, before.identity.parent, bindings);
  const statements: string[] = [];
  let name = before.identity.name;
  if (before.identity.name !== after.identity.name) {
    statements.push(
      `alter table ${table} rename column ${quoteIdent(before.identity.name)} to ${quoteIdent(after.identity.name)}`,
    );
    name = after.identity.name;
  }
  if (before.definition.type !== after.definition.type) {
    statements.push(
      `alter table ${table} alter column ${quoteIdent(name)} type ${after.definition.type}${usingClause(name, before.definition.type, after.definition.type)}`,
    );
  }
  const previousDefault = before.definition.defaultSql ?? "";
  const nextDefault = after.definition.defaultSql ?? "";
  if (previousDefault !== nextDefault) {
    statements.push(
      nextDefault === ""
        ? `alter table ${table} alter column ${quoteIdent(name)} drop default`
        : `alter table ${table} alter column ${quoteIdent(name)} set default ${nextDefault}`,
    );
  }
  if (before.definition.nullable !== after.definition.nullable) {
    statements.push(
      after.definition.nullable
        ? `alter table ${table} alter column ${quoteIdent(name)} drop not null`
        : `alter table ${table} alter column ${quoteIdent(name)} set not null`,
    );
  }
  return statements;
}

function usingClause(name: string, from: string, to: string): string {
  const numeric = new Set(["int2", "int4", "int8"]);
  if (numeric.has(from) && numeric.has(to)) return "";
  if (!/^[a-z_][a-z0-9_]*$/.test(to)) {
    throw new MigrationError("OKM1821", `Refusing to cast column ${name} to ${to}.`);
  }
  return ` using ${quoteIdent(name)}::${to}`;
}

function domainAlterSql(
  before: Extract<CatalogObject, { kind: "domain" }>,
  after: Extract<CatalogObject, { kind: "domain" }>,
  bindings: readonly NamespaceBinding[],
): readonly string[] {
  const name = qualifyObject(before, before.identity.name, bindings);
  const constraint = quoteIdent(`${before.identity.name}_check`);
  const statements: string[] = [];
  if (before.definition.checkSql !== undefined) {
    statements.push(`alter domain ${name} drop constraint ${constraint}`);
  }
  if (after.definition.checkSql !== undefined) {
    statements.push(
      `alter domain ${name} add constraint ${constraint} check (${after.definition.checkSql})`,
    );
  }
  return statements;
}

function functionLock(fn: Extract<CatalogObject, { kind: "function" }>): LockInfo {
  if (fn.definition.language !== "sql") return lockInfo("none", "");
  const table = fn.dependencies.find((edge) => edge.identity.kind === "table");
  if (table === undefined || table.identity.kind !== "table") return lockInfo("none", "");
  return lockInfo("AccessShareLock", table.identity.name);
}

function step(sql: string, action: PlanAction, lock?: LockInfo): PlanStep {
  if (/\bcascade\b/i.test(sql)) {
    throw new MigrationError("OKM1821", "The plan refused CASCADE.");
  }
  return { sql, lock: lock ?? lockForStatement(sql), action };
}
