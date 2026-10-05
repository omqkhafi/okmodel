/**
 * Transactions, batch, and call options against a recording pool.
 *
 * Real Postgres cases (races, locks, cut commits) are in `tx-suite.test.ts`.
 */

import { expect, test } from "bun:test";

import { DriverError } from "../src/adapters/error.js";
import { POSTGRESJS_CAPABILITIES } from "../src/adapters/capabilities.js";
import type { DriverPool, ExecuteOptions, ExecuteResult } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import type { Hookm } from "../src/runtime/types.js";

const notes = table("notes", { id: t.text().primaryKey(), body: t.text() });
const app = schema({ casing: "snake", tables: [notes] });

const VERSION: ExecuteResult = {
  rows: [["170000", "PostgreSQL 17.0", null]],
  count: 1,
  notices: [],
};
const ONE: ExecuteResult = { rows: [], count: 1, notices: [] };

type Call = { readonly text: string; readonly options: ExecuteOptions | undefined };

/** A pool that answers the connect check, then returns `ONE` and records every call. */
function recording(options: {
  readonly transactions?: "interactive" | "batch";
  readonly fail?: unknown;
}): { readonly pool: DriverPool; readonly executes: Call[]; readonly batches: Call[][] } {
  const executes: Call[] = [];
  const batches: Call[][] = [];
  let checked = false;
  const pool: DriverPool = {
    capabilities: {
      ...POSTGRESJS_CAPABILITIES,
      transactions: options.transactions ?? "batch",
    },
    execute(text, _params, callOptions) {
      if (!checked) {
        checked = true;
        return Promise.resolve(VERSION);
      }
      executes.push({ text, options: callOptions });
      return Promise.resolve(ONE);
    },
    batch(statements, callOptions) {
      batches.push(statements.map((statement) => ({ text: statement.text, options: callOptions })));
      if (options.fail !== undefined) return Promise.reject(options.fail);
      return Promise.resolve(statements.map(() => ONE));
    },
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
  return { pool, executes, batches };
}

async function rejection(promise: Promise<unknown>): Promise<OkmError> {
  try {
    await promise;
  } catch (error) {
    return error as OkmError;
  }
  throw new Error("expected a rejection");
}

test("tx on a driver without interactive transactions is OKM1111 and names the flag", async () => {
  const { pool } = recording({ transactions: "batch" });
  const db = createClient(app, pool, { ownsPool: false });
  const error = await rejection(db.tx(async () => 1));
  expect(error).toBeInstanceOf(OkmError);
  expect(error.code).toBe("OKM1111");
  expect(error.message).toContain('transactions: "interactive"');
});

test("tx refuses a callback it cannot call and options it does not know", async () => {
  const { pool } = recording({ transactions: "interactive" });
  const db = createClient(app, pool, { ownsPool: false });
  const none = await rejection((db.tx as (...args: unknown[]) => Promise<unknown>)({}));
  expect(none.code).toBe("OKM1121");
  const unknown = await rejection(
    (db.tx as (...args: unknown[]) => Promise<unknown>)({ retries: 1 }, async () => 1),
  );
  expect(unknown.code).toBe("OKM1120");
  const isolation = await rejection(
    (db.tx as (...args: unknown[]) => Promise<unknown>)({ isolation: "snapshot" }, async () => 1),
  );
  expect(isolation.code).toBe("OKM1120");
  const retry = await rejection(db.tx({ retry: -1 }, async () => 1));
  expect(retry.code).toBe("OKM1121");
  const timeout = await rejection(db.tx({ timeout: 0 }, async () => 1));
  expect(timeout.code).toBe("OKM1121");
});

test("batch runs the statements of every write as one atomic unit, in order", async () => {
  const { pool, batches, executes } = recording({});
  const db = createClient(app, pool, { ownsPool: false });
  const results = await db.batch([
    db.notes.update({ where: { id: "a" }, set: { body: "x" } }),
    db.notes.delete({ where: { id: "b" } }),
  ]);
  expect(results).toEqual([{ count: 1 }, { count: 1 }]);
  expect(batches).toHaveLength(1);
  expect(batches[0]?.map((call) => call.text.split(" ")[0])).toEqual(["update", "delete"]);
  expect(executes).toHaveLength(0);
});

test("batch with one write still uses the atomic path, so a failure carries batchIndex", async () => {
  const failure = new DriverError("duplicate", { sqlstate: "23505", batchIndex: 0 });
  const { pool, batches } = recording({ fail: failure });
  const db = createClient(app, pool, { ownsPool: false });
  const error = await rejection(db.batch([db.notes.delete({ where: { id: "a" } })]));
  expect(batches).toHaveLength(1);
  expect(error.batchIndex).toBe(0);
  expect(error.kind).toBe("unique");
});

test("batch refuses .replica() with OKM1840 and anything but a write with OKM1121", async () => {
  const { pool, batches } = recording({});
  const db = createClient(app, pool, { ownsPool: false });
  const ops = [db.notes.delete({ where: { id: "a" } })];
  const replica = await rejection(
    (db.batch(ops) as unknown as { replica(): Promise<unknown> }).replica(),
  );
  expect(replica.code).toBe("OKM1840");
  const notAList = await rejection(
    (db.batch as (...args: unknown[]) => Promise<unknown>)(db.notes.delete({ where: { id: "a" } })),
  );
  expect(notAList.code).toBe("OKM1121");
  const read = await rejection(
    (db.batch as (...args: unknown[]) => Promise<unknown>)([db.notes.find({ limit: 1 })]),
  );
  expect(read.code).toBe("OKM1121");
  expect(batches).toHaveLength(0);
});

test("a batch is a transaction to hookm.onTransaction, committed or rolled back", async () => {
  const seen: string[] = [];
  const hookm: Hookm = { onTransaction: (event) => seen.push(`${event.phase}:${event.depth}`) };
  const ok = recording({});
  const db = createClient(app, ok.pool, { ownsPool: false, hookm: [hookm] });
  await db.batch([
    db.notes.delete({ where: { id: "a" } }),
    db.notes.delete({ where: { id: "b" } }),
  ]);
  expect(seen).toEqual(["start:0", "commit:0"]);

  seen.length = 0;
  const bad = recording({ fail: new DriverError("boom", { sqlstate: "23505", batchIndex: 1 }) });
  const failing = createClient(app, bad.pool, { ownsPool: false, hookm: [hookm] });
  await rejection(
    failing.batch([
      failing.notes.delete({ where: { id: "a" } }),
      failing.notes.delete({ where: { id: "b" } }),
    ]),
  );
  expect(seen).toEqual(["start:0", "rollback:0"]);
});

test("signal and timeout reach the driver on every read, and timeouts.statement is the default", async () => {
  const { pool, executes } = recording({});
  const controller = new AbortController();
  const db = createClient(app, pool, { ownsPool: false, timeouts: { statement: 250 } });
  await db.notes.find({ limit: 1 });
  await db.notes.find({ limit: 1, timeout: 50, signal: controller.signal });
  await db.notes.count({ timeout: 70 });
  await db.notes.exists({ signal: controller.signal });
  await db.notes.delete({ where: { id: "a" } });
  await db.notes.delete({ where: { id: "a" } }, { timeout: 90 });
  expect(executes.map((call) => call.options?.timeout)).toEqual([250, 50, 70, 250, 250, 90]);
  expect(executes[1]?.options?.signal).toBe(controller.signal);
  expect(executes[3]?.options?.signal).toBe(controller.signal);
  expect(executes[0]?.options?.signal).toBeUndefined();
});

test("a signal and a timeout never change the statement text", async () => {
  const { pool, executes } = recording({});
  const db = createClient(app, pool, { ownsPool: false });
  await db.notes.find({ limit: 1 });
  await db.notes.find({ limit: 1, timeout: 50, signal: new AbortController().signal });
  expect(executes[0]?.text).toBe(executes[1]?.text);
});

test("a row lock outside tx is OKM1830 before any statement is sent", async () => {
  const { pool, executes } = recording({});
  const db = createClient(app, pool, { ownsPool: false });
  const error = await rejection(
    (db.notes.find as (...args: unknown[]) => Promise<unknown>)({ limit: 1, lock: "update" }),
  );
  expect(error.code).toBe("OKM1830");
  expect(executes).toHaveLength(0);
});
