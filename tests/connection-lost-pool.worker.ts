/**
 * An idle pooled client that the server kills must not crash the process.
 *
 * The parent bundles this file with `bun build --target node`. `argv` is the
 * database URL, then `postgresjs` or `pg`.
 */

import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { runPoolKill } from "./connection-lost-pool-run.js";

const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

const url = process.argv[2];
const driver = process.argv[3] ?? "pg";
if (url === undefined) {
  console.error("missing database url");
  process.exit(2);
}

const connect = driver === "postgresjs" ? connectPostgres : connectPg;
await runPoolKill(url, () => connect(url, { schema: app, max: 1 }));
