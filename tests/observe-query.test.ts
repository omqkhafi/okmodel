/**
 * Per-statement query events (G-6).
 */

import { expect, test } from "bun:test";

import { POSTGRESJS_CAPABILITIES } from "../src/adapters/capabilities.js";
import type { DriverConnection, DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import { queryObserver, toOtel, writeObserver } from "../src/runtime/observe.js";
import type { ObserveEvent, QueryEvent, WriteEvent } from "../src/runtime/observe-types.js";
import { sanitizeSql } from "../src/runtime/observe-query.js";
import { otel, type OtelSpan, type OtelTracer } from "../src/runtime/otel.js";
import { POSTGRES_FEATURES } from "../src/tooling/capabilities/postgres.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  body: t.text(),
});
const secrets = table("secrets", {
  id: t.text().primaryKey(),
  body: t.text(),
  secret: t.text().sensitive(),
  token: t.text().hidden({ filterable: true }),
});
const app = schema({ casing: "snake", tables: [notes] });
const secretApp = schema({ casing: "snake", tables: [secrets] });

const VERSION: ExecuteResult = {
  rows: [["170000", "PostgreSQL 17.0", null]],
  count: 1,
  notices: [],
};

const EMPTY: ExecuteResult = { rows: [], count: 0, notices: [] };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function serving(result: ExecuteResult): DriverPool {
  let checked = false;
  return {
    capabilities: POSTGRESJS_CAPABILITIES,
    execute(text) {
      if (!checked && text.toLowerCase().includes("server_version")) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.resolve(result);
    },
    batch: (statements) => Promise.resolve(statements.map(() => result)),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

function failing(error: unknown): DriverPool {
  let checked = false;
  return {
    capabilities: POSTGRESJS_CAPABILITIES,
    execute(text) {
      if (!checked && text.toLowerCase().includes("server_version")) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.reject(error);
    },
    batch: () => Promise.reject(error),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

function interactive(result: ExecuteResult): DriverPool {
  let checked = false;
  const connection: DriverConnection = {
    execute: (text) => {
      const sql = text.trim().toLowerCase();
      if (sql.startsWith("begin") || sql.startsWith("commit") || sql.startsWith("rollback")) {
        return Promise.resolve(EMPTY);
      }
      return Promise.resolve(result);
    },
    batch: (statements) => Promise.resolve(statements.map(() => result)),
    release: () => Promise.resolve(),
  };
  return {
    capabilities: { ...POSTGRESJS_CAPABILITIES, transactions: "interactive" },
    reserve: () => Promise.resolve(connection),
    execute(text) {
      if (!checked && text.toLowerCase().includes("server_version")) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.resolve(result);
    },
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

function recorder(): {
  readonly tracer: OtelTracer;
  readonly spans: { name: string; attributes: Record<string, string | number | boolean> }[];
} {
  const spans: { name: string; attributes: Record<string, string | number | boolean> }[] = [];
  const tracer: OtelTracer = {
    startSpan(name, options) {
      const seen = { name, attributes: { ...options?.attributes } };
      spans.push(seen);
      const span: OtelSpan = {
        setAttribute(key, value) {
          seen.attributes[key] = value;
        },
        setStatus() {},
        recordException() {},
        addEvent() {},
        end() {},
      };
      return span;
    },
  };
  return { tracer, spans };
}

test("proof:queryObserver.timing", () => {
  expect(POSTGRES_FEATURES["queryObserver.timing"]?.support).toBe("native");
  expect(POSTGRES_FEATURES["queryObserver.timing"]?.cost).toBe("query|decode");
});

test("sanitizeSql replaces literals and refuses raw text", () => {
  expect(sanitizeSql("select 'a--b', 12, $1", "SELECT notes")).toBe("select ?, ?, $1");
  expect(sanitizeSql("select E'x', 1.5", "SELECT notes")).toBe("select ?, ?");
  expect(sanitizeSql("select $12", "SELECT notes")).toBe("select $12");
  expect(sanitizeSql("select t1.col", "SELECT notes")).toBe("select t1.col");
  expect(sanitizeSql("select -- hi", "SELECT notes")).toBe("SELECT notes");
  expect(sanitizeSql("select $$body$$", "SELECT notes")).toBe("SELECT notes");
  expect(sanitizeSql("select 'unterminated", "SELECT notes")).toBe("SELECT notes");
});

test("a statement without an observer does not read the clock", async () => {
  const original = Date.now;
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return original.call(Date);
  };
  try {
    const db = createClient(
      app,
      serving({ rows: [["n1", "body"]], count: 1, reported: 1, notices: [] }),
      {
        ownsPool: false,
      },
    );
    await db.connected;
    calls = 0;
    await db.notes.find({ limit: 1 });
    await db.notes.delete({ where: { id: "n1" } });
    expect(calls).toBe(0);

    const watched = createClient(
      app,
      serving({ rows: [["n1", "body"]], count: 1, reported: 1, notices: [] }),
      {
        ownsPool: false,
        onQuery: queryObserver({ query() {} }),
      },
    );
    await watched.connected;
    calls = 0;
    await watched.notes.find({ limit: 1 });
    expect(calls).toBeGreaterThan(0);
  } finally {
    Date.now = original;
  }
});

test("a read reports the plan fingerprint, sanitised text, and no row values", async () => {
  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    query: (event) => {
      events.push(event);
    },
  });
  const db = createClient(
    app,
    serving({ rows: [["n1", "row-body-should-stay-out"]], count: 1, reported: 1, notices: [] }),
    { ownsPool: false, onQuery },
  );
  const handle = db.notes.find({ where: { id: "n1" }, limit: 5 });
  const inspected = await handle.inspect();
  const rows = await handle;
  expect(rows).toEqual([{ id: "n1", body: "row-body-should-stay-out" }]);
  const event = events[0];
  expect(event?.fingerprint).toBe(inspected.plan.fingerprint);
  expect(event?.summary).toBe("SELECT notes");
  expect(event?.op).toBe("find");
  expect(event?.dialect).toBe("postgres");
  expect(event?.table).toBe("notes");
  expect(event?.queueMs).toBeNull();
  expect(event?.rowCount).toBe(1);
  expect(event?.rowCountMode).toBe("returned");
  expect(event?.route).toEqual({ endpoint: "primary", role: "primary" });
  expect(event?.limit).toEqual({ value: 5, source: "caller" });
  expect(event?.unit).toBeUndefined();
  expect(event?.params).toBeUndefined();
  expect(event?.stack).toBeUndefined();
  expect(event?.text).not.toContain("row-body-should-stay-out");
  expect(JSON.stringify(event)).not.toContain("row-body-should-stay-out");
  expect(event?.decodeMs).toEqual(expect.any(Number));
});

test("one() does not report its internal limit and sanitises the inlined number", async () => {
  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    query: (event) => {
      events.push(event);
    },
  });
  const db = createClient(
    app,
    serving({ rows: [["n1", "body"]], count: 1, reported: 1, notices: [] }),
    {
      ownsPool: false,
      onQuery,
    },
  );
  await db.notes.one({ where: { id: "n1" } });
  expect(events[0]?.limit).toBeUndefined();
  expect(events[0]?.text).toContain("limit ?");
  expect(events[0]?.text).not.toContain("limit 2");
  expect(events[0]?.summary).toBe("SELECT notes");
});

test("params and stack are opt-in, and sensitive values are redacted", async () => {
  const secret = "sensitive-column-value-7c2b";
  const hidden = "hidden-filter-value-19aa";
  const plain: QueryEvent[] = [];
  const open = queryObserver({
    params: true,
    stack: true,
    query: (event) => {
      plain.push(event);
    },
  });
  const db = createClient(secretApp, serving({ rows: [], count: 0, reported: 0, notices: [] }), {
    ownsPool: false,
    onQuery: open,
  });
  await db.secrets.find({ where: { secret, token: hidden, id: "visible-id" }, limit: 1 });
  const event = plain[0];
  expect(event?.stack).toEqual(expect.any(String));
  expect(event?.params).toContain("[redacted]");
  expect(event?.params).toContain("visible-id");
  expect(event?.params).not.toContain(secret);
  expect(event?.params).not.toContain(hidden);
  const mapped = toOtel(event as QueryEvent, { statement: true });
  const blob = JSON.stringify(mapped.attributes);
  expect(blob).not.toContain(secret);
  expect(blob).not.toContain(hidden);
  expect(blob).not.toContain("[redacted]");
  expect(blob).not.toContain(event?.stack ?? "missing-stack");
  expect(mapped.attributes["db.query.text"]).toBe(event?.text);

  const bare: QueryEvent[] = [];
  const quiet = queryObserver({
    query: (item) => {
      bare.push(item);
    },
  });
  const again = createClient(secretApp, serving({ rows: [], count: 0, reported: 0, notices: [] }), {
    ownsPool: false,
    onQuery: quiet,
  });
  await again.secrets.find({ where: { secret, id: "visible-id" }, limit: 1 });
  expect(bare[0]?.params).toBeUndefined();
  expect(bare[0]?.stack).toBeUndefined();
  expect(JSON.stringify(bare[0])).not.toContain(secret);
});

test("tenant parameter values are redacted", async () => {
  const tenants = table("tenant_notes", {
    id: t.text().primaryKey(),
    body: t.text(),
  });
  const tenantApp = schema({
    casing: "snake",
    tables: [tenants],
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  });
  const tenant = "11111111-1111-4111-8111-111111111111";
  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    params: true,
    query: (event) => {
      events.push(event);
    },
  });
  const db = createClient(tenantApp, serving({ rows: [], count: 0, reported: 0, notices: [] }), {
    ownsPool: false,
    onQuery,
  }).for({ tenantId: tenant });
  await db.tenant_notes.find({ limit: 1 });
  expect(events[0]?.params).toContain("[redacted]");
  expect(JSON.stringify(events)).not.toContain(tenant);
  expect(JSON.stringify(toOtel(events[0] as QueryEvent).attributes)).not.toContain(tenant);
});

