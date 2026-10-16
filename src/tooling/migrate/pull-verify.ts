/**
 * Replays pulled routines on a scratch schema.
 *
 * Create order is the catalog's dependency order, plus lexical edges for a
 * plpgsql or SQL-string body. `check_function_bodies` is on. A SQL function
 * or a view whose dependency is missing fails creation. A plpgsql body is
 * not proved by creation, so a function that is created is still
 * candidate-only. The scratch schema is dropped before this returns.
 */

import { isDomain } from "../../contracts/catalog/enum.js";
import { OkmError } from "../../contracts/error.js";
import { identityKey } from "../../contracts/catalog/identity.js";
import { functionObject } from "../../contracts/catalog/routine.js";
import { materializedViewObject, viewObject } from "../../contracts/catalog/view.js";
import { dependencyOrder } from "../../contracts/catalog/order.js";
import type {
  Catalog,
  CatalogObject,
  FunctionObject,
  MaterializedViewObject,
  ObjectIdentity,
  ViewObject,
} from "../../contracts/catalog/types.js";
import {
  createObjectSql,
  createTableSql,
  identitySequence,
  quoteIdent,
} from "../../dialects/pg/ddl.js";
import type { CatalogQuery } from "../../dialects/pg/introspect.js";
import { cellText } from "../../dialects/pg/view/depend.js";
import { verdictsWithoutScratch, type RoutinePlan, type RoutineVerdict } from "./pull-routines.js";

const SCRATCH = "okm_pull_verify";

/**
 * Creates the planned routines from empty and records what that proved.
 *
 * Types are created first. Everything else follows the catalog dependency
 * order, so a function with no edge is created before its tables. Routine
 * bodies see only the scratch schema. A role that cannot create a schema
 * leaves every function unproved.
 *
 * @param runner - Database connection. Statements share its session
 * @param source - Introspected catalog
 * @param plan - Routines `okm pull` will write
 * @returns One verdict per planned function, trigger, and view
 */
export async function verifyPulled(
  runner: CatalogQuery,
  source: Catalog,
  plan: RoutinePlan,
): Promise<readonly RoutineVerdict[]> {
  if (plan.functions.length === 0 && plan.triggers.length === 0 && plan.views.length === 0) {
    return [];
  }
  await dropScratch(runner);
  try {
    await runner.query(`create schema ${quoteIdent(SCRATCH)}`);
  } catch (error) {
    return verdictsWithoutScratch(plan, firstLine(error));
  }
  const savedPath = await setting(runner, "search_path");
  const savedBodies = await setting(runner, "check_function_bodies");
  const path = `${quoteIdent(SCRATCH)}, public`;
  try {
    await runner.query(`select set_config('check_function_bodies', 'on', false)`);
    await runner.query(`select set_config('search_path', $1, false)`, [path]);
    await createTypes(runner, source);
    const routinePath = `${quoteIdent(SCRATCH)}, pg_catalog`;
    const failures = new Map<string, string>();
    for (const object of ordered(source, plan)) {
      if (!creates(object, source, plan)) continue;
      const statement =
        object.kind === "table"
          ? createTableSql(object, source, SCRATCH)
          : createObjectSql(object, SCRATCH);
      if (statement === undefined) continue;
      const routine =
        object.kind === "function" ||
        object.kind === "view" ||
        object.kind === "materializedView" ||
        object.kind === "trigger";
      if (routine) await runner.query(`select set_config('search_path', $1, false)`, [routinePath]);
      else await runner.query(`select set_config('search_path', $1, false)`, [path]);
      try {
        await runner.query(statement);
      } catch (error) {
        failures.set(identityKey(object.identity), firstLine(error));
      }
    }
    return verdicts(plan, failures);
  } finally {
    await runner
      .query(`select set_config('search_path', $1, false)`, [savedPath])
      .catch(() => undefined);
    await runner
      .query(`select set_config('check_function_bodies', $1, false)`, [savedBodies])
      .catch(() => undefined);
    await dropScratch(runner);
  }
}

function ordered(source: Catalog, plan: RoutinePlan): readonly CatalogObject[] {
  const augmented = augment(source, plan.orderEdges);
  try {
    return dependencyOrder(augmented);
  } catch (error) {
    if (error instanceof OkmError && error.code === "OKM1026")
      return dependencyOrder(source.objects);
    throw error;
  }
}

function augment(
  source: Catalog,
  edges: ReadonlyMap<string, readonly ObjectIdentity[]>,
): readonly CatalogObject[] {
  return source.objects.map((object) => {
    const extra = edges.get(identityKey(object.identity));
    if (extra === undefined || extra.length === 0) return object;
    const dependencies = [...object.dependencies.map((edge) => edge.target), ...extra];
    if (object.kind === "function") return copyFunction(object, dependencies);
    if (object.kind === "view") return copyView(object, dependencies);
    if (object.kind === "materializedView") return copyMatview(object, dependencies);
    return object;
  });
}

