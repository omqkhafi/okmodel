/**
 * `close()` on the Neon adapter, in both modes.
 *
 * A query that has started when `close()` is called finishes and returns its
 * rows. A call after `close()` is OKM1120, not `unavailable`, and is not
 * retryable. The real driver talks to a local endpoint (`startNeonLocal`).
 */

import { afterAll, beforeAll, expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { open } from "../src/adapters/pg/neon.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/neon.js";
import { startNeonLocal, type NeonLocal } from "../packages/harness/src/neon-local.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const gate = await loadPostgresGate();
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const notes = table(`okm_close_${suffix}`, { id: t.integer().primaryKey() });
const app = schema({ casing: "snake", tables: [notes] });
const MODES = ["websocket", "http"] as const;

let local: NeonLocal | undefined;

beforeAll(async () => {
  if (!gate.run) return;
  local = startNeonLocal(primaryUrl());
  const pool = await open({ url: local.url, max: 1 });
  try {
    await pool.execute(`create table okm_close_${suffix} (id integer primary key)`);
    await pool.execute(`insert into okm_close_${suffix} values (1)`);
  } finally {
    await pool.close();
  }
}, 30_000);

afterAll(async () => {
  if (local === undefined) return;
  const pool = await open({ url: local.url, max: 1 });
  try {
    await pool.execute(`drop table if exists okm_close_${suffix}`);
  } finally {
    await pool.close();
    await local.close();
  }
});

for (const mode of MODES) {
  postgresTest(
    gate,
    `${mode}: a statement running when close() is called returns its rows`,
    async () => {
      const pool = await open({ url: local!.url, mode });
      const running = pool.execute("select pg_sleep(0.3), 'done'");
      await delay(50);
      const order: string[] = [];
      await Promise.all([
        running.then((result) => order.push(`rows ${String(result.rows[0]?.[1])}`)),
        pool.close().then(() => order.push("closed")),
      ]);
      expect(order).toContain("rows done");
      if (mode === "websocket") expect(order).toEqual(["rows done", "closed"]);
    },
    30_000,
  );

  postgresTest(
    gate,
    `${mode}: a find waiting on a lock when db.close() is called returns its rows`,
    async () => {
      const locker = await open({ url: local!.url, max: 1 });
      const held = await locker.reserve!();
      const db = await connect(local!.url, { schema: app, mode });
      try {
        await held.execute("begin");
        await held.execute(`lock table okm_close_${suffix} in access exclusive mode`);
        // `.then` starts the lazy builder before close() runs.
        const found = db[notes.name]!.find({ where: { id: 1 }, limit: 1 }).then((rows) => rows);
        await delay(100);
        const closing = db.close();
        await delay(100);
        await held.execute("commit");
        expect(await found).toEqual([{ id: 1 }]);
        await closing;
      } finally {
        await held.release();
        await locker.close();
      }
    },
    30_000,
  );

  postgresTest(
    gate,
    `${mode}: a call after close() is OKM1120 and not retryable`,
    async () => {
      const pool = await open({ url: local!.url, mode });
      await pool.close();
      expectMisuse(await failure(pool.execute("select 1")));
      expectMisuse(await failure(pool.batch([{ text: "select 1" }])));
      if (pool.reserve !== undefined) expectMisuse(await failure(pool.reserve()));

      const db = await connect(local!.url, { schema: app, mode });
      await db.connected;
      await db.close();
      const error = await failure(db[notes.name]!.find({ limit: 1 }));
      expectMisuse(error);
      if (error instanceof OkmError) {
        expect([error.kind, error.retryable]).toEqual(["invalid", false]);
        expect(error.fix.summary).toContain("close()");
      }
    },
    30_000,
  );
}

function expectMisuse(error: unknown): void {
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.code).toBe("OKM1120");
  expect(error.message).toContain("The client is closed.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}
