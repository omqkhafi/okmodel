/**
 * Cross-tenant isolation check.
 *
 * For every tenant table, insert one row as tenant B and run the reads and
 * writes as tenant A against that row's key. A returned row, or an update or
 * delete that touches it, is a leak. The row is deleted afterwards. Global
 * tables are skipped and listed.
 * A table is tenant when its predicate says so (D199). Composite tenancy changes
 * one key at a time. A path table is checked through a parent that belongs to
 * tenant B.
 */

import { OkmError } from "../../contracts/error.js";
import type { RelationModel } from "../../dialects/pg/model.js";
import { forgetCached, insertRow, type FactoryHost } from "./factories.js";
import type { TableFacts } from "./facts.js";

/** What {@link isolation} checked, and the global tables it skipped. */
export type IsolationReport = {
  /** Tenant tables whose queries stayed inside tenant A. */
  readonly checked: readonly string[];
  /** Global tables, with the reason from `global("reason")`. */
  readonly skipped: readonly { readonly table: string; readonly reason: string }[];
};

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
    if (host.schema.tenancy?.strategy === "rls") {
      const check = (host.db as { "~rls"?: () => Promise<void> })["~rls"];
      if (check === undefined) {
        throw new OkmError("invalid", "Row-level security has no policy check on this client.", {
          fix: { summary: "Open the client from a schema that uses rlsTenancy()." },
        });
      }
      await check();
    }
    const checked: string[] = [];
    const skipped: { table: string; reason: string }[] = [];
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    for (const facts of host.facts.values()) {
      if (facts.globalReason !== undefined) {
        skipped.push({ table: facts.name, reason: facts.globalReason });
        continue;
      }
      if (!facts.tenant) continue;
      const hops = host.schema.tenancy?.pathOf?.(facts.name);
      if (hops !== undefined && hops.length > 0) {
        await checkPath(host, facts, hops, tenantA, tenantB);
      } else {
        await checkTable(host, facts, tenantA, tenantB);
        const keys = tenantKeys(host);
        if (keys.length > 1) await checkFlips(host, facts, keys, tenantA, tenantB);
      }
      checked.push(facts.name);
    }
    return { checked, skipped };
  } finally {
    host.cache = saved;
  }
}

async function checkTable(
  host: FactoryHost,
  facts: TableFacts,
  tenantA: string,
  tenantB: string,
): Promise<void> {
  const key = host.schema.tenancy?.key;
  if (key === undefined) return;
  const keys = tenantKeys(host);
  if (host.definitions.size > 0 && !host.definitions.has(facts.name)) {
    throw new OkmError("invalid", `Factory ${facts.name} is missing.`, {
      fix: { summary: `Add ${facts.name} to factories().` },
    });
  }
  const row = await insertRow(host, facts.name, { [key]: tenantB }, undefined, tenantB);
  const where = primaryWhere(facts, row, keys);
  const client = openTenant(host, tenantA);
  const handle = tableHandle(client, facts.name);
  try {
    await readTenant(facts, handle, where);
    const set = updateSet(host, facts, row);
    if (set !== undefined) {
      const updated = asCount(await handle.update({ where, set }));
      if (updated > 0) leak(facts.name, "update", { count: updated });
      if (typeof client.batch === "function") {
        const batched: unknown = await client.batch([handle.update({ where, set })]);
        if (Array.isArray(batched) && batched.some((item) => asCount(item) > 0)) {
          leak(facts.name, "batch", batched);
        }
      }
    }
    const removed = asCount(await handle.delete({ where }));
    if (removed > 0) leak(facts.name, "delete", { count: removed });
  } finally {
    const owner = tableHandle(openTenant(host, tenantB), facts.name);
    await owner.delete({ where }).catch(() => undefined);
    forgetCached(host, facts.name, tenantB);
  }
}

