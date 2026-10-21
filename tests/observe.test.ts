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
import type { ObserveEvent, OutcomeEvent, WriteEvent } from "../src/runtime/observe-types.js";
import type { Hookm } from "../src/runtime/types.js";
import { POSTGRES_FEATURES } from "../src/tooling/capabilities/postgres.js";

const notes = table("notes", { id: t.text().primaryKey(), body: t.text() });
const app = schema({ casing: "snake", tables: [notes] });

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
  expect(POSTGRES_FEATURES["writeObserver.keys"]?.cost).toBe("none");
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
  expect(POSTGRES_FEATURES["writeObserver.rowCount"]?.cost).toBe("unknown");
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
