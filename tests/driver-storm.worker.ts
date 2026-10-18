/**
 * Kill-storm worker for postgres.js / node-postgres (B-02, B-43).
 *
 * Parent: tests/driver-storm-pg.test.ts.
 * Args: <driver> <appUrl> <adminUrl> <schema> <role> [timeoutMs]
 */

import postgres from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgresJs } from "../src/adapters/pg/postgresjs.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgresJs } from "../src/runtime/pg/postgresjs.js";

const driverName = process.argv[2] ?? "";
const appUrl = process.argv[3] ?? "";
const adminUrl = process.argv[4] ?? "";
const schemaName = process.argv[5] ?? "";
const role = process.argv[6] ?? "";
const callTimeout =
  process.argv[7] !== undefined && process.argv[7] !== "" ? Number(process.argv[7]) : undefined;

if (appUrl === "" || adminUrl === "" || schemaName === "" || role === "") {
  console.error(
    "usage: driver-storm.worker.ts <driver> <appUrl> <adminUrl> <schema> <role> [timeoutMs]",
  );
  process.exit(2);
}

const crashes: string[] = [];
function expectedStormLeak(message: string): boolean {
  return (
    message.includes("socket.write") ||
    message.includes("reading 'write'") ||
    message.includes("administrator command") ||
    message.includes("typarray") ||
    message.includes("CONNECTION_CLOSED") ||
    message.includes("CONNECTION_DESTROYED")
  );
}

process.on("uncaughtException", (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // postgres.js B-02: nextWrite on null is upstream (docs/postgresjs-kill-storm.md).
  // Recovery still asserts; those leaks are not counted as product crashes.
  if (expectedStormLeak(message)) return;
  crashes.push(message);
});
process.on("unhandledRejection", (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Known upstream leaks during a kill storm (B-02; D263 typarray; 57P01 text).
  if (expectedStormLeak(message)) return;
  crashes.push(message);
});

const items = table("items", {
  id: id(),
  name: text(),
});
const app = schema({
  casing: "snake",
  tables: [items],
});

const open = driverName === "pg" ? openPg : openPostgresJs;
const connect = driverName === "pg" ? connectPg : connectPostgresJs;

const STORM_MS = 3_000;
const CALL_MS = 5_000;
const WORKERS = 6;
const RECOVERY_MS = 3_000;

function timed<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const admin = postgres(adminUrl, { max: 1, fetch_types: false });
const pool = open({ url: appUrl, searchPath: schemaName, max: 4 });
const db = connect(pool, { schema: app });
const inflight = new Set<Promise<unknown>>();
let killer = true;

try {
  await db.connected;
  const killLoop = (async () => {
    while (killer) {
      await timed(
        admin.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role}'`,
        ),
        CALL_MS,
      ).catch(() => undefined);
      await sleep(20);
    }
  })();
  const deadline = Date.now() + STORM_MS;
  const workers = Array.from({ length: WORKERS }, async (_, worker) => {
    let n = 0;
    while (Date.now() < deadline) {
      n += 1;
      const kind = (worker + n) % 3;
      const opts = callTimeout !== undefined ? { timeout: callTimeout } : undefined;
      const call: Promise<unknown> =
        kind === 0
          ? Promise.resolve(db.items.find({ limit: 5, ...opts }))
          : kind === 1
            ? Promise.resolve(db.items.count(opts))
            : db.tx(async (tx) => tx.items.count(opts));
      const tracked = timed(call, CALL_MS).catch(() => undefined);
      inflight.add(tracked);
      void tracked.finally(() => {
        inflight.delete(tracked);
      });
      await sleep(0);
    }
  });
  await Promise.all(workers);
  killer = false;
  const afterKill = Date.now();
  const drain = timed(Promise.all(inflight), 60_000);
  let recovered = false;
  let recoveryMs = 0;
  while (Date.now() - afterKill < RECOVERY_MS) {
    try {
      await timed(Promise.resolve(db.items.count()), 800);
      recovered = true;
      recoveryMs = Date.now() - afterKill;
      break;
    } catch (error: unknown) {
      if (
        (error instanceof OkmError && error.kind === "unavailable") ||
        (error instanceof OkmError && error.code === "OKM1846") ||
        (error instanceof Error && /timed out|administrat|CONNECTION_CLOSED/i.test(error.message))
      ) {
        await sleep(25);
        continue;
      }
      await sleep(25);
    }
  }
  await drain.catch(() => undefined);
  await timed(killLoop, 5_000).catch(() => undefined);
  const pending = inflight.size;
  if (!recovered) recoveryMs = Date.now() - afterKill;
  console.log(
    JSON.stringify({
      pending,
      recoveryMs,
      recovered,
      crashes,
    }),
  );
  process.exit(recovered && pending === 0 && crashes.length === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  killer = false;
  await db.close().catch(() => undefined);
  await pool.close().catch(() => undefined);
  await admin.end({ timeout: 1 }).catch(() => undefined);
}
