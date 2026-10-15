/**
 * Kill storm for the postgres.js settle test.
 *
 * The parent test spawns this file. An unhandled rejection from postgres.js
 * `fetchArrayTypes` is recorded and does not fail the process by itself.
 */

import postgres from "postgres";

import type { DriverConnection } from "../src/contracts/driver.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const crashes: string[] = [];

process.on("unhandledRejection", (error: unknown) => {
  const query =
    typeof error === "object" && error !== null ? Reflect.get(error, "query") : undefined;
  const message = error instanceof Error ? error.message : String(error);
  crashes.push(typeof query === "string" ? `${message}\n${query}` : message);
});

const url = primaryUrl();
const pool = open({ url, max: 4 });
const killer = postgres(url, { max: 1, fetch_types: false });
let killing = true;
const kill = (async () => {
  while (killing) {
    await killer
      .unsafe(
        "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'okmodel' and pid <> pg_backend_pid()",
      )
      .catch(() => undefined);
    await Bun.sleep(5);
  }
})();

const timeout = 300;
/**
 * A call that has not settled by this bound counts as hung.
 * The statement timeout stays 300 ms. The extra room is the parallel suite.
 */
const settleBound = 10_000;
const runs = 200;
const inflight = 8;
let settled = 0;
let hung = 0;
let maxMs = 0;

for (let run = 0; run < runs; run += 1) {
  const batch = Array.from({ length: inflight }, async () => {
    const started = Date.now();
    let done = false;
    const watch = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!done) hung += 1;
        resolve();
      }, settleBound);
    });
    const call = (async () => {
      let connection: DriverConnection | undefined;
      try {
        connection = await pool.reserve?.();
        if (connection === undefined) throw new Error("reserve");
        await connection.execute("select pg_sleep(2)", undefined, { timeout });
      } catch {
        // A settled rejection is the point of the storm.
      } finally {
        await connection?.release().catch(() => undefined);
        done = true;
        settled += 1;
        maxMs = Math.max(maxMs, Date.now() - started);
      }
    })();
    await Promise.race([call, watch]);
  });
  await Promise.all(batch);
}

killing = false;
await kill;
await killer.end({ timeout: 1 });
await pool.close().catch(() => undefined);
console.log(JSON.stringify({ settled, hung, maxMs, crashes }));
process.exit(0);
