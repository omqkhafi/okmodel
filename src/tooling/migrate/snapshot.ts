/**
 * Head snapshot install and the comparison with a replayed history (D198).
 *
 * Provision plans the head catalog from an empty catalog and runs that SQL.
 * It does not replay migration files. OKM1521 is the difference between that
 * result and a full replay, after {@link canonicalTypeName} (D191).
 */

import { catalog } from "../../contracts/catalog/build.js";
import { isDomain } from "../../contracts/catalog/enum.js";
import { identityKey, identityLabel } from "../../contracts/catalog/identity.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  FunctionObject,
  MaterializedViewObject,
  TypeObject,
  ViewObject,
} from "../../contracts/catalog/types.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { roleExists } from "../../dialects/pg/role/check.js";
import { createdRoleName } from "../../dialects/pg/role/sql.js";
import { catalogsEqual } from "./equal.js";
import { omitManagedObjects } from "./managed.js";
import { planMigration } from "./plan.js";
import type { ReferenceTable } from "./reference.js";
import { referenceInserts } from "./reference.js";
import { assumeRole, grantSchema, statementOutsideTransaction } from "./runner.js";
import { canonicalTypeName } from "./type-name.js";

/** History id prefix for a target installed from the head snapshot. */
export const PROVISION_PREFIX = "provisioned@";

/**
 * History id written when a target is provisioned at `migrationId`.
 *
 * @param migrationId - Head migration id
 * @returns `provisioned@` plus that id
 */
export function provisionMark(migrationId: string): string {
  return `${PROVISION_PREFIX}${migrationId}`;
}

/**
 * Migration id stored inside a provision mark.
 *
 * @param migrationId - A history migration id
 * @returns The id after the prefix, or `undefined` when it is not a mark
 */
export function provisionedMigrationId(migrationId: string): string | undefined {
  if (!migrationId.startsWith(PROVISION_PREFIX)) return undefined;
  const id = migrationId.slice(PROVISION_PREFIX.length);
  return id.length > 0 ? id : undefined;
}

/**
 * Marks every step up through a provisioned migration as done.
 *
 * A later file stays pending. A mark whose id is not in `migrations` is left
 * for the caller to treat as history this project does not contain.
 *
 * @param migrations - Files in apply order
 * @param done - Keys `${id}:${step}` already in history
 * @param historyIds - `migration_id` values in history
 * @returns A set the applier can skip
 */
export function expandProvisioned(
  migrations: readonly { readonly id: string; readonly steps: readonly unknown[] }[],
  done: ReadonlySet<string>,
  historyIds: readonly string[],
): Set<string> {
  const next = new Set(done);
  let covered = -1;
  for (const historyId of historyIds) {
    const id = provisionedMigrationId(historyId);
    if (id === undefined) continue;
    const index = migrations.findIndex((migration) => migration.id === id);
    if (index > covered) covered = index;
  }
  for (let index = 0; index <= covered; index += 1) {
    const migration = migrations[index];
    if (migration === undefined) continue;
    for (let step = 0; step < migration.steps.length; step += 1) {
      next.add(`${migration.id}:${String(step)}`);
    }
  }
  return next;
}

/**
 * Reports whether a history id belongs to this project's files.
 *
 * A `provisioned@` mark belongs when the id after the prefix is a file.
 *
 * @param migrationId - History migration id
 * @param known - File ids
 * @returns `true` when status should not call the row ahead
 */
export function provisionHistoryIsKnown(migrationId: string, known: ReadonlySet<string>): boolean {
  if (known.has(migrationId)) return true;
  const id = provisionedMigrationId(migrationId);
  return id !== undefined && known.has(id);
}

/**
 * Installs `head` into an empty schema and inserts reference rows.
 *
 * The plan is from an empty catalog, so no expand, backfill, or contract
 * file is replayed. An existing role is left in place. The caller records
 * history.
 *
 * @param connection - Reserved connection, after the advisory lock
 * @param head - Head snapshot
 * @param schema - Schema that receives the objects
 * @param reference - Rows to insert if missing
 * @param migrationRole - Role assumed after this run creates it
 */
