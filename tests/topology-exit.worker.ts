/**
 * Child process: probe timers are unref'd, so the process exits without `close()`.
 */

import type { DriverPool } from "../src/contracts/driver.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connectTopology } from "../src/runtime/topology.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const db = await connectTopology(
  { primary: "postgres://primary/db", replicas: ["postgres://east/db"] },
  { schema: app, routing: { probe: 20 } },
  () =>
    ({
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
        if (text.includes("has_function_privilege")) {
          return Promise.resolve({ rows: [["f"]], count: 1, notices: [] });
        }
        return Promise.resolve({ rows: [["1", null]], count: 1, notices: [] });
      },
      batch: () => Promise.resolve([]),
      stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
      close: () => Promise.resolve(),
    }) as DriverPool,
);
await db.connected;
