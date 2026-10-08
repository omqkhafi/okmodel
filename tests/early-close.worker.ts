/**
 * Child process for `early-close.test.ts` (QA-M5), run under Bun from source.
 *
 * Closes the client before it connects, then waits for `connected`. Prints the
 * outcome. The parent checks exit code and stderr.
 */

import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

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
