/**
 * Child process for a missing validation engine.
 *
 * `mock.module` replaces the loader for this process only.
 */

import { mock } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { v } from "../src/runtime/validate/index.js";

void v;
void mock.module("../src/runtime/validate/engine.ts", () => {
  throw new Error("missing validation engine");
});

const app = schema({
  tables: [table("tasks", { id: text().primaryKey(), title: text() })],
  validation: true,
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

const failed = await Promise.resolve(db.tasks.insert({ id: "a", title: "ship" })).then(
  () => false,
  (error: unknown) => error instanceof Error && error.message.includes("missing validation engine"),
);

if (!failed || seen.length !== 0) {
  throw new Error(
    `engine failure did not stop the call (failed ${String(failed)}, queries ${String(seen.length)})`,
  );
}

await db.close();
