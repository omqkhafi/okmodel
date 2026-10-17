/**
 * Child process for the node-postgres idle-kill check (B-44).
 *
 * Query once, kill every idle okmodel backend, wait, query again. An uncaught
 * `error` from an idle client must not crash the process.
 */

import { open } from "../src/adapters/pg/nodepostgres.js";
import postgres from "postgres";

const crashes: string[] = [];
process.on("uncaughtException", (error: unknown) => {
  crashes.push(error instanceof Error ? error.message : String(error));
});
process.on("unhandledRejection", (error: unknown) => {
  crashes.push(error instanceof Error ? error.message : String(error));
});

const url = process.argv[2];
if (url === undefined || url === "") {
  console.error("missing database url");
  process.exit(2);
}

const pool = open({ url, max: 2 });
const admin = postgres(url, { max: 1, fetch_types: false });
try {
  await pool.execute("select 1");
  await new Promise((r) => setTimeout(r, 50));
  const rows = await admin.unsafe<{ pid: number }[]>(
    "select pid from pg_stat_activity where application_name = 'okmodel' and state = 'idle' and pid <> pg_backend_pid()",
  );
  for (const row of rows) {
    await admin.unsafe(`select pg_terminate_backend(${String(row.pid)})`);
  }
  await new Promise((r) => setTimeout(r, 100));
  await pool.execute("select 1").catch(() => undefined);
  await pool.execute("select 1");
  console.log("idle-ok");
  console.log(`crashes ${String(crashes.length)}`);
  if (crashes.length > 0) {
    for (const crash of crashes) console.error(crash);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await admin.end({ timeout: 1 }).catch(() => undefined);
  await pool.close().catch(() => undefined);
}
