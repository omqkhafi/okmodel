/**
 * One feed consumer process. The parent kills it to prove the standby.
 *
 * Arguments: database URL, log path. Each delivered key is one line:
 * `pid<TAB>id<TAB>op`.
 */

import { appendFileSync } from "node:fs";

import { schema, table, t } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const url = process.argv[2];
const log = process.argv[3];
if (url === undefined || log === undefined)
  throw new Error("feed lease worker needs a url and a log");

const products = table(
  "products",
  { id: t.integer().primaryKey() },
  { watch: { feed: { keep: "1d" } } },
);
const app = schema({ casing: "snake", tables: [products] });

const db = connect(url, { schema: app, max: 4 });
const sub = db.products.watch({ feed: "search", every: "1s" }, (changes) => {
  const lines = changes.map(
    (change) => `${String(process.pid)}\t${String(change.key.id)}\t${change.op}`,
  );
  if (lines.length > 0) appendFileSync(log, `${lines.join("\n")}\n`);
});
await sub.run();
setInterval(() => undefined, 60_000);
