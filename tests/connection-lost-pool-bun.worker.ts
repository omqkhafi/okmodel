/**
 * Bun.sql idle-kill probe. This file imports `bun`, so it runs under Bun and
 * is not bundled for Node.
 */

import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/bun.js";
import { runPoolKill } from "./connection-lost-pool-run.js";

const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

const url = process.argv[2];
if (url === undefined) {
  console.error("missing database url");
  process.exit(2);
}

await runPoolKill(url, () => connect(url, { schema: app, max: 1 }));