function copyFunction(
  object: FunctionObject,
  dependencies: readonly ObjectIdentity[],
): FunctionObject {
  return functionObject({
    namespace: object.identity.namespace,
    name: object.identity.name,
    arguments: object.definition.arguments,
    returns: object.definition.returns,
    language: object.definition.language,
    volatility: object.definition.volatility,
    security: object.definition.security,
    body: object.definition.body,
    ...(object.definition.searchPath !== undefined
      ? { searchPath: object.definition.searchPath }
      : {}),
    ...(object.definition.atomic === true ? { atomic: true } : {}),
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function copyView(object: ViewObject, dependencies: readonly ObjectIdentity[]): ViewObject {
  return viewObject({
    namespace: object.identity.namespace,
    name: object.identity.name,
    columns: object.definition.columns,
    query: object.definition.query,
    ...(object.definition.securityInvoker === true ? { securityInvoker: true } : {}),
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function copyMatview(
  object: MaterializedViewObject,
  dependencies: readonly ObjectIdentity[],
): MaterializedViewObject {
  return materializedViewObject({
    namespace: object.identity.namespace,
    name: object.identity.name,
    columns: object.definition.columns,
    query: object.definition.query,
    ...(object.definition.refresh !== undefined ? { refresh: object.definition.refresh } : {}),
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function creates(object: CatalogObject, source: Catalog, plan: RoutinePlan): boolean {
  if (object.kind === "type") return false;
  if (object.kind === "column") return false;
  if (object.kind === "constraint" && object.definition.constraintKind === "primaryKey")
    return false;
  if (object.kind === "sequence" && identitySequence(object, source)) return false;
  if (object.kind === "table") return object.definition.partition === undefined;
  if (object.kind === "extension" || object.kind === "policy" || object.kind === "role")
    return false;
  if (object.kind === "grant" || object.kind === "defaultPrivilege") return false;
  const key = identityKey(object.identity);
  if (object.kind === "function")
    return plan.functions.some((item) => identityKey(item.object.identity) === key);
  if (object.kind === "trigger")
    return plan.triggers.some((item) => identityKey(item.object.identity) === key);
  if (object.kind === "view" || object.kind === "materializedView") {
    return plan.views.some((item) => identityKey(item.object.identity) === key);
  }
  return true;
}

async function createTypes(runner: CatalogQuery, source: Catalog): Promise<void> {
  const types = source.objects.filter((object) => object.kind === "type");
  const enums = types.filter((object) => object.kind === "type" && !isDomain(object.definition));
  const domains = types.filter((object) => object.kind === "type" && isDomain(object.definition));
  for (const object of [...enums, ...domains]) {
    const statement = createObjectSql(object, SCRATCH);
    if (statement !== undefined) await runner.query(statement);
  }
}

function verdicts(
  plan: RoutinePlan,
  failures: ReadonlyMap<string, string>,
): readonly RoutineVerdict[] {
  const verdicts: RoutineVerdict[] = [];
  for (const item of plan.functions) {
    const key = identityKey(item.object.identity);
    const failed = failures.get(key);
    const plpgsql = item.object.definition.language === "plpgsql";
    let status: RoutineVerdict["status"] = "verified";
    if (failed !== undefined) status = "unverified";
    else if (plpgsql) status = "candidate-only";
    verdicts.push({
      key,
      kind: "function",
      label: `${item.object.identity.name}(${item.object.identity.argTypes.join(", ")})`,
      status,
      detail: failed ?? "",
    });
  }
  for (const item of plan.triggers) {
    const key = identityKey(item.object.identity);
    const failed = failures.get(key);
    verdicts.push({
      key,
      kind: "trigger",
      label: `${item.object.identity.parent.name}.${item.object.identity.name}`,
      status: failed !== undefined ? "unverified" : "verified",
      detail: failed ?? "",
    });
  }
  for (const item of plan.views) {
    const key = identityKey(item.object.identity);
    const failed = failures.get(key);
    verdicts.push({
      key,
      kind: item.object.kind,
      label: item.object.identity.name,
      status: failed !== undefined ? "unverified" : "verified",
      detail: failed ?? "",
    });
  }
  return verdicts;
}

async function setting(runner: CatalogQuery, name: string): Promise<string> {
  const rows = await runner.query(`select current_setting($1) as value`, [name]);
  return cellText(rows[0]?.value);
}

async function dropScratch(runner: CatalogQuery): Promise<void> {
  await runner.query(`drop schema if exists ${quoteIdent(SCRATCH)} cascade`).catch(() => undefined);
}

function firstLine(error: unknown): string {
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : "create failed";
  const line = message.split("\n")[0] ?? message;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
