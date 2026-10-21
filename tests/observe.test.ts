/**
 * Write observer emission, unit tracking, and hookm agreement (G-4).
 */

import { expect, test } from "bun:test";

import { DriverError } from "../src/adapters/error.js";
import { POSTGRESJS_CAPABILITIES } from "../src/adapters/capabilities.js";
import type { DriverConnection, DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import { createObserver, type WriteDraft } from "../src/runtime/observe-emit.js";
import {
  OBSERVE_BUFFER_MAX,
  observerBufferOverflow,
  writeObserver,
} from "../src/runtime/observe.js";
import type { ObserveEvent, OutcomeEvent, WriteEvent } from "../src/runtime/observe-types.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import type { Hookm } from "../src/runtime/types.js";
import { POSTGRES_FEATURES } from "../src/tooling/capabilities/postgres.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  body: t.text(),
});
const secrets = table("secrets", {
  id: t.text().primaryKey(),
  body: t.text(),
  secret: t.text().sensitive().hidden(),
});
const app = schema({ casing: "snake", tables: [notes] });
const secretApp = schema({ casing: "snake", tables: [secrets] });
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const draft = (seq = 0): WriteDraft => ({
  table: "notes",
  op: "insert",
  tenant: null,
  settings: [],
  durationMs: seq,
  source: "client",
});

const VERSION: ExecuteResult = {
  rows: [["170000", "PostgreSQL 17.0", null]],
  count: 1,
  notices: [],
};
const ONE: ExecuteResult = { rows: [], count: 1, notices: [] };