async function readTenant(
  facts: TableFacts,
  handle: QueryHandle,
  where: Record<string, unknown>,
): Promise<void> {
  const query = handle.find({ where, limit: 1 });
  const rows = asRows(await query);
  if (rows.length > 0) leak(facts.name, "find", rows[0]);
  const streamed = handle.find({ where, limit: 1 });
  if (typeof streamed.stream === "function") {
    try {
      for await (const item of streamed.stream()) {
        if (isRow(item)) leak(facts.name, "stream", item);
      }
    } catch (error) {
      if (!(error instanceof OkmError) || error.code !== "OKM1111") throw error;
    }
  }

  const one: unknown = await handle.one({ where });
  if (isRow(one)) leak(facts.name, "one", one);

  const counted = asCount(await handle.count({ where }));
  if (counted > 0) leak(facts.name, "count", { count: counted });

  const exists: unknown = await handle.exists({ where });
  if (exists === true) leak(facts.name, "exists", { exists: true });

  const relation = facts.relations[0];
  if (relation !== undefined) {
    const included: unknown = await handle.one({ where, include: includeOf(relation) });
    if (isRow(included)) leak(facts.name, "include", included);
  }

  if (typeof handle.aggregate === "function") {
    const aggregated: unknown = await handle.aggregate({ where, count: true });
    if (Array.isArray(aggregated)) {
      for (const item of aggregated) {
        if (isRow(item) && asCount(item) > 0) leak(facts.name, "aggregate", item);
      }
    }
  }

  if (typeof handle.page === "function") {
    const orderField = Object.keys(where)[0];
    if (orderField !== undefined) {
      const paged: unknown = await handle.page({
        where,
        orderBy: { [orderField]: "asc" },
        limit: 5,
      });
      if (isRow(paged) && Array.isArray(paged.items) && paged.items.length > 0) {
        leak(facts.name, "page", paged.items[0]);
      }
    }
  }
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
  tenantKeys: readonly string[],
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const field of facts.primary) {
    if (tenantKeys.includes(field)) continue;
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

function tenantKeys(host: FactoryHost): readonly string[] {
  const tenancy = host.schema.tenancy;
  if (tenancy === undefined) return [];
  if (tenancy.keys !== undefined && tenancy.keys.length > 0) return tenancy.keys;
  return [tenancy.key];
}

function scopeFor(keys: readonly string[], tenant: string): Record<string, string> {
  const input: Record<string, string> = {};
  for (const key of keys) input[key] = tenant;
  return input;
}

async function checkFlips(
  host: FactoryHost,
  facts: TableFacts,
  keys: readonly string[],
  tenantA: string,
  tenantB: string,
): Promise<void> {
  const template = await insertRow(host, facts.name, undefined, undefined, tenantB);
  const data: Record<string, unknown> = { ...template };
  for (const key of keys) delete data[key];
  const clientA = openTenant(host, scopeFor(keys, tenantA));
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const values = scopeFor(keys, tenantA);
      const flipped = keys[index];
      if (flipped === undefined) continue;
      values[flipped] = tenantB;
      const client = openTenant(host, values);
      const stored: unknown = await tableHandle(client, facts.name).insert(data);
      if (!isRow(stored)) continue;
      const where = primaryWhere(facts, stored, keys);
      await readTenant(facts, tableHandle(clientA, facts.name), where);
      await tableHandle(client, facts.name)
        .delete({ where })
        .catch(() => undefined);
    }
  } finally {
    const where = primaryWhere(facts, template, keys);
    await tableHandle(openTenant(host, tenantB), facts.name)
      .delete({ where })
      .catch(() => undefined);
    forgetCached(host, facts.name, tenantB);
  }
}

async function checkPath(
  host: FactoryHost,
  facts: TableFacts,
  hops: readonly {
    readonly child: string;
    readonly parent: string;
    readonly localField: string;
    readonly remoteField: string;
  }[],
  tenantA: string,
  tenantB: string,
): Promise<void> {
  const keys = tenantKeys(host);
  const created: { readonly table: string; readonly where: Record<string, unknown> }[] = [];
  const last = hops[hops.length - 1];
  if (last === undefined) return;
  let parent = await insertRow(host, last.parent, undefined, undefined, tenantB);
  created.push({
    table: last.parent,
    where: primaryWhere(requireFacts(host, last.parent), parent, keys),
  });
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index];
    if (hop === undefined) continue;
    const row = await insertRow(
      host,
      hop.child,
      { [hop.localField]: parent[hop.remoteField] },
      undefined,
      tenantB,
    );
    parent = row;
    created.push({
      table: hop.child,
      where: primaryWhere(requireFacts(host, hop.child), row, keys),
    });
  }
  const where = primaryWhere(facts, parent, keys);
  const client = openTenant(host, tenantA);
  try {
    await readTenant(facts, tableHandle(client, facts.name), where);
    const set = updateSet(host, facts, parent);
    if (set !== undefined) {
      const updated = asCount(await tableHandle(client, facts.name).update({ where, set }));
      if (updated > 0) leak(facts.name, "update", { count: updated });
    }
    const removed = asCount(await tableHandle(client, facts.name).delete({ where }));
    if (removed > 0) leak(facts.name, "delete", { count: removed });
  } finally {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      const item = created[index];
      if (item === undefined) continue;
      await tableHandle(openTenant(host, tenantB), item.table)
        .delete({ where: item.where })
        .catch(() => undefined);
      forgetCached(host, item.table, tenantB);
    }
  }
}

function requireFacts(host: FactoryHost, name: string): TableFacts {
  const facts = host.facts.get(name);
  if (facts === undefined) {
    throw new OkmError("invalid", `Table ${name} is not in the schema.`, {
      fix: { summary: "The path must name a table in this schema." },
    });
  }
  return facts;
}

function openTenant(
  host: FactoryHost,
  tenant: string | Readonly<Record<string, string>>,
): ClientLike {
  const keys = tenantKeys(host);
  const input = typeof tenant === "string" ? scopeFor(keys, tenant) : tenant;
  const db: object = host.db;
  if (!("for" in db) || typeof db.for !== "function") {
    throw new OkmError("invalid", "This schema has no for().", {
      fix: { summary: "Pass columnTenancy() to schema({ tenancy })." },
    });
  }
  const opened: unknown = db.for(input);
  if (typeof opened !== "object" || opened === null) {
    throw new OkmError("invalid", "for() did not return a client.", {
      fix: { summary: "The tenant key must be a uuid." },
    });
  }
  return opened as ClientLike;
}

type Streamed = Promise<unknown> & { stream?(): AsyncIterable<unknown> };

type QueryHandle = {
  find(options: object): Streamed;
  one(options: object): Promise<unknown>;
  count(options?: object): Promise<unknown>;
  exists(options?: object): Promise<unknown>;
  update(target: object): Promise<unknown>;
  delete(target: object): Promise<unknown>;
  insert(row: object): Promise<unknown>;
  aggregate?(options: object): Promise<unknown>;
  page?(options: object): Promise<unknown>;
};

type ClientLike = {
  batch?(ops: readonly unknown[]): Promise<unknown>;
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