test("a throwing or rejecting handler does not change the result", async () => {
  const errors: unknown[] = [];
  const onQuery = queryObserver({
    query() {
      throw new Error("observer-blew-up");
    },
    onObserverError(error) {
      errors.push(error);
    },
  });
  const db = createClient(
    app,
    serving({ rows: [["n1", "body"]], count: 1, reported: 1, notices: [] }),
    {
      ownsPool: false,
      onQuery,
    },
  );
  expect(await db.notes.find({ limit: 1 })).toEqual([{ id: "n1", body: "body" }]);
  expect((errors[0] as Error).message).toBe("observer-blew-up");

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waited: QueryEvent[] = [];
  let flushed = false;
  const slow = queryObserver({
    query: async (event) => {
      waited.push(event);
      await gate;
    },
  });
  const second = createClient(
    app,
    serving({ rows: [["n1", "body"]], count: 1, reported: 1, notices: [] }),
    {
      ownsPool: false,
      onQuery: slow,
    },
  );
  expect(await second.notes.find({ limit: 1 })).toEqual([{ id: "n1", body: "body" }]);
  const pending = slow.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  expect(flushed).toBe(false);
  release();
  await pending;
  expect(waited).toHaveLength(1);

  const rejected = queryObserver({
    query: () => Promise.reject(new Error("observer-rejected")),
    onObserverError(error) {
      errors.push(error);
    },
  });
  const third = createClient(app, serving({ rows: [["n1", "body"]], count: 1, notices: [] }), {
    ownsPool: false,
    onQuery: rejected,
  });
  expect(await third.notes.find({ limit: 1 })).toEqual([{ id: "n1", body: "body" }]);
  await rejected.flush();
  expect((errors.at(-1) as Error).message).toBe("observer-rejected");
});