export async function installSnapshot(
  connection: DriverConnection,
  head: Catalog,
  schema: string,
  reference: readonly ReferenceTable[],
  session: { setRole?: string },
  migrationRole?: string,
): Promise<void> {
  const plan = planMigration({ before: catalog([]), after: head, schema, name: "provision" });
  let began = false;
  const batch: string[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await connection.execute("begin");
    began = true;
    for (const sql of batch) await connection.execute(sql);
    await connection.execute("commit");
    began = false;
    batch.length = 0;
  };
  try {
    for (const step of plan.steps) {
      if (step.backfill !== undefined) continue;
      const created = createdRoleName(step.sql);
      const existed = created !== undefined && (await roleExists(connection, created));
      if (created !== undefined && existed) {
        if (created === migrationRole) await assumeRole(connection, created, session);
        continue;
      }
      if (step.transactional && !statementOutsideTransaction(step.sql)) {
        batch.push(step.sql);
      } else {
        await flush();
        await connection.execute(step.sql);
      }
      if (created !== undefined && created === migrationRole) {
        await flush();
        await grantSchema(connection, schema, created);
        await connection.execute(
          `grant select, insert, update on okm_meta, okm_history, okm_backfill to ${quoteIdent(created)}`,
        );
        await assumeRole(connection, created, session);
      }
    }
    await flush();
    for (const sql of referenceInserts(reference, schema)) {
      if (!began) {
        await connection.execute("begin");
        began = true;
      }
      await connection.execute(sql);
    }
    if (began) {
      await connection.execute("commit");
      began = false;
    }
  } catch (error) {
    if (began) await connection.execute("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * Names the first object that differs between two introspected catalogs.
 *
 * Type names are compared with {@link canonicalTypeName}. Managed history
 * tables are omitted. `undefined` means the catalogs match.
 *
 * @param left - One introspection
 * @param right - The other introspection
 * @returns The object, and the statement that would change it, when they differ
 */
export function snapshotDifference(left: Catalog, right: Catalog): string | undefined {
  const provided = normaliseCatalog(omitManagedObjects(left));
  const replayed = normaliseCatalog(omitManagedObjects(right));
  if (catalogsEqual(provided, replayed)) return undefined;
  const forward = diffSteps(provided, replayed);
  const backward = diffSteps(replayed, provided);
  const sql = forward[0] ?? backward[0];
  const object = firstObject(provided, replayed);
  return sql === undefined ? object : `${object}\n${sql}`;
}

function diffSteps(before: Catalog, after: Catalog): readonly string[] {
  try {
    return planMigration({ before, after, name: "snapshot" }).steps.map((step) => step.sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [message];
  }
}

function firstObject(left: Catalog, right: Catalog): string {
  const rightBy = new Map(right.objects.map((object) => [identityKey(object.identity), object]));
  for (const object of left.objects) {
    const other = rightBy.get(identityKey(object.identity));
    if (other === undefined) return `${identityLabel(object.identity)} is only in the snapshot`;
    if (JSON.stringify(object) !== JSON.stringify(other)) return identityLabel(object.identity);
  }
  for (const object of right.objects) {
    if (!left.objects.some((item) => identityKey(item.identity) === identityKey(object.identity))) {
      return `${identityLabel(object.identity)} is only in the replayed history`;
    }
  }
  return "the catalogs differ";
}

function normaliseCatalog(source: Catalog): Catalog {
  let changed = false;
  const objects = source.objects.map((object) => {
    const next = normaliseObject(object);
    if (next !== object) changed = true;
    return next;
  });
  return changed ? { version: source.version, objects } : source;
}

function normaliseObject(object: CatalogObject): CatalogObject {
  if (object.kind === "column") return normaliseColumn(object);
  if (object.kind === "type" && isDomain(object.definition)) return normaliseDomain(object);
  if (object.kind === "view") return normaliseView(object);
  if (object.kind === "materializedView") return normaliseMatview(object);
  if (object.kind === "function") return normaliseFunction(object);
  return object;
}

function normaliseColumn(object: ColumnObject): ColumnObject {
  const dataType = canonicalTypeName(object.definition.dataType);
  if (dataType === object.definition.dataType) return object;
  return { ...object, definition: { ...object.definition, dataType } };
}

function normaliseDomain(object: TypeObject): TypeObject {
  if (!isDomain(object.definition)) return object;
  const base = canonicalTypeName(object.definition.base);
  if (base === object.definition.base) return object;
  return { ...object, definition: { ...object.definition, base } };
}

function normaliseView(object: ViewObject): ViewObject {
  const columns = normaliseViewColumns(object.definition.columns);
  if (columns === object.definition.columns) return object;
  return { ...object, definition: { ...object.definition, columns } };
}

function normaliseMatview(object: MaterializedViewObject): MaterializedViewObject {
  const columns = normaliseViewColumns(object.definition.columns);
  if (columns === object.definition.columns) return object;
  return { ...object, definition: { ...object.definition, columns } };
}

function normaliseViewColumns(
  columns: readonly { readonly name: string; readonly dataType: string }[],
): readonly { readonly name: string; readonly dataType: string }[] {
  let changed = false;
  const next = columns.map((column) => {
    const dataType = canonicalTypeName(column.dataType);
    if (dataType === column.dataType) return column;
    changed = true;
    return { ...column, dataType };
  });
  return changed ? next : columns;
}

function normaliseFunction(object: FunctionObject): FunctionObject {
  const returns = canonicalTypeName(object.definition.returns);
  let changed = returns !== object.definition.returns;
  const arguments_ = object.definition.arguments.map((argument) => {
    const type = canonicalTypeName(argument.type);
    if (type === argument.type) return argument;
    changed = true;
    return { ...argument, type };
  });
  if (!changed) return object;
  return {
    ...object,
    definition: { ...object.definition, returns, arguments: arguments_ },
  };
}
