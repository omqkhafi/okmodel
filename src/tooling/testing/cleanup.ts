/**
 * Drops the catalog `testing()` applied.
 *
 * `creationOrder` is dependencies first. The reverse is the drop list, with
 * three adjustments the catalog edges do not cover: views and materialized
 * views are created after the tables they read, but a view body is not an
 * edge until it is sealed, so they drop before tables. A foreign key depends
 * on the target primary key in Postgres and not on that constraint in the
 * catalog, so foreign keys drop before other constraints. Types drop last,
 * after the columns and functions that use them. An `ignored` object was not
 * created and is not dropped. An identity sequence is created by its column
 * and goes away with that column.
 */

import { creationOrder } from "../../contracts/catalog/document.js";
import { identityLabel } from "../../contracts/catalog/identity.js";
import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import type { DriverPool } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import {
  dropObjectSql,
  identitySequence,
  ownedByView,
  policyDropPlan,
} from "../../dialects/pg/ddl.js";

/** Schema `testing()` applies into. */
const SCHEMA = "public";

/**
 * Kinds that still have dependents after the phases above.
 *
 * A view body and a function call are not catalog edges. `CASCADE` drops
 * those dependents. Tables do not: a foreign key is dropped on its own, and
 * cascading a table would change an `ignored` table that points at it.
 */
const CASCADE = new Set<CatalogObject["kind"]>(["view", "materializedView", "function"]);

/** One statement and the object it drops. */
type DropStep = {
  readonly label: string;
  readonly sql: string;
};

/**
 * Drops what the catalog apply created, then returns the first failure.
 *
 * Later failures stay in the database and do not replace the first one.
 * The caller closes the pool before throwing.
 *
 * @param pool - Pool the catalog was applied on
 * @param source - Catalog `testing()` applied
 * @returns The first drop that failed, or `undefined` when every drop ran
 */
export async function dropAppliedCatalog(
  pool: DriverPool,
  source: Catalog,
): Promise<OkmError | undefined> {
  let first: OkmError | undefined;
  for (const step of dropSteps(source)) {
    try {
      await pool.execute(step.sql);
    } catch (error) {
      first ??= dropFailure(step.label, error);
    }
  }
  return first;
}

/**
 * Drop statements in the order {@link dropAppliedCatalog} runs them.
 *
 * @param source - Catalog `testing()` applied
 * @returns Statements, dependents first
 */
function dropSteps(source: Catalog): readonly DropStep[] {
  const reverse = [...creationOrder(source)].reverse();
  const emitted = new Set<CatalogObject>();
  const steps: DropStep[] = [];
  const emit = (object: CatalogObject): void => {
    if (emitted.has(object)) return;
    emitted.add(object);
    if (object.owner === "ignored") return;
    if (object.kind === "sequence" && identitySequence(object, source)) return;
    const label = objectLabel(object);
    if (object.kind === "policy") {
      for (const step of policyDropPlan(object, SCHEMA)) steps.push({ label, sql: step.sql });
      return;
    }
    const sql = dropObjectSql(object, SCHEMA);
    if (sql === undefined) return;
    steps.push({ label, sql: CASCADE.has(object.kind) ? `${sql} cascade` : sql });
  };
  for (const object of reverse) if (leads(object)) emit(object);
  for (const object of reverse) if (object.kind === "policy") emit(object);
  for (const object of reverse) if (object.kind === "function") emit(object);
  for (const object of reverse) if (isForeignKey(object)) emit(object);
  for (const object of reverse) {
    if (
      leads(object) ||
      object.kind === "policy" ||
      object.kind === "function" ||
      object.kind === "type" ||
      object.kind === "extension" ||
      isForeignKey(object)
    ) {
      continue;
    }
    emit(object);
  }
  for (const object of reverse) {
    if (object.kind === "type" || object.kind === "extension") emit(object);
  }
  return steps;
}

/**
 * Views, their indexes, materialized views, and triggers.
 *
 * These have to leave before the table or function they use. Create order
 * does not put an unsealed view after its table.
 *
 * @param object - Catalog object
 * @returns Whether the object drops in the first phase
 */
function leads(object: CatalogObject): boolean {
  return (
    object.kind === "trigger" ||
    object.kind === "view" ||
    object.kind === "materializedView" ||
    ownedByView(object)
  );
}

/**
 * A foreign key. It drops before the primary key it requires.
 *
 * @param object - Catalog object
 * @returns Whether the object is a foreign key
 */
function isForeignKey(object: CatalogObject): boolean {
  return object.kind === "constraint" && object.definition.constraintKind === "foreignKey";
}

/**
 * Names an object in a drop error.
 *
 * @param object - Catalog object
 * @returns Kind and name, with the parent table when the object has one
 */
function objectLabel(object: CatalogObject): string {
  const identity = object.identity;
  if ("parent" in identity) return `${identity.kind} ${identity.parent.name}.${identity.name}`;
  return identityLabel(identity);
}

/**
 * The error for one drop that the database rejected.
 *
 * @param label - Object that could not be dropped
 * @param error - What the driver threw
 * @returns An `invalid` error naming that object
 */
function dropFailure(label: string, error: unknown): OkmError {
  const detail = error instanceof Error ? error.message : "the database rejected the drop";
  const sqlstate = sqlstateOf(error);
  return new OkmError("invalid", `could not drop ${label}: ${detail}`, {
    kind: "invalid",
    ...(sqlstate !== undefined ? { sqlstate } : {}),
    fix: { summary: `${label} is still in the database.` },
  });
}

/**
 * Reads a SQLSTATE off a driver error.
 *
 * @param error - A thrown value
 * @returns The SQLSTATE, when the value carries one
 */
function sqlstateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("sqlstate" in error)) return undefined;
  const sqlstate = error.sqlstate;
  return typeof sqlstate === "string" ? sqlstate : undefined;
}
