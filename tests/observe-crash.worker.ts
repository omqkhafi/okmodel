/**
 * Child process for the crash conformance test (G-8).
 *
 * Usage: `bun tests/observe-crash.worker.ts <driver> <url> <mode>`.
 *
 * It writes inside a transaction and prints every observer event as one JSON
 * line (`event ...`) and every milestone as `mark ...`. In `before` it stops
 * inside the transaction. In `after` it stops in `hookm.onTransaction`, which
 * runs after COMMIT is acknowledged and before the observer is called. In
 * `complete` it finishes, so the parent can see that events do arrive when
 * nothing kills the process. The parent kills it with SIGKILL.
 */

import { writeSync } from "node:fs";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { writeObserver } from "../src/runtime/observe.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import type { Connected, TransactionEvent } from "../src/runtime/types.js";

const notes = table("notes", { id: t.integer().primaryKey(), body: t.text() });
const app = schema({ casing: "snake", tables: [notes] });

const [driver, url, mode] = process.argv.slice(2);
if (driver === undefined || url === undefined || mode === undefined) {
  console.error("usage: observe-crash.worker.ts <driver> <url> <mode>");
  process.exit(2);
}

function say(line: string): void {
  writeSync(1, `${line}\n`);
}

/** Blocks the thread, so nothing else in this process runs before the kill. */
function stall(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
}

const connectors = { postgresjs: connectPostgres, pg: connectPg, bun: connectBun } as const;
const open = connectors[driver as keyof typeof connectors] as unknown as
  | ((url: string, options: unknown) => Connected<typeof app, undefined>)
  | undefined;
if (open === undefined) {
  console.error(`unknown driver ${driver}`);
  process.exit(2);
}

const onWrite = writeObserver({
  onEvent: (event) => say(`event ${JSON.stringify(event)}`),
  committed: ({ unit, writes }) =>
    say(`event ${JSON.stringify({ committed: unit, writes: writes.length })}`),
});
const db = open(url, {
  schema: app,
  max: 1,
  onWrite,
  hookm: [
    {
      onTransaction: (event: TransactionEvent) => {
        if (mode === "after" && event.phase === "commit" && event.depth === 0) {
          say("mark committed");
          stall();
        }
      },
    },
  ],
});
await db.connected;
say("mark ready");
await db.tx(async (tx) => {
  await tx.notes.insert({ id: 1, body: "written by the child" });
  say("mark written");
  if (mode === "before") stall();
});
await onWrite.flush();
say("mark done");
await db.close();