test("the query buffer overflows with OKM2200", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: QueryEvent[] = [];
  const errors: unknown[] = [];
  const onQuery = queryObserver({
    maxPending: 1,
    query: (event) => {
      seen.push(event);
      return gate;
    },
    onObserverError(error) {
      errors.push(error);
    },
  });
  const db = createClient(app, serving({ rows: [], count: 0, reported: 0, notices: [] }), {
    ownsPool: false,
    onQuery,
  });
  await db.notes.find({ limit: 1 });
  await db.notes.find({ limit: 1 });
  expect(seen).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(OkmError);
  expect((errors[0] as OkmError).code).toBe("OKM2200");
  release();
  await onQuery.flush();
});

test("a failed statement reports kind, category, code, and SQLSTATE", async () => {
  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    query: (event) => {
      events.push(event);
    },
  });
  const error = new OkmError("unique", "duplicate", {
    kind: "unique",
    sqlstate: "23505",
  });
  const db = createClient(app, failing(error), { ownsPool: false, onQuery });
  const caught = await rejection(db.notes.find({ limit: 1 }));
  expect(caught).toBeInstanceOf(OkmError);
  expect(events[0]?.error).toEqual({
    kind: "unique",
    category: "conflict",
    code: "unique",
    sqlstate: "23505",
  });
  expect(events[0]?.rowCount).toBeNull();
  expect(events[0]?.rowCountMode).toBe("unknown");
  expect(events[0]?.decodeMs).toBeNull();
  const mapped = toOtel(events[0] as QueryEvent);
  expect(mapped.attributes["error.type"]).toBe("unique");
  expect(mapped.attributes["db.response.status_code"]).toBe("23505");
  expect(mapped.attributes["db.query.text"]).toBeUndefined();
  expect(mapped.name).toBe("SELECT notes");
});

