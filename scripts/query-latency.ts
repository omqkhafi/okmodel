/**
 * Times the first `find` (planning) and the first `include` (dynamic import plus planning).
 *
 * The size check prints these next to cold import. They are not a gate.
 * The schema is built before the timers, so catalog work is not in the sample.
 */

import type { DriverPool } from "../src/contracts/driver.js";
import { id, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";

const users = table("users", {
  id: id(),
  email: text(),
});

const tasks = table(
  "tasks",
  {
    id: id(),
    ownerId: uuid().references("users"),
    title: text(),
  },
  { relations: { owner: one("users", "ownerId") } },
);

const app = schema({ tables: [users, tasks] });

const pool: DriverPool = {
  capabilities: {
    transactions: "batch",
    stream: false,
    listen: false,
    cancel: false,
    prepared: "none",
    describe: false,
  },
  execute: () =>
    Promise.resolve({
      rows: [["170000", "PostgreSQL 17"]],
      count: 1,
      notices: [],
    }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 0, idle: 0, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
};

const db = createClient(app, pool, { ownsPool: false });

const findStarted = performance.now();
const found = db.tasks.find({ where: { title: "ship" }, limit: 1 }).sql();
const findMs = performance.now() - findStarted;
if (!("text" in found) || found.text.length === 0) {
  throw new Error("first find did not plan a statement");
}

const includeStarted = performance.now();
const included = await db.tasks
  .find({
    where: { title: "ship" },
    limit: 1,
    include: { owner: { select: ["email"] as const } },
  })
  .sql();
const includeMs = performance.now() - includeStarted;
if (!("text" in included) || included.text.length === 0) {
  throw new Error("first include did not plan a statement");
}

console.log(`query-latency: first find ${findMs.toFixed(3)} ms`);
console.log(`query-latency: first include ${includeMs.toFixed(3)} ms`);
