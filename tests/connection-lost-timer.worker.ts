/**
 * Child process for the postgres.js timer check.
 *
 * A healthy checkout must leave `setImmediate` alone, and a `TypeError` the
 * application throws from that timer must reach `uncaughtException`. The
 * parent suite does not import this file. Bun's test runner would report
 * the timer throw as its own failure.
 */

import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

const url = process.argv[2];
if (url === undefined || url === "") {
  console.error("missing database url");
  process.exit(2);
}

const schedule = globalThis.setImmediate;
const db = connect(url, { schema: app, max: 1 });
await db.tx(async (tx) => {
  await tx.notes.find({ limit: 1 });
});
await db.close();
if (globalThis.setImmediate !== schedule) {
  console.error("setImmediate replaced");
  process.exit(1);
}
console.log("schedule-same");

process.on("uncaughtException", (error) => {
  if (error instanceof TypeError && error.message === "application timer") {
    console.log("uncaught");
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});
globalThis.setImmediate(() => {
  throw new TypeError("application timer");
});
setTimeout(() => {
  process.exit(2);
}, 1_000);
