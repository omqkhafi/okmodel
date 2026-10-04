/**
 * Child process for the missing-chunk test of `page` and `aggregate`.
 *
 * `mock.module` replaces the loader for this process only. The parent suite
 * does not import this file.
 */

import { mock } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { app, TENANT_A } from "./relations-schema.js";

for (const chunk of ["page", "aggregate"]) {
  void mock.module(`../src/runtime/${chunk}.ts`, () => {
    throw new Error("missing lazy chunk");
  });
}

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

const failed = (pending: PromiseLike<unknown>): Promise<boolean> =>
  Promise.resolve(pending).then(
    () => false,
    (error: unknown) => error instanceof Error && error.message.includes("missing lazy chunk"),
  );

const results = {
  page: await failed(scoped.tasks.page({ limit: 2 })),
  aggregate: await failed(Promise.resolve(scoped.tasks.aggregate({ count: true }).sql())),
};

if (Object.values(results).includes(false) || seen.length !== 0) {
  throw new Error(
    `chunk failure did not stop the call (${JSON.stringify(results)}, queries ${String(seen.length)})`,
  );
}

await db.close();