test("toOtel uses the same attribute names as okmodel/otel", async () => {
  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    query: (event) => {
      events.push(event);
    },
  });
  const db = createClient(app, serving({ rows: [], count: 0, reported: 0, notices: [] }), {
    ownsPool: false,
    onQuery,
  });
  const handle = db.notes.find({ limit: 1 });
  const inspection = await handle.inspect();
  await handle;
  const recorded = recorder();
  otel({ tracer: recorded.tracer }).query(inspection);
  const span = recorded.spans[0];
  const mapped = toOtel(events[0] as QueryEvent);
  expect(Object.keys(mapped.attributes).sort()).toEqual(Object.keys(span?.attributes ?? {}).sort());
  expect(mapped.attributes["db.system.name"]).toBe("postgresql");
  expect(mapped.attributes["db.namespace"]).toBe("public");
  expect(mapped.attributes["db.collection.name"]).toBe("notes");
  expect(mapped.attributes["db.operation.name"]).toBe("find");
  expect(mapped.attributes["db.query.summary"]).toBe(events[0]?.fingerprint);
  expect(mapped.attributes["db.query.summary"]).toBe(inspection.plan.fingerprint);

  const withText = recorder();
  otel({ tracer: withText.tracer, statement: true }).query(inspection);
  const stated = toOtel(events[0] as QueryEvent, { statement: true });
  expect(Object.keys(stated.attributes).sort()).toEqual(
    Object.keys(withText.spans[0]?.attributes ?? {}).sort(),
  );

  const failed = recorder();
  const observers = otel({ tracer: failed.tracer });
  observers.hookm.onError?.(
    new OkmError("unique", "duplicate", {
      kind: "unique",
      sqlstate: "23505",
    }),
  );
  expect(failed.spans[0]?.attributes["db.response.status_code"]).toBe("23505");
});

test("query and write events share a row count", async () => {
  const writes: ObserveEvent[] = [];
  const queries: QueryEvent[] = [];
  const onWrite = writeObserver({
    onEvent: (event) => {
      writes.push(event);
    },
  });
  const onQuery = queryObserver({
    query: (event) => {
      queries.push(event);
    },
  });
  const db = createClient(app, serving({ rows: [], count: 4, reported: 4, notices: [] }), {
    ownsPool: false,
    onWrite,
    onQuery,
  });
  expect(await db.notes.delete({ where: { id: "n1" } })).toEqual({ count: 4 });
  await onWrite.flush();
  const write = writes.find((event): event is WriteEvent => event.type === "write");
  expect(queries[0]).toMatchObject({
    op: "delete",
    summary: "DELETE notes",
    rowCount: 4,
    rowCountMode: "changed",
    decodeMs: null,
  });
  expect(queries[0]?.rowCount).toBe(write?.rowCount);
  expect(queries[0]?.rowCountMode).toBe(write?.rowCountMode);
  expect(queries[0]?.text).not.toContain("n1");
});

