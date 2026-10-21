/**
 * Child process for the zero-cost conformance test (G-8).
 *
 * Usage: `bun tests/observe-zero-cost.worker.ts <driver>`.
 *
 * It runs the same writes, reads, rollbacks, savepoints, and failures twice on
 * a real database: once on a client with no observer, once with both
 * observers. For each run it prints how many clock reads the observer paths
 * made and which observer modules the process had loaded. The first run must
 * read no clock there and load nothing. The second is the control: the same
 * counters move, so the first result is not a blind spot. Only the rig is
 * imported before the first run, because it does not load `okmodel/observe`.
 */

import { schema, t, table } from "../src/dialects/pg/index.js";
import { openRig, type DriverName } from "./observe-conformance-kit.js";

const notes = table("notes", { id: t.integer().primaryKey(), body: t.text() });
const app = schema({ casing: "snake", tables: [notes] });

const driver = process.argv[2] as DriverName | undefined;
if (driver === undefined) {
  console.error("usage: observe-zero-cost.worker.ts <driver>");
  process.exit(2);
}

/** Frames that belong to the observer paths: the write executor and the observe modules. */
const OBSERVER_FRAME = /src\/runtime\/(?:tx|observe[\w-]*)\.ts/;
let reads = 0;
const spy = <T extends (...args: never[]) => number>(real: T): T =>
  function counted(this: unknown, ...args: never[]): number {
    const caller = new Error().stack?.split("\n")[2] ?? "";
    if (OBSERVER_FRAME.test(caller)) reads += 1;
    return real.apply(this, args);
  } as T;
Date.now = spy(Date.now.bind(Date));
performance.now = spy(performance.now.bind(performance));

const rig = await openRig(driver, "create table notes (id int primary key, body text not null);\n");
const loaded = (): string[] =>
  Object.keys(require.cache)
    .filter((path) => /src\/runtime\/observe[\w-]*\.ts/.test(path))
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
    .sort();

async function work(options: Record<string, unknown>, base: number): Promise<void> {
  const db = await rig.connect({ schema: app, max: 2, ...options });
  try {
    await db.notes.insert({ id: base + 1, body: "autocommit" });
    await db.notes.find({ limit: 5 });
    await db.batch([
      db.notes.insert({ id: base + 2, body: "batch" }),
      db.notes.insert({ id: base + 3, body: "batch" }),
    ]);
    await db.tx(async (tx) => {
      await tx.notes.insert({ id: base + 4, body: "committed" });
      await tx
        .tx(async (inner) => {
          await inner.notes.insert({ id: base + 5, body: "savepoint, rolled back" });
          throw new Error("inner");
        })
        .catch(() => undefined);
      await tx.notes.find({ limit: 5 });
    });
    await db
      .tx(async (tx) => {
        await tx.notes.insert({ id: base + 6, body: "rolled back" });
        throw new Error("rollback");
      })
      .catch(() => undefined);
    await db.notes.insert({ id: base + 1, body: "duplicate" }).catch(() => undefined);
    await db.batch([db.notes.insert({ id: base + 1, body: "duplicate" })]).catch(() => undefined);
  } finally {
    await db.close();
  }
}

try {
  reads = 0;
  await work({}, 0);
  const quiet = { reads, loaded: loaded() };

  const { queryObserver, writeObserver } = await import("../src/runtime/observe.js");
  const onWrite = writeObserver({});
  const onQuery = queryObserver({ query: () => undefined });
  reads = 0;
  await work({ onWrite, onQuery }, 100);
  await onWrite.flush();
  await onQuery.flush();
  const watched = { reads, loaded: loaded() };
  console.log(JSON.stringify({ quiet, watched }));
} finally {
  await rig.close();
}
