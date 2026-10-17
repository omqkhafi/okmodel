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
 * Tenant views and materialized views are read the same way. The rows are
 * inserted into the underlying tables, never into the view. A global view is
 * skipped and listed with its `global("reason")`.
 */

import { OkmError } from "../../contracts/error.js";
import type { RelationModel } from "../../dialects/pg/model.js";
import { viewMentions } from "../../dialects/pg/view/client.js";
import { forgetCached, insertRow, type FactoryHost } from "./factories.js";
import { readViews, type TableFacts, type ViewFacts } from "./facts.js";

/** What {@link isolation} checked, and the global objects it skipped. */
export type IsolationReport = {
  /** Tenant tables whose queries stayed inside tenant A. */
  readonly checked: readonly string[];
  /** Tenant views and materialized views whose reads stayed inside tenant A. */
  readonly views: readonly string[];
  /** Global tables and views, with the reason from `global("reason")`. */
  readonly skipped: readonly { readonly table: string; readonly reason: string }[];
};

/**
 * Runs the check on `host`.
 *
 * The cache used for `x.ref` is set aside for the run, so a row the test
 * already inserted is not reused as tenant B's row.
 *
 * @param host - The open harness
 * @returns The tables and views that were checked, and the global objects that were not
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
    const views = await checkViews(host, tenantA, tenantB, skipped);
    return { checked, skipped, views };
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
  const keys = tenantKeys(host);
  if (keys.length === 0) return;
  if (host.definitions.size > 0 && !host.definitions.has(facts.name)) {
    throw new OkmError("invalid", `Factory ${facts.name} is missing.`, {
      fix: { summary: `Add ${facts.name} to factories().` },
    });
  }
  const overrides: Record<string, unknown> = {};
  for (const key of keys) overrides[key] = tenantB;
  const row = await insertRow(host, facts.name, overrides, undefined, tenantB);
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
      if (!(error instanceof OkmError)) throw error;
      const refused =
        error.code === "OKM1111" ||
        (error.code === "OKM1120" && error.message.includes("primary key"));
      if (!refused) throw error;
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
      let stored: unknown;
      try {
        stored = await tableHandle(client, facts.name).insert(data);
      } catch (error) {
        // A composite FK that includes tenant keys refuses a flipped row.
        // The insert never landed, so there is nothing for tenant A to leak.
        if (error instanceof OkmError && error.kind === "foreign_key") continue;
        throw error;
      }
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

const SCAN_LIMIT = 100;

async function checkViews(
  host: FactoryHost,
  tenantA: string,
  tenantB: string,
  skipped: { table: string; reason: string }[],
): Promise<string[]> {
  const checked: string[] = [];
  const keys = tenantKeys(host);
  for (const view of readViews(host.schema)) {
    if (view.globalReason !== undefined) {
      skipped.push({ table: view.name, reason: view.globalReason });
      continue;
    }
    if (!view.tenant) continue;
    await checkView(host, view, keys, tenantA, tenantB);
    checked.push(view.name);
  }
  return checked;
}

async function checkView(
  host: FactoryHost,
  view: ViewFacts,
  keys: readonly string[],
  tenantA: string,
  tenantB: string,
): Promise<void> {
  const sources = orderSources(host, sourceNames(host, view.query));
  if (sources.length === 0) {
    throw new OkmError("invalid", `View ${view.name} names no table isolation can seed.`, {
      fieldReason: "no-source",
      fix: { summary: 'Point the view at a table in this schema, or mark it global("reason").' },
    });
  }
  for (const name of sources) {
    if (host.definitions.size > 0 && !host.definitions.has(name)) {
      throw new OkmError("invalid", `Factory ${name} is missing.`, {
        fix: { summary: `Add ${name} to factories().` },
      });
    }
  }
  const before = new Map(host.cache);
  const seeded: Record<string, unknown>[] = [];
  try {
    for (const tenant of [tenantA, tenantB]) {
      for (const name of sources) {
        const facts = requireFacts(host, name);
        const overrides = markerFor(view, facts, keys, tenant);
        for (const key of keys) overrides[key] = tenant;
        const row = await insertRow(host, name, overrides, undefined, tenant);
        if (tenant === tenantB) seeded.push(row);
      }
    }
    const handle = viewHandle(openTenant(host, tenantA), view.name);
    if (view.kind === "materializedView") {
      if (handle.refresh === undefined) {
        throw new OkmError("invalid", `View ${view.name} has no refresh().`, {
          fieldReason: "no-refresh",
          fix: { summary: "A materialized view refreshes before the isolation read." },
        });
      }
      await handle.refresh();
    }
    await readView(view, handle, keys, tenantB, seeded);
  } finally {
    await dropNewRows(host, before, keys);
  }
}

function sourceNames(host: FactoryHost, query: string): string[] {
  const names: string[] = [];
  for (const facts of host.facts.values()) {
    if (viewMentions(query, facts.sql) || viewMentions(query, facts.name)) names.push(facts.name);
  }
  return names;
}

function orderSources(host: FactoryHost, names: readonly string[]): string[] {
  const wanted = new Set(names);
  const ordered: string[] = [];
  const pending = [...names];
  const guard = pending.length * pending.length + 1;
  let spins = 0;
  while (pending.length > 0 && spins < guard) {
    spins += 1;
    const name = pending.shift();
    if (name === undefined) break;
    const facts = host.facts.get(name);
    const waiting = facts?.foreignKeys.some((key) => {
      let parent: string | undefined;
      for (const item of host.facts.values()) {
        if (item.sql === key.target) parent = item.name;
      }
      return parent !== undefined && wanted.has(parent) && !ordered.includes(parent);
    });
    if (waiting) pending.push(name);
    else ordered.push(name);
  }
  return ordered.length === names.length ? ordered : [...names];
}

function markerFor(
  view: ViewFacts,
  facts: TableFacts,
  keys: readonly string[],
  tenant: string,
): Record<string, unknown> {
  const value = `isolation-${tenant}`;
  const out: Record<string, unknown> = {};
  for (const column of view.columns) {
    if (column.guarded || keys.includes(column.field)) continue;
    if (column.dataType.toLowerCase() !== "text") continue;
    const source = facts.columns.find((item) => item.field === column.field);
    if (source === undefined || !source.writable || source.guarded) continue;
    if (keys.includes(source.field)) continue;
    if (facts.foreignKeys.some((key) => key.columns.includes(source.sql))) continue;
    out[source.field] = value;
  }
  return out;
}

async function readView(
  view: ViewFacts,
  handle: ViewQuery,
  keys: readonly string[],
  tenantB: string,
  seeded: readonly Record<string, unknown>[],
): Promise<void> {
  const exposed = view.columns.filter((column) => keys.includes(column.field));
  const where = markerWhere(view, keys, seeded);
  if (where === undefined && exposed.length === 0) {
    throw new OkmError(
      "invalid",
      `View ${view.name} exposes no tenant key and no text column isolation can match.`,
      {
        fieldReason: "no-marker",
        fix: { summary: "Expose the tenant key, or a text column isolation can match." },
      },
    );
  }
  if (where !== undefined) await readFiltered(view.name, handle, where);
  if (exposed.length === 0) return;
  const rows = asRows(await handle.find({ limit: SCAN_LIMIT }));
  const needle = tenantB.toLowerCase();
  for (const row of rows) {
    for (const column of exposed) {
      const value = row[column.field];
      if (typeof value === "string" && value.toLowerCase() === needle) leak(view.name, "find", row);
    }
  }
}

function markerWhere(
  view: ViewFacts,
  keys: readonly string[],
  rows: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (const column of view.columns) {
    if (column.guarded || keys.includes(column.field)) continue;
    if (column.dataType.toLowerCase() !== "text") continue;
    for (const row of rows) {
      const value = row[column.field];
      if (typeof value === "string") return { [column.field]: value };
    }
  }
  return undefined;
}

async function readFiltered(
  name: string,
  handle: ViewQuery,
  where: Record<string, unknown>,
): Promise<void> {
  const query = handle.find({ where, limit: 1 });
  const rows = asRows(await query);
  if (rows.length > 0) leak(name, "find", rows[0]);
  const streamed = handle.find({ where, limit: 1 });
  if (typeof streamed.stream === "function") {
    try {
      for await (const item of streamed.stream()) {
        if (isRow(item)) leak(name, "stream", item);
      }
    } catch (error) {
      if (!(error instanceof OkmError)) throw error;
      const refused =
        error.code === "OKM1111" ||
        (error.code === "OKM1120" && error.message.includes("primary key"));
      if (!refused) throw error;
    }
  }
  const one: unknown = await handle.one({ where });
  if (isRow(one)) leak(name, "one", one);
  if (asCount(await handle.count({ where })) > 0) leak(name, "count", { count: 1 });
  if ((await handle.exists({ where })) === true) leak(name, "exists", { exists: true });
}

async function dropNewRows(
  host: FactoryHost,
  before: ReadonlyMap<string, Record<string, unknown>>,
  keys: readonly string[],
): Promise<void> {
  const added: { key: string; row: Record<string, unknown> }[] = [];
  for (const [key, row] of host.cache) {
    if (!before.has(key)) added.push({ key, row });
  }
  for (let index = added.length - 1; index >= 0; index -= 1) {
    const item = added[index];
    if (item === undefined) continue;
    const colon = item.key.indexOf(":");
    const scope = item.key.slice(0, colon);
    const table = item.key.slice(colon + 1);
    const facts = host.facts.get(table);
    const tenant = scope === "*" ? undefined : scope;
    if (facts !== undefined) {
      try {
        const where = primaryWhere(facts, item.row, keys);
        const client = tenant === undefined ? host.db : openTenant(host, tenant);
        await tableHandle(client, table).delete({ where });
      } catch {
        // The row may already be gone.
      }
    }
    forgetCached(host, table, tenant);
  }
}

type ViewQuery = {
  find(options: object): Streamed;
  one(options: object): Promise<unknown>;
  count(options?: object): Promise<unknown>;
  exists(options?: object): Promise<unknown>;
  refresh?(): Promise<void>;
};

function viewHandle(client: object, name: string): ViewQuery {
  const views = "views" in client ? client.views : undefined;
  if (typeof views !== "object" || views === null) {
    throw new OkmError("invalid", "The client has no views.", {
      fix: { summary: "Declare the view on schema({ views }) and connect with that schema." },
    });
  }
  const handle = (views as Record<string, unknown>)[name];
  if (!isViewQuery(handle)) {
    throw new OkmError("invalid", `View ${name} is not on this client.`, {
      fix: { summary: "A tenant view is read through for().views." },
    });
  }
  return handle;
}

function isViewQuery(value: unknown): value is ViewQuery {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.find === "function" && typeof record.one === "function";
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
