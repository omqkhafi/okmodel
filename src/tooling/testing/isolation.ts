/**
 * Cross-tenant isolation check.
 *
 * For every tenant table, insert one row as tenant B and run the basic reads
 * and writes as tenant A. A returned row, a count above zero, or an update or
 * delete that touches a row is a leak. Global tables are skipped and listed.
 * Column tenancy is the strategy this version has. A table is tenant when its
 * predicate says so (D199).
 */

import { OkmError } from "../../contracts/error.js";
import type { RelationModel } from "../../dialects/pg/model.js";
import { insertRow, type FactoryHost } from "./factories.js";
import type { TableFacts } from "./facts.js";

/** What {@link isolation} checked, and the global tables it skipped. */
export type IsolationReport = {
  /** Tenant tables whose queries stayed inside tenant A. */
  readonly checked: readonly string[];
  /** Global tables, with the reason from `global("reason")`. */
  readonly skipped: readonly { readonly table: string; readonly reason: string }[];
};

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

/**
 * Runs the check on `host`.
 *
 * The cache used for `x.ref` is set aside for the run, so a row the test
 * already inserted is not reused as tenant B's row.
 *
 * @param host - The open harness
 * @returns The tables that were checked and the global tables that were not
 */
export async function isolation(host: FactoryHost): Promise<IsolationReport> {
  const saved = host.cache;
  host.cache = new Map();
  try {
    const checked: string[] = [];
    const skipped: { table: string; reason: string }[] = [];
    for (const facts of host.facts.values()) {
      if (facts.globalReason !== undefined) {
        skipped.push({ table: facts.name, reason: facts.globalReason });
        continue;
      }
      if (!facts.tenant) continue;
      await checkTable(host, facts);
      checked.push(facts.name);
    }
    return { checked, skipped };
  } finally {
    host.cache = saved;
  }
}

async function checkTable(host: FactoryHost, facts: TableFacts): Promise<void> {
  const key = host.schema.tenancy?.key;
  if (key === undefined) return;
  const row = await insertRow(host, facts.name, { [key]: TENANT_B }, undefined, TENANT_B);
  const where = primaryWhere(facts, row, key);
  const client = openTenant(host, TENANT_A);
  const handle = tableHandle(client, facts.name);

  const found: unknown = await handle.find({ where, limit: 1 });
  const rows = asRows(found);
  if (rows.length > 0) leak(facts.name, "find", rows[0]);

  const one: unknown = await handle.one({ where });
  if (isRow(one)) leak(facts.name, "one", one);

  const counted = asCount(await handle.count());
  if (counted > 0) leak(facts.name, "count", { count: counted });

  const exists: unknown = await handle.exists();
  if (exists === true) leak(facts.name, "exists", { exists: true });

  const relation = facts.relations[0];
  if (relation !== undefined) {
    const included: unknown = await handle.one({ where, include: includeOf(relation) });
    if (isRow(included)) leak(facts.name, "include", included);
  }

  const set = updateSet(host, facts, row);
  if (set !== undefined) {
    const updated = asCount(await handle.update({ where, set }));
    if (updated > 0) leak(facts.name, "update", { count: updated });
  }

  const deleted = asCount(await handle.delete({ where }));
  if (deleted > 0) leak(facts.name, "delete", { count: deleted });
}

function includeOf(relation: RelationModel): Record<string, unknown> {
  if (relation.kind === "many") return { [relation.name]: { limit: 1 } };
  return { [relation.name]: true };
}

function updateSet(
  host: FactoryHost,
  facts: TableFacts,
  row: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const column = facts.columns.find(
    (item) => item.writable && !item.guarded && !facts.primary.includes(item.field),
  );
  if (column === undefined) return undefined;
  const current = row[column.field];
  if (current !== undefined && !facts.foreignKeys.some((key) => key.columns.includes(column.sql))) {
    return { [column.field]: current };
  }
  return { [column.field]: valueFrom(host, facts, column.field, row) };
}

function valueFrom(
  host: FactoryHost,
  facts: TableFacts,
  field: string,
  row: Record<string, unknown>,
): unknown {
  const column = facts.columns.find((item) => item.field === field);
  if (column === undefined) return row[field];
  try {
    if (column.dataType === "uuid") return host.rng.uuid();
    column.encode(row[field]);
    return row[field];
  } catch {
    return host.rng.uuid();
  }
}

function primaryWhere(
  facts: TableFacts,
  row: Record<string, unknown>,
  tenantKey: string | undefined,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const field of facts.primary) {
    if (field === tenantKey) continue;
    where[field] = row[field];
  }
  if (Object.keys(where).length === 0) {
    throw new OkmError("invalid", `Table ${facts.name} has no primary key to look up.`, {
      fix: { summary: "Give the tenant table a primary key so isolation can address one row." },
    });
  }
  return where;
}

function leak(table: string, query: string, row: unknown): never {
  throw new OkmError("invalid", `Isolation leak on ${table}.${query}.\n${JSON.stringify(row)}`, {
    fix: { summary: "A query under tenant A returned a row inserted for tenant B." },
  });
}

function openTenant(host: FactoryHost, tenant: string): object {
  const key = host.schema.tenancy?.key ?? "tenantId";
  const db: object = host.db;
  if (!("for" in db) || typeof db.for !== "function") {
    throw new OkmError("invalid", "This schema has no for().", {
      fix: { summary: "Pass columnTenancy() to schema({ tenancy })." },
    });
  }
  const opened: unknown = db.for({ [key]: tenant });
  if (typeof opened !== "object" || opened === null) {
    throw new OkmError("invalid", "for() did not return a client.", {
      fix: { summary: "The tenant key must be a uuid." },
    });
  }
  return opened;
}

type QueryHandle = {
  find(options: object): Promise<unknown>;
  one(options: object): Promise<unknown>;
  count(options?: object): Promise<unknown>;
  exists(options?: object): Promise<unknown>;
  update(target: object): Promise<unknown>;
  delete(target: object): Promise<unknown>;
};

function tableHandle(client: object, name: string): QueryHandle {
  if (!("table" in client) || typeof client.table !== "function") {
    throw new OkmError("invalid", "The client has no table().", {
      fix: { summary: "Connect with the schema before isolation()." },
    });
  }
  const handle: unknown = client.table(name);
  if (!isQueryHandle(handle)) {
    throw new OkmError("invalid", `Table ${name} is not on this client.`, {
      fix: { summary: "A tenant table is reached with for({ tenantId })." },
    });
  }
  return handle;
}

function isQueryHandle(value: unknown): value is QueryHandle {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.find === "function" && typeof record.one === "function";
}

function asRows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRow);
}

function asCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null && "count" in value) {
    const count = (value as { readonly count: unknown }).count;
    if (typeof count === "number") return count;
  }
  return 0;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
