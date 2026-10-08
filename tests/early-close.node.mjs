/**
 * Child process for `early-close.test.ts` (QA-M5), run under Node from `dist/`.
 *
 * Same steps as `early-close.worker.ts`, against the built package.
 * `bun run build` must run first.
 */

import { connect } from "../dist/runtime/pg/postgresjs.js";
import { schema, t, table } from "../dist/dialects/pg/index.js";

const notes = table("notes", { id: t.text().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

const db = connect("postgres://okm:okm@127.0.0.1:1/okm", { schema: app });
await db.close();
await new Promise((resolve) => setTimeout(resolve, 1_000));
try {
  await db.connected;
  console.log("resolved");
} catch (error) {
  const kind = error instanceof Error && "kind" in error ? String(error.kind) : "unknown";
  console.log(`rejected:${kind}:${error instanceof Error ? error.message : String(error)}`);
}
