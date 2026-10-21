/**
 * Primary-key RETURNING and command-tag row counts (G-5).
 */

import { expect, test } from "bun:test";

import { resultFrom } from "../src/adapters/pg/result.js";
import { POSTGRESJS_CAPABILITIES } from "../src/adapters/capabilities.js";
import type { DriverConnection, DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import { writeObserver } from "../src/runtime/observe.js";
import type { ObserveEvent, WriteEvent } from "../src/runtime/observe-types.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  body: t.text(),
});
const secrets = table("secrets", {
  id: t.text().primaryKey(),
  body: t.text(),
  secret: t.text().sensitive().hidden(),
});
const pairs = table(
  "pairs",
  {
    a: t.text(),
    b: t.text(),
    body: t.text(),
  },
  { primaryKey: ["a", "b"] },
);
const logs = table("logs", { body: t.text() });
const app = schema({ casing: "snake", tables: [notes] });
const secretApp = schema({ casing: "snake", tables: [secrets] });
const pairApp = schema({ casing: "snake", tables: [pairs] });
const keyless = schema({ casing: "snake", tables: [logs] });

const VERSION: ExecuteResult = {
  rows: [["170000", "PostgreSQL 17.0", null]],
  count: 1,
  notices: [],
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function writes(events: readonly ObserveEvent[]): WriteEvent[] {
  return events.filter((event): event is WriteEvent => event.type === "write");
}

function serving(result: ExecuteResult): { readonly pool: DriverPool; readonly texts: string[] } {
  let checked = false;
  const texts: string[] = [];
  const pool: DriverPool = {
    capabilities: POSTGRESJS_CAPABILITIES,
    execute(text) {
      texts.push(text);
      if (!checked) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.resolve(result);
    },
    batch(statements) {
      for (const statement of statements) texts.push(statement.text);
      return Promise.resolve(statements.map(() => result));
    },
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
  return { pool, texts };
}

function interactive(result: ExecuteResult): DriverPool {
  let checked = false;
  const connection: DriverConnection = {
    execute: () => Promise.resolve(result),
    batch: (statements) => Promise.resolve(statements.map(() => result)),
    release: () => Promise.resolve(),
  };
  return {
    capabilities: { ...POSTGRESJS_CAPABILITIES, transactions: "interactive" },
    execute() {
      if (!checked) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.resolve(result);
    },
    reserve: () => Promise.resolve(connection),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

test("keys are present only when the table opted in", async () => {
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    keys: ["notes"],
    onEvent: (event) => {
      events.push(event);
    },
  });
  const returned: ExecuteResult = {
    rows: [["row-1"]],
    count: 1,
    reported: 1,
    notices: [],
  };
  const { pool } = serving(returned);
  const db = createClient(app, pool, { ownsPool: false, onWrite });
  const handle = db.notes.delete({ where: { id: "row-1" } });
  const explained = await handle.sql();
  expect(explained.statements[0]?.text).toContain('returning t."id"');
  const described = await handle.describe();
  expect(described.statements[0]?.columns).toEqual([{ name: "id", label: "observer" }]);
  const inspected = await handle.inspect();
  expect(inspected.statements[0]?.text).toContain('returning t."id"');
  expect(inspected.rules).toEqual([
    { rule: "returning", contribution: "primary key", provenance: "observer" },
  ]);
  expect(await handle).toEqual({ count: 1 });
  await onWrite.flush();
  expect(writes(events)[0]?.keys).toEqual([{ id: "row-1" }]);

  const plain: ObserveEvent[] = [];
  const bare = writeObserver({
    onEvent: (event) => {
      plain.push(event);
    },
  });
  const again = serving(returned);
  const open = createClient(app, again.pool, { ownsPool: false, onWrite: bare });
  const sql = await open.notes.delete({ where: { id: "row-1" } }).sql();
  expect(sql.statements[0]?.text).not.toContain("returning");
  await open.notes.delete({ where: { id: "row-1" } });
  await bare.flush();
  expect(writes(plain)[0]?.keys).toBeUndefined();
  expect(JSON.stringify(plain)).not.toContain("row-1");
});

test("a table without a primary key cannot opt in", async () => {
  const onWrite = writeObserver({ keys: ["logs"] });
  const { pool } = serving({ rows: [], count: 0, reported: 0, notices: [] });
  const db = createClient(keyless, pool, { ownsPool: false, onWrite });
  const connected = await rejection(db.connected);
  expect(connected).toBeInstanceOf(OkmError);
  expect(connected).toMatchObject({ code: "OKM1890" });

  const planned = createClient(keyless, pool, { ownsPool: false, onWrite });
  const explained = await rejection(planned.logs.insert({ body: "x" }).sql());
  expect(explained).toMatchObject({ code: "OKM1890" });
});

test("savepoint rollback still removes the inner write when keys are on", async () => {
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    keys: ["notes"],
    onEvent: (event) => {
      events.push(event);
    },
  });
  const db = createClient(
    app,
    interactive({ rows: [["kept"]], count: 1, reported: 1, notices: [] }),
    { ownsPool: false, onWrite },
  );
  await db.connected;
  await db.tx(async (tx) => {
    await tx.notes.insert({ id: "kept", body: "outer" });
    const inner = await rejection(
      tx.tx(async (nested) => {
        await nested.notes.insert({ id: "gone", body: "inner-body" });
        throw new Error("inner");
      }),
    );
    expect(inner).toBeInstanceOf(Error);
    expect((inner as Error).message).toContain("inner");
  });
  await onWrite.flush();
  const survived = writes(events);
  expect(survived).toHaveLength(1);
  expect(survived[0]?.keys).toEqual([{ id: "kept" }]);
  expect(JSON.stringify(events)).not.toContain("inner-body");
  expect(JSON.stringify(events)).not.toContain("gone");
});

