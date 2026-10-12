/**
 * Query once, kill every idle okmodel backend, and query again.
 *
 * The caller installs nothing. This module counts uncaught exceptions and
 * unhandled rejections, then prints `next ok` and `crashes N`.
 */

import postgres from "postgres";

import { OkmError } from "../src/contracts/error.js";

/** A connected schema with one table query and a close. */
export interface PoolProbe {
  readonly notes: {
    find(options?: { limit?: number }): Promise<unknown>;
  };
  close(): Promise<void>;
}

/**
 * Runs the idle-kill probe and exits the process.
 *
 * @param url - Admin connection. It must not use the okmodel application name.
 * @param open - Opens the driver under test. `connect` returns the client directly.
 */
export async function runPoolKill(
  url: string,
  open: () => PoolProbe | Promise<PoolProbe>,
): Promise<void> {
  if (url === "") {
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
  const db = await open();

  const first = await caught(() => db.notes.find({ limit: 1 }));
  if (first !== undefined) {
    console.log(`first ${kindOf(first)}`);
    console.log(`crashes ${String(crashes.length)}`);
    await finish(db, admin);
    process.exit(1);
  }

  await killIdle(admin);
  await sleep(400);
  const again = await caught(() => db.notes.find({ limit: 1 }));
  console.log(again === undefined ? "next ok" : `next ${kindOf(again)}`);
  await sleep(50);
  console.log(`crashes ${String(crashes.length)}`);
  await finish(db, admin);
  if (crashes.length > 0 || again !== undefined) process.exit(1);
}

async function killIdle(admin: ReturnType<typeof postgres>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await admin<{ pid: string; state: string }[]>`
      select pid::text as pid, state
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

async function finish(
  db: { close(): Promise<void> },
  admin: { end(options: { timeout: number }): Promise<unknown> },
): Promise<void> {
  await db.close().catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
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
  return error instanceof OkmError ? (error.kind ?? error.code) : "missing";
}
