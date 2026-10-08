/**
 * Replica read fallback when the replica is unreachable (QA-M1).
 *
 * A stand-in `open` lets each test choose the error a replica read throws.
 * `tests/replica-unreachable-pg.test.ts` runs the same path on real drivers.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connectTopology, type RouteEvent } from "../src/runtime/topology.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const refused = (): Error =>
  Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

/** A replica read that throws `error`. Probes and the primary succeed. */
function fallbackCase(error: () => unknown): Promise<{ events: RouteEvent[]; rows: unknown }> {
  const events: RouteEvent[] = [];
  return connectTopology(
    { primary: "postgres://primary/db", replicas: ["postgres://replica/db"] },
    { schema: app, routing: { probe: 60_000 }, onRoute: (event: RouteEvent) => events.push(event) },
    (config) => poolFor(config.url, error),
  ).then(async (db) => {
    await db.connected;
    const rows = await db.notes.find({ limit: 1 });
    await db.close();
    return { events, rows };
  });
}

function poolFor(url: string, failRead: () => unknown): DriverPool {
  const replica = url.startsWith("postgres://replica");
  return {
    capabilities: {
      transactions: "none",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    execute(text) {
      if (text.startsWith("select current_setting")) {
        return Promise.resolve({
          rows: [["170000", "PostgreSQL 17.1", null]],
          count: 1,
          notices: [],
        });
      }
      if (text.includes("has_function_privilege")) {
        return Promise.resolve({ rows: [["t"]], count: 1, notices: [] });
      }
      if (text.includes("pg_last_wal_replay_lsn")) {
        return Promise.resolve({ rows: [["1", "0/16B3748"]], count: 1, notices: [] });
      }
      if (replica && text.includes("notes")) return Promise.reject(failRead());
      return Promise.resolve({ rows: [], count: 0, notices: [] });
    },
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

/** Wraps `cause` in `levels` plain errors. */
function wrapped(cause: unknown, levels: number): unknown {
  let error = cause;
  for (let level = 0; level < levels; level += 1) error = new Error("wrapper", { cause: error });
  return error;
}

test.each([
  ["a cause chain with ECONNREFUSED", () => new Error("query failed", { cause: refused() })],
  ["an AggregateError with an empty message", () => new AggregateError([refused()], "")],
  [
    "a Bun.sql connection code",
    () => Object.assign(new Error("Connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" }),
  ],
  [
    "a Bun.sql idle timeout",
    () => Object.assign(new Error("idle"), { code: "ERR_POSTGRES_IDLE_TIMEOUT" }),
  ],
  [
    "a nested errno",
    () => new Error("connect", { cause: Object.assign(new Error("x"), { errno: "ENETUNREACH" }) }),
  ],
  [
    "a connection SQLSTATE class 08",
    () => Object.assign(new Error("connection lost"), { code: "08006" }),
  ],
  ["a depth of 3 wrappers", () => wrapped(refused(), 3)],
])("a replica read that fails on %s falls back to the primary", async (_name, error) => {
  const { events, rows } = await fallbackCase(error);
  expect(rows).toEqual([]);
  expect(events.at(-1)).toEqual({
    op: "read",
    endpoint: "primary",
    reason: "fallback:unhealthy",
  });
});

test("a cycle with no connection code is not a fallback and reaches the caller", async () => {
  const cycle: Record<string, unknown> = { message: "loop" };
  cycle.cause = cycle;
  await expectRejected(() => fallbackCase(() => cycle));
});

test("a chain past the walk depth is not a fallback", async () => {
  await expectRejected(() => fallbackCase(() => wrapped(refused(), 10)));
});

test("a non-connection SQLSTATE is not a fallback", async () => {
  await expectRejected(() =>
    fallbackCase(() => Object.assign(new Error("syntax"), { code: "42601" })),
  );
});

async function expectRejected(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}