test("tenant stays on the event when keys are opted in", async () => {
  const tenants = table("tenants_notes", {
    id: t.text().primaryKey(),
    body: t.text(),
  });
  const tenantApp = schema({
    casing: "snake",
    tables: [tenants],
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  });
  const tenant = "11111111-1111-4111-8111-111111111111";
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    keys: ["tenants_notes"],
    onEvent: (event) => {
      events.push(event);
    },
  });
  const { pool } = serving({
    rows: [["n1", null, tenant]],
    count: 1,
    reported: 1,
    notices: [],
  });
  const db = createClient(tenantApp, pool, { ownsPool: false, onWrite }).for({ tenantId: tenant });
  await db.tenants_notes.insert({ id: "n1", body: "hello-tenant-body" });
  await onWrite.flush();
  const write = writes(events)[0];
  expect(write?.tenant).toEqual({ tenantId: tenant });
  expect(write?.keys).toEqual([{ id: "n1", tenantId: tenant }]);
  const blob = JSON.stringify(events);
  expect(blob).not.toContain("hello-tenant-body");
  expect(blob).toContain(tenant);
});

test("sensitive and hidden values stay out when the primary key is returned", async () => {
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    keys: ["secrets"],
    onEvent: (event) => {
      events.push(event);
    },
  });
  const { pool } = serving({ rows: [["row-1"]], count: 1, reported: 1, notices: [] });
  const db = createClient(secretApp, pool, { ownsPool: false, onWrite });
  await db.secrets.insert({
    id: "row-1",
    body: "bound-secret-body-value-9f3a",
    secret: "hidden-sensitive-column-value-7c2b",
  });
  await onWrite.flush();
  const blob = JSON.stringify(events);
  expect(blob).not.toContain("bound-secret-body-value-9f3a");
  expect(blob).not.toContain("hidden-sensitive-column-value-7c2b");
  expect(writes(events)[0]?.keys).toEqual([{ id: "row-1" }]);
});

