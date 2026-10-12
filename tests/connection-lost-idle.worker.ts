/**
 * Idle connection-loss cases for postgres.js, under Bun and under Node.
 *
 * The parent suite spawns this file. A throw from `socket.write` must not
 * become an uncaught exception.
 */

import postgres from "postgres";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { OkmError } from "../src/contracts/error.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

const url = process.argv[2];
if (url === undefined || url === "") {
  console.error("missing database url");
  process.exit(2);
}

const crashes: unknown[] = [];
process.on("uncaughtException", (error) => {
  crashes.push(error);
});
process.on("unhandledRejection", (error) => {
  crashes.push(error);
});

const admin = postgres(url, { max: 1, onnotice: () => {} });
await admin.unsafe("create table if not exists notes (id int primary key, title text not null)");
await admin.unsafe("delete from notes");
const db = connect(url, { schema: app, max: 1 });

const idle = await caught(() =>
  db.tx(async (tx) => {
    await tx.notes.find({ limit: 1 });
    await killIdle();
    await sleep(400);
    await tx.notes.find({ limit: 1 });
  }),
);
console.log(`idle ${kindOf(idle)}`);

const savepoint = await caught(() =>
  db.tx(async (tx) => {
    await tx.tx(async (inner) => {
      await inner.notes.find({ limit: 1 });
      await killIdle();
      await sleep(400);
      await inner.notes.find({ limit: 1 });
    });
  }),
);
console.log(`savepoint ${kindOf(savepoint)}`);

const commit = await caught(() =>
  db.tx(async (tx) => {
    await tx.notes.insert({ id: 1, title: "x" });
    await killIdle();
    await sleep(400);
  }),
);
console.log(`commit ${codeOf(commit)} ${kindOf(commit)}`);

await db.notes.find({ limit: 1 });
console.log("next ok");
await sleep(50);
console.log(`crashes ${String(crashes.length)}`);
await db.close();
await admin.end({ timeout: 5 });
if (crashes.length > 0) process.exit(1);

async function killIdle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await admin<{ pid: string; state: string }[]>`
      select pid::text as pid, state
      from pg_stat_activity
      where application_name = 'okmodel'
        and datname = current_database()
        and pid <> pg_backend_pid()
    `;
    const match = rows.find((row) => row.state === "idle in transaction");
    if (match !== undefined) {
      await admin.unsafe(`select pg_terminate_backend(${match.pid})`);
      return;
    }
    await sleep(100);
  }
  throw new Error("no idle okmodel backend");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function kindOf(error: unknown): string {
  return error instanceof OkmError ? (error.kind ?? "") : "missing";
}

function codeOf(error: unknown): string {
  return error instanceof OkmError ? error.code : "missing";
}