test("an insert that returns rows is counted as returned", async () => {
  const queries: QueryEvent[] = [];
  const onQuery = queryObserver({
    query: (event) => {
      queries.push(event);
    },
  });
  const db = createClient(
    app,
    serving({ rows: [["n1", "body"]], count: 1, reported: 1, notices: [] }),
    {
      ownsPool: false,
      onQuery,
    },
  );
  await db.notes.insert({ id: "n1", body: "inserted-row-value-9f3a" });
  expect(queries[0]).toMatchObject({
    op: "insert",
    summary: "INSERT notes",
    rowCount: 1,
    rowCountMode: "returned",
  });
  expect(queries[0]?.decodeMs).toEqual(expect.any(Number));
  expect(JSON.stringify(queries)).not.toContain("inserted-row-value-9f3a");
});

test("a missing command tag is unknown", async () => {
  const queries: QueryEvent[] = [];
  const onQuery = queryObserver({
    query: (event) => {
      queries.push(event);
    },
  });
  const db = createClient(app, serving({ rows: [], count: 1, reported: null, notices: [] }), {
    ownsPool: false,
    onQuery,
  });
  await db.notes.delete({ where: { id: "n1" } });
  expect(queries[0]?.rowCount).toBeNull();
  expect(queries[0]?.rowCountMode).toBe("unknown");
});

test("reads inside a transaction share a unit", async () => {
  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    query: (event) => {
      events.push(event);
    },
  });
  const db = createClient(app, interactive({ rows: [], count: 0, reported: 0, notices: [] }), {
    ownsPool: false,
    onQuery,
  });
  await db.tx(async (tx) => {
    await tx.notes.find({ limit: 1 });
    await tx.notes.find({ limit: 2 });
  });
  expect(events).toHaveLength(2);
  expect(events[0]?.unit).toEqual(expect.any(String));
  expect(events[1]?.unit).toBe(events[0]?.unit);
  expect(events[0]?.seq).toBe(0);
  expect(events[1]?.seq).toBe(1);
  expect(events[0]?.limit).toEqual({ value: 1, source: "caller" });
  expect(events[1]?.limit).toEqual({ value: 2, source: "caller" });
});

test("tag is validated and copied onto query and write events", async () => {
  const bad = rejection(
    Promise.resolve().then(() => {
      queryObserver({ query() {}, tag: "has space" });
    }),
  );
  expect(await bad).toBeInstanceOf(OkmError);
  expect(() => writeObserver({ tag: "has space" })).toThrow(OkmError);

  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    tag: "api.request",
    query: (event) => {
      events.push(event);
    },
  });
  const writes: ObserveEvent[] = [];
  const onWrite = writeObserver({
    tag: "api.request",
    onEvent: (event) => {
      writes.push(event);
    },
  });
  const db = createClient(app, serving({ rows: [], count: 1, reported: 1, notices: [] }), {
    ownsPool: false,
    onQuery,
    onWrite,
  });
  await db.notes.delete({ where: { id: "n1" } });
  await onWrite.flush();
  expect(events[0]?.tag).toBe("api.request");
  expect(writes.find((event) => event.type === "write")).toMatchObject({ tag: "api.request" });
});

test("a replica route is labelled replica", async () => {
  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    query: (event) => {
      events.push(event);
    },
  });
  const db = createClient(app, serving({ rows: [], count: 0, reported: 0, notices: [] }), {
    ownsPool: false,
    onQuery,
  });
  await db.notes.find({ limit: 1, route: "replica" });
  expect(events[0]?.route).toEqual({ endpoint: "replica", role: "replica" });
});