function recording(options: {
  readonly transactions?: "interactive" | "batch";
  readonly fail?: unknown;
}): DriverPool {
  let checked = false;
  return {
    capabilities: {
      ...POSTGRESJS_CAPABILITIES,
      transactions: options.transactions ?? "batch",
    },
    execute() {
      if (!checked) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.resolve(ONE);
    },
    batch(statements) {
      if (options.fail !== undefined) return Promise.reject(options.fail);
      return Promise.resolve(statements.map(() => ONE));
    },
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

function interactive(options?: { readonly onCommit?: () => Promise<ExecuteResult> }): {
  readonly pool: DriverPool;
} {
  let checked = false;
  const connection: DriverConnection = {
    execute(text) {
      if (text === "COMMIT" && options?.onCommit !== undefined) return options.onCommit();
      return Promise.resolve(ONE);
    },
    batch(statements) {
      return Promise.resolve(statements.map(() => ONE));
    },
    release: () => Promise.resolve(),
  };
  const pool: DriverPool = {
    capabilities: { ...POSTGRESJS_CAPABILITIES, transactions: "interactive" },
    execute() {
      if (!checked) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      return Promise.resolve(ONE);
    },
    reserve: () => Promise.resolve(connection),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
  return { pool };
}

async function rejection(promise: Promise<unknown>): Promise<OkmError> {
  try {
    await promise;
  } catch (error) {
    return error as OkmError;
  }
  throw new Error("expected a rejection");
}

function collect(): {
  readonly events: ObserveEvent[];
  readonly onWrite: (event: ObserveEvent) => void;
  readonly phases: string[];
  readonly hookm: Hookm;
} {
  const events: ObserveEvent[] = [];
  const phases: string[] = [];
  return {
    events,
    onWrite: (event) => {
      events.push(event);
    },
    phases,
    hookm: {
      onTransaction: (event) => phases.push(`${event.phase}:${event.depth}`),
    },
  };
}

function outcomes(events: readonly ObserveEvent[]): OutcomeEvent[] {
  return events.filter((event): event is OutcomeEvent => event.type === "outcome");
}

function writes(events: readonly ObserveEvent[]): WriteEvent[] {
  return events.filter((event): event is WriteEvent => event.type === "write");
}

test("proof:writeObserver.unit", async () => {
  expect(POSTGRES_FEATURES["writeObserver.unit"]?.support).toBe("native");
  expect(POSTGRES_FEATURES["writeObserver.unit"]?.cost).toBe("transaction | batch");
  const seen = collect();
  const { pool } = interactive();
  const db = createClient(app, pool, {
    ownsPool: false,
    onWrite: seen.onWrite,
    hookm: [seen.hookm],
  });
  await db.connected;
  await db.tx(async (tx) => {
    await tx.notes.delete({ where: { id: "a" } });
  });
  expect(seen.phases).toEqual(["start:0", "commit:0"]);
  expect(outcomes(seen.events).map((event) => event.outcome)).toEqual(["committed"]);
  expect(writes(seen.events).map((event) => event.op)).toEqual(["delete"]);

  seen.events.length = 0;
  seen.phases.length = 0;
  const batchPool = recording({});
  const batchDb = createClient(app, batchPool, {
    ownsPool: false,
    onWrite: seen.onWrite,
    hookm: [seen.hookm],
  });
  await batchDb.batch([
    batchDb.notes.delete({ where: { id: "a" } }),
    batchDb.notes.delete({ where: { id: "b" } }),
  ]);
  expect(seen.phases).toEqual(["start:0", "commit:0"]);
  expect(outcomes(seen.events).map((event) => event.outcome)).toEqual(["committed"]);
  expect(writes(seen.events)).toHaveLength(2);
});

test("proof:writeObserver.keys", () => {
  expect(POSTGRES_FEATURES["writeObserver.keys"]?.support).toBe("native");
  expect(POSTGRES_FEATURES["writeObserver.keys"]?.cost).toBe("returning");
  const event: WriteEvent = {
    type: "write",
    unit: "u",
    seq: 0,
    dialect: "postgres",
    table: "notes",
    op: "insert",
    rowCount: null,
    rowCountMode: "unknown",
    tenant: null,
    settings: [],
    durationMs: 0,
    source: "client",
  };
  expect(event.keys).toBeUndefined();
});

test("proof:writeObserver.rowCount", () => {
  expect(POSTGRES_FEATURES["writeObserver.rowCount"]?.support).toBe("native");
  expect(POSTGRES_FEATURES["writeObserver.rowCount"]?.cost).toBe("mixed");
  const event: WriteEvent = {
    type: "write",
    unit: "u",
    seq: 0,
    dialect: "postgres",
    table: null,
    op: "raw",
    rowCount: null,
    rowCountMode: "unknown",
    tenant: null,
    settings: [],
    durationMs: 0,
    source: "raw",
  };
  expect(event.rowCount).toBeNull();
  expect(event.rowCountMode).toBe("unknown");
});

test("one emission point: hookm phases and unit outcomes agree", async () => {
  const seen = collect();
  const { pool } = interactive();
  const db = createClient(app, pool, {
    ownsPool: false,
    onWrite: seen.onWrite,
    hookm: [seen.hookm],
  });
  await db.connected;

  // commit
  await db.tx(async (tx) => {
    await tx.notes.insert({ id: "1", body: "a" });
  });
  expect(seen.phases).toEqual(["start:0", "commit:0"]);
  expect(outcomes(seen.events)[0]?.outcome).toBe("committed");

  // rollback
  seen.events.length = 0;
  seen.phases.length = 0;
  await rejection(
    db.tx(async (tx) => {
      await tx.notes.delete({ where: { id: "1" } });
      throw new Error("boom");
    }),
  );
  expect(seen.phases).toEqual(["start:0", "rollback:0"]);
  expect(outcomes(seen.events)[0]?.outcome).toBe("rolled_back");

  // nested savepoint rolled back
  seen.events.length = 0;
  seen.phases.length = 0;
  await db.tx(async (tx) => {
    await tx.notes.insert({ id: "2", body: "b" });
    await rejection(
      tx.tx(async (inner) => {
        await inner.notes.insert({ id: "3", body: "c" });
        throw new Error("inner");
      }),
    );
  });
  expect(seen.phases).toEqual(["start:0", "start:1", "rollback:1", "commit:0"]);
  const unitEvents = seen.events;
  expect(
    unitEvents.some((event) => event.type === "savepoint" && event.state === "rolled_back"),
  ).toBe(true);
  expect(outcomes(unitEvents)[0]?.outcome).toBe("committed");
  expect(outcomes(unitEvents)[0]?.writes).toBe(1);
  expect(writes(unitEvents).map((event) => event.op)).toEqual(["insert"]);

  // failed statement (batch)
  seen.events.length = 0;
  seen.phases.length = 0;
  const bad = recording({ fail: new DriverError("boom", { sqlstate: "23505", batchIndex: 0 }) });
  const failing = createClient(app, bad, {
    ownsPool: false,
    onWrite: seen.onWrite,
    hookm: [seen.hookm],
  });
  await rejection(
    failing.batch([
      failing.notes.delete({ where: { id: "a" } }),
      failing.notes.delete({ where: { id: "b" } }),
    ]),
  );
  expect(seen.phases).toEqual(["start:0", "rollback:0"]);
  expect(outcomes(seen.events)[0]?.outcome).toBe("rolled_back");

  // lost connection at COMMIT
  seen.events.length = 0;
  seen.phases.length = 0;
  const lost = interactive({
    onCommit: () => Promise.reject(new DriverError("connection lost", { sqlstate: "08006" })),
  });
  const lostDb = createClient(app, lost.pool, {
    ownsPool: false,
    onWrite: seen.onWrite,
    hookm: [seen.hookm],
  });
  await lostDb.connected;
  const error = await rejection(
    lostDb.tx(async (tx) => {
      await tx.notes.delete({ where: { id: "z" } });
    }),
  );
  expect(error.code).toBe("OKM1401");
  expect(error.kind).toBe("outcome_unknown");
  expect(seen.phases).toEqual(["start:0"]);
  expect(outcomes(seen.events)[0]?.outcome).toBe("unknown");
});

test("delivery order and tri-state outcome", async () => {
  const seen = collect();
  const { pool } = interactive();
  const db = createClient(app, pool, { ownsPool: false, onWrite: seen.onWrite });
  await db.connected;
  await db.tx(async (tx) => {
    await tx.notes.insert({ id: "a", body: "1" });
    await tx.notes.update({ where: { id: "a" }, set: { body: "2" } });
  });
  const types = seen.events.map((event) => event.type);
  expect(types.at(-1)).toBe("outcome");
  expect(types.slice(0, -1)).toEqual(["write", "write"]);
  expect(writes(seen.events).map((event) => event.seq)).toEqual([0, 1]);
  expect(outcomes(seen.events)[0]).toMatchObject({
    outcome: "committed",
    writes: 2,
  });

  seen.events.length = 0;
  await db.notes.delete({ where: { id: "a" } });
  expect(seen.events.map((event) => event.type)).toEqual(["write", "outcome"]);
  expect(outcomes(seen.events)[0]?.outcome).toBe("committed");
  expect(writes(seen.events)[0]?.rowCount).toBeNull();
  expect(writes(seen.events)[0]?.rowCountMode).toBe("unknown");
  expect(writes(seen.events)[0]?.dialect).toBe("postgres");
});

test("a throwing onWrite never changes the write result", async () => {
  const pool = recording({});
  const db = createClient(app, pool, {
    ownsPool: false,
    onWrite: () => {
      throw new Error("observer boom");
    },
  });
  expect(await Promise.resolve(db.notes.delete({ where: { id: "a" } }))).toEqual({ count: 1 });
});

test("zero cost: no observer builds no event and takes no timestamp", async () => {
  let nowCalls = 0;
  const realNow = Date.now.bind(Date);
  Date.now = (() => {
    nowCalls += 1;
    return realNow();
  }) as typeof Date.now;
  try {
    const bare = createClient(app, recording({}), { ownsPool: false });
    nowCalls = 0;
    await bare.notes.delete({ where: { id: "a" } });
    expect(nowCalls).toBe(0);

    const seen = collect();
    const watched = createClient(app, recording({}), {
      ownsPool: false,
      onWrite: seen.onWrite,
    });
    nowCalls = 0;
    await watched.notes.delete({ where: { id: "b" } });
    expect(nowCalls).toBeGreaterThan(0);
    expect(seen.events.length).toBeGreaterThan(0);
  } finally {
    Date.now = realNow;
  }
});

test("error isolation: throwing and rejecting handlers, flush, and overflow", async () => {
  const observerErrors: unknown[] = [];
  let committed = 0;
  const onWrite = writeObserver({
    maxPending: 3,
    committed: () => {
      committed += 1;
      throw new Error("committed boom");
    },
    onObserverError: (err) => {
      observerErrors.push(err);
    },
    onEvent: (event): void | Promise<void> => {
      if (event.type === "write" && event.seq === 0) {
        return Promise.reject(new Error("reject boom"));
      }
      return undefined;
    },
  });
  const pool = recording({});
  const db = createClient(app, pool, { ownsPool: false, onWrite });
  expect(await Promise.resolve(db.notes.delete({ where: { id: "a" } }))).toEqual({ count: 1 });
  await onWrite.flush();
  expect(committed).toBe(1);
  expect(
    observerErrors.some((err) => err instanceof Error && err.message === "committed boom"),
  ).toBe(true);
  expect(observerErrors.some((err) => err instanceof Error && err.message === "reject boom")).toBe(
    true,
  );

  const overflowErrors: OkmError[] = [];
  const bounded = writeObserver({
    maxPending: 3,
    onObserverError: (err) => {
      if (err instanceof OkmError) overflowErrors.push(err);
    },
  });
  const controller = createObserver(bounded);
  controller.onPhase("start", 0, undefined);
  controller.recordWrites([draft(0), draft(1)]);
  controller.onPhase("start", 0, undefined);
  controller.recordWrites([draft(0), draft(1)]);
  expect(overflowErrors.some((err) => err.code === "OKM2200")).toBe(true);
  expect(observerBufferOverflow().code).toBe("OKM2200");
  expect(OBSERVE_BUFFER_MAX).toBe(10_000);
});

test("writeObserver calls committed, rolledBack, and unknown once per unit", async () => {
  const committed: string[] = [];
  const rolled: string[] = [];
  const unknown: string[] = [];
  const onWrite = writeObserver({
    committed: ({ unit, writes }) => {
      committed.push(`${unit}:${writes.length}`);
    },
    rolledBack: ({ unit }) => {
      rolled.push(unit);
    },
    unknown: ({ unit, writes }) => {
      unknown.push(`${unit}:${writes.length}`);
    },
  });
  const { pool } = interactive();
  const db = createClient(app, pool, { ownsPool: false, onWrite });
  await db.connected;
  await db.tx(async (tx) => {
    await tx.notes.insert({ id: "1", body: "a" });
  });
  expect(committed).toHaveLength(1);
  expect(rolled).toHaveLength(0);

  await rejection(
    db.tx(async (tx) => {
      await tx.notes.delete({ where: { id: "1" } });
      throw new Error("rollback");
    }),
  );
  expect(rolled).toHaveLength(1);

  const lost = interactive({
    onCommit: () => Promise.reject(new DriverError("connection lost", { sqlstate: "08006" })),
  });
  const lostDb = createClient(app, lost.pool, { ownsPool: false, onWrite });
  await lostDb.connected;
  await rejection(
    lostDb.tx(async (tx) => {
      await tx.notes.delete({ where: { id: "z" } });
    }),
  );
  expect(unknown).toHaveLength(1);
  await onWrite.flush();
});

test("no-leak: bound values and hidden/sensitive columns stay out of events", async () => {
  const secretBody = "bound-secret-body-value-9f3a";
  const secretCol = "hidden-sensitive-column-value-7c2b";
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    onEvent: (event) => {
      events.push(event);
    },
  });
  const pool = recording({});
  const db = createClient(secretApp, pool, { ownsPool: false, onWrite });
  await db.secrets.insert({ id: "row-1", body: secretBody, secret: secretCol });
  await onWrite.flush();
  const blob = JSON.stringify(events);
  expect(blob).not.toContain(secretBody);
  expect(blob).not.toContain(secretCol);
  expect(blob).not.toContain("row-1");
  expect(writes(events)[0]?.table).toBe("secrets");
  expect(writes(events)[0]?.tenant).toBeNull();
});

test("no-leak: tenant appears only as scope keys and values", async () => {
  const tenants = table("tenants_notes", {
    id: t.text().primaryKey(),
    body: t.text(),
  });
  const tenantApp = schema({
    casing: "snake",
    tables: [tenants],
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  });
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    onEvent: (event) => {
      events.push(event);
    },
  });
  const pool = recording({});
  const root = createClient(tenantApp, pool, { ownsPool: false, onWrite });
  const db = root.for({ tenantId: TENANT_A });
  await db.tenants_notes.insert({ id: "n1", body: "hello-tenant-body" });
  await onWrite.flush();
  const write = writes(events)[0];
  expect(write?.tenant).toEqual({ tenantId: TENANT_A });
  const blob = JSON.stringify(events);
  expect(blob).not.toContain("hello-tenant-body");
  expect(blob).not.toContain("n1");
  expect(blob).toContain(TENANT_A);
});
