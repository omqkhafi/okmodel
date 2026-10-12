/**
 * A LISTEN connection the server kills must not crash the process.
 *
 * argv: database URL, then `pg` or `postgresjs`.
 */

import postgres from "postgres";

import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";

const url = process.argv[2];
const driver = process.argv[3] ?? "pg";
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
const open = driver === "postgresjs" ? openPostgres : openPg;
const pool = open({ url, max: 1 });
if (pool.listen === undefined) {
  console.log("no listen");
  await admin.end({ timeout: 5 });
  process.exit(2);
}
const stop = await pool.listen("okm_probe", () => undefined);
await killIdle();
await sleep(400);
const again = await caught(() => pool.execute("select 1"));
console.log(again === undefined ? "next ok" : "next failed");
await stop().catch(() => undefined);
await sleep(50);
console.log(`crashes ${String(crashes.length)}`);
await pool.close().catch(() => undefined);
await admin.end({ timeout: 5 });
if (crashes.length > 0 || again !== undefined) process.exit(1);

async function killIdle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await admin<{ pid: string }[]>`
      select pid::text as pid
      from pg_stat_activity
      where application_name = 'okmodel'
        and datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'idle'
    `;
    if (rows.length > 0) {
      for (const row of rows) await admin.unsafe(`select pg_terminate_backend(${row.pid})`);
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
