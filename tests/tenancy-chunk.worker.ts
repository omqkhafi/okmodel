/**
 * Child process for the missing-chunk test.
 *
 * `mock.module` replaces the loader for this process only. The parent suite
 * does not import this file.
 */

import { mock } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { app, TASK, TENANT_A } from "./tenancy-schema.js";

void mock.module("../src/runtime/include.ts", () => {
  throw new Error("missing lazy chunk");
});

void mock.module("../src/runtime/write.ts", () => {
  throw new Error("missing lazy chunk");
});

const seen: string[] = [];
const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
    prepared: "unnamed",
    describe: false,
  },
  execute: (text: string) => {
    seen.push(text);
    return Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] });
  },
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

const db = connect(pool, { schema: app });
await db.connected;
seen.length = 0;
const scoped = db.for({ tenantId: TENANT_A });

const includeFailed = await Promise.resolve(
  scoped.tasks.find({ where: { id: TASK }, limit: 1, include: { org: true } }).sql(),
).then(
  () => false,
  (error: unknown) => error instanceof Error && error.message.includes("missing lazy chunk"),
);
const writeFailed = await Promise.resolve(
  scoped.tasks.insert({ id: TASK, title: "ship", code: "a", orgId: TASK }).sql(),
).then(
  () => false,
  (error: unknown) => error instanceof Error && error.message.includes("missing lazy chunk"),
);

if (!includeFailed || !writeFailed || seen.length !== 0) {
  throw new Error(
    `chunk failure did not stop the call (include ${String(includeFailed)}, write ${String(writeFailed)}, queries ${String(seen.length)})`,
  );
}

await db.close();
