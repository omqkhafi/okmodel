/**
 * `db.close()` before the Neon startup check settles, in both modes.
 *
 * QA repro on real Neon (0.10.3): a call made after `close()` resolved was
 * `unavailable` when the check had not settled. It is OKM1120, `invalid`, and
 * not retryable either way. A query that was not sent before `close()` stays
 * refused. `connected` keeps its documented rejection when the check itself
 * fails. The slow check holds a lock on the catalog table the check reads.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import type { DriverConnection, DriverPool } from "../src/contracts/driver.js";
import { open } from "../src/adapters/pg/neon.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/neon.js";
import { startNeonLocal, type NeonLocal } from "../packages/harness/src/neon-local.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const gate = await loadPostgresGate();
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const links = table(`okm_early_${suffix}`, { id: t.integer().primaryKey() });
const app = schema({ casing: "snake", tables: [links] });
const namespace = `okm_early_ns_${suffix}`;
const MODES = ["websocket", "http"] as const;

let local: NeonLocal | undefined;
let admin: DriverPool | undefined;
let catalogDir = "";

beforeAll(async () => {
  if (!gate.run) return;
  local = startNeonLocal(primaryUrl());
  admin = await open({ url: local.url, max: 2 });
  await admin.execute(`create table okm_early_${suffix} (id integer primary key)`);
  await admin.execute(`insert into okm_early_${suffix} values (1)`);
  await admin.execute(`create schema ${namespace}`);
  await admin.execute(
    `create table ${namespace}.okm_meta (id text primary key, catalog_hash text)`,
  );
  catalogDir = mkdtempSync(join(tmpdir(), "okm-early-"));
  writeFileSync(join(catalogDir, "namespace"), namespace);
}, 30_000);

afterAll(async () => {
  if (local === undefined) return;
  try {
    await admin?.execute(`drop table if exists okm_early_${suffix}`);
    await admin?.execute(`drop schema if exists ${namespace} cascade`);
  } finally {
    rmSync(catalogDir, { recursive: true, force: true });
    await admin?.close();
    await local.close();
  }
});

for (const mode of MODES) {
  for (const slow of [false, true]) {
    const check = slow ? "a slow startup check" : "the startup check";
    const options = slow ? { schema: app, mode, catalogDir } : { schema: app, mode };

    postgresTest(
      gate,
      `${mode}: close() before ${check} settles, then a call after close() is OKM1120`,
      async () => {
        await held(slow, async (release) => {
          const db = await connect(local!.url, options);
          const closing = db.close();
          release();
          await closing;
          await db.connected;
          expectClosed(await failure(db[links.name]!.aggregate({ count: true })));
          expectClosed(await failure(db[links.name]!.find({ limit: 1 })));
        });
      },
      30_000,
    );

    postgresTest(
      gate,
      `${mode}: a query awaited in the tick of close() is refused while ${check} runs`,
      async () => {
        await held(slow, async (release) => {
          const db = await connect(local!.url, options);
          const awaited = db[links.name]!.aggregate({ count: true }).then((rows) => rows);
          const closing = db.close();
          release();
          expectClosed(await failure(awaited));
          await closing;
        });
      },
      30_000,
    );

    postgresTest(
      gate,
      `${mode}: a query not awaited when close() runs is refused (${check})`,
      async () => {
        await held(slow, async (release) => {
          const db = await connect(local!.url, options);
          const query = db[links.name]!.aggregate({ count: true });
          const closing = db.close();
          release();
          await delay(slow ? 50 : 0);
          expectClosed(await failure(query));
          await closing;
        });
      },
      30_000,
    );
  }

  postgresTest(
    gate,
    `${mode}: after await connected, a query awaited in the tick of close() is refused`,
    async () => {
      const db = await connect(local!.url, { schema: app, mode });
      await db.connected;
      const awaited = db[links.name]!.aggregate({ count: true }).then((rows) => rows);
      const closing = db.close();
      expectClosed(await failure(awaited));
      await closing;
    },
    30_000,
  );

  postgresTest(
    gate,
    `${mode}: a query awaited before close() returns rows once it was sent`,
    async () => {
      const db = await connect(local!.url, { schema: app, mode });
      await db.connected;
      const awaited = db[links.name]!.aggregate({ count: true }).then((rows) => rows);
      await delay(20);
      const closing = db.close();
      expect(await awaited).toEqual([{ count: 1 }]);
      await closing;
    },
    30_000,
  );

  postgresTest(
    gate,
    `${mode}: connected keeps its message when the check fails and close() ran first`,
    async () => {
      const db = await connect(local!.url, {
        schema: app,
        mode,
        catalogDir,
        requireMeta: true,
      });
      await db.close();
      const error = await failure(db.connected);
      expect(error).toBeInstanceOf(OkmError);
      if (!(error instanceof OkmError)) return;
      expect(error.message).toBe(
        "The client was closed before it connected. Await connected before close(), or do not close it before use.",
      );
    },
    30_000,
  );
}

/**
 * Runs `body` with the catalog table locked when `slow`, so the startup check
 * waits until `release` runs. The lock is always dropped at the end.
 */
async function held(slow: boolean, body: (release: () => void) => Promise<void>): Promise<void> {
  if (!slow) return body(() => undefined);
  const locker: DriverConnection = await admin!.reserve!();
  await locker.execute("begin");
  await locker.execute(`lock table ${namespace}.okm_meta in access exclusive mode`);
  let done: Promise<unknown> | undefined;
  const release = (): void => {
    done ??= delay(100).then(() => locker.execute("commit"));
  };
  try {
    await body(release);
  } finally {
    release();
    await done;
    await locker.release();
  }
}

function expectClosed(error: unknown): void {
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect([error.code, error.kind, error.retryable]).toEqual(["OKM1120", "invalid", false]);
  expect(error.message).toContain("this call was not sent");
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