test("row count mode follows the command tag and RETURNING", async () => {
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    keys: ["notes"],
    onEvent: (event) => {
      events.push(event);
    },
  });
  const { pool } = serving({ rows: [["row-1"]], count: 1, reported: 1, notices: [] });
  const db = createClient(app, pool, { ownsPool: false, onWrite });
  await db.notes.insert({ id: "row-1", body: "a" });
  expect(writes(events).at(-1)).toMatchObject({ rowCount: 1, rowCountMode: "returned" });

  events.length = 0;
  await db.notes.delete({ where: { id: "row-1" } });
  expect(writes(events).at(-1)).toMatchObject({ rowCount: 1, rowCountMode: "returned" });

  const counted: ObserveEvent[] = [];
  const bare = writeObserver({
    onEvent: (event) => {
      counted.push(event);
    },
  });
  const open = createClient(app, serving({ rows: [], count: 4, reported: 4, notices: [] }).pool, {
    ownsPool: false,
    onWrite: bare,
  });
  await open.notes.delete({ where: { id: "row-1" } });
  expect(writes(counted).at(-1)).toMatchObject({ rowCount: 4, rowCountMode: "changed" });

  const upserts: ObserveEvent[] = [];
  const upsertObserver = writeObserver({
    keys: ["notes"],
    onEvent: (event) => {
      upserts.push(event);
    },
  });
  const upsertDb = createClient(
    app,
    serving({ rows: [["row-1"]], count: 2, reported: 2, notices: [] }).pool,
    { ownsPool: false, onWrite: upsertObserver },
  );
  await upsertDb.notes.insert(
    { id: "row-1", body: "a" },
    { onConflict: { on: "id", update: ["body"] } },
  );
  expect(writes(upserts).at(-1)).toMatchObject({
    op: "upsert",
    rowCount: 2,
    rowCountMode: "changed",
    keys: [{ id: "row-1" }],
  });

  const silent: ObserveEvent[] = [];
  const quiet = writeObserver({
    onEvent: (event) => {
      silent.push(event);
    },
  });
  const quietDb = createClient(
    app,
    serving({ rows: [["row-1"]], count: 1, reported: null, notices: [] }).pool,
    { ownsPool: false, onWrite: quiet },
  );
  await quietDb.notes.delete({ where: { id: "row-1" } });
  expect(writes(silent).at(-1)).toMatchObject({ rowCount: null, rowCountMode: "unknown" });
});

test("a composite primary key is returned in catalog order", async () => {
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    keys: ["pairs"],
    onEvent: (event) => {
      events.push(event);
    },
  });
  const { pool } = serving({ rows: [["a1", "b1"]], count: 1, reported: 1, notices: [] });
  const db = createClient(pairApp, pool, { ownsPool: false, onWrite });
  const sql = await db.pairs.insert({ a: "a1", b: "b1", body: "z" }).sql();
  expect(sql.statements[0]?.text).toContain('returning "a", "b"');
  await db.pairs.insert({ a: "a1", b: "b1", body: "z" });
  await onWrite.flush();
  expect(writes(events)[0]?.keys).toEqual([{ a: "a1", b: "b1" }]);
  expect(JSON.stringify(events)).not.toContain("z");
});

test("command-tag fields each driver exposes", () => {
  const postgres = Object.defineProperty([["1"]], "count", { value: 1 });
  expect(resultFrom(postgres, []).reported).toBe(1);

  const unset = Object.defineProperty([["1"]], "count", { value: null });
  expect(resultFrom(unset, []).reported).toBeNull();
  expect(resultFrom(unset, []).count).toBe(1);

  expect(resultFrom({ rows: [], rowCount: 3 }, []).reported).toBe(3);
  expect(resultFrom({ rows: [["a"]], rowCount: null, affectedRows: 9 }, []).reported).toBeNull();

  const pglite = { rows: [["1"]], rowCount: 1, affectedRows: 5 };
  expect(resultFrom(pglite, []).reported).toBe(1);
  expect(resultFrom({ rows: [], affectedRows: 4 }, []).reported).toBe(4);
  expect(resultFrom({ rows: [] }, []).reported).toBeNull();
});
