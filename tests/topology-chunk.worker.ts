/**
 * Child process: a string or a pool must not import the topology module.
 *
 * `mock.module` replaces the loader for this process only.
 */

import { mock } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { schema, t, table } from "../src/dialects/pg/index.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const pool = {
  capabilities: {
    transactions: "none",
    stream: false,
    listen: false,
    cancel: false,
    prepared: "unnamed",
    describe: false,
  },
  execute: (text: string) => {
    if (text.startsWith("select current_setting")) {
      return Promise.resolve({
        rows: [["170000", "PostgreSQL 17.1", null]],
        count: 1,
        notices: [],
      });
    }
    return Promise.resolve({ rows: [], count: 0, notices: [] });
  },
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

void mock.module("../src/runtime/topology.ts", () => {
  throw new Error("topology loaded");
});

void mock.module("../src/adapters/pg/postgresjs.ts", () => ({
  open: () => pool,
  capabilities: pool.capabilities,
  hasCapability: () => false,
  readCapability: () => undefined,
}));

const { connect: connectPostgres } = await import("../src/runtime/pg/postgresjs.js");
const { connect: connectPglite } = await import("../src/runtime/pg/pglite.js");
const { connect: connectPg } = await import("../src/runtime/pg/pg.js");
const { connect: connectBun } = await import("../src/runtime/pg/bun.js");

const stringClient = connectPostgres("postgres://localhost/app", { schema: app });
await stringClient.connected;
await stringClient.close();

const postgresPool = connectPostgres(pool, { schema: app });
await postgresPool.connected;
await postgresPool.close();
const pgPool = connectPg(pool, { schema: app });
await pgPool.connected;
await pgPool.close();
const bunPool = connectBun(pool, { schema: app });
await bunPool.connected;
await bunPool.close();

const memory = await connectPglite(undefined, { schema: app });
await memory.connected;
await memory.close();

const pooled = await connectPglite(pool, { schema: app });
await pooled.connected;
await pooled.close();

let loaded = false;
try {
  await connectPostgres({ primary: "postgres://localhost/primary", replicas: [] }, { schema: app });
} catch (error) {
  loaded = error instanceof Error && error.message.includes("topology loaded");
}
if (!loaded) throw new Error("topology connect did not load the chunk");
