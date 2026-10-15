/**
 * A backend killed during `.stream()` must not fail the next query.
 *
 * Forty runs, one connection. The stream's connection is evicted, and a parked
 * handle that reports closed is not reused.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { integer, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { openPostgres, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";

const gate = await loadPostgresGate();
const notes = table("notes", { id: integer().primaryKey(), title: text() });
const app = schema({ tables: [notes] });

postgresTest(
  gate,
  "bun.sql stays usable after a stream's backend is killed",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe("create table notes (id integer primary key, title text not null)");
      const admin = openPostgres(primaryUrl());
      const db = connectBun(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.notes.insert([
          { id: 1, title: "a" },
          { id: 2, title: "b" },
        ]);
        for (let run = 0; run < 40; run += 1) {
          const stream = db.notes
            .find({ orderBy: { id: "asc" }, limit: 10 })
            .stream({ batch: 1 })
            [Symbol.asyncIterator]();
          const first = await stream.next();
          expect(first.done).toBe(false);
          const pid = await killIdle(admin);
          await stream.return?.(undefined);
          await waitUntilGone(admin, pid);
          const rows = await db.notes.find({ orderBy: { id: "asc" }, limit: 5 });
          expect(rows.map((row) => row.id)).toEqual([1, 2]);
        }
      } finally {
        await db.close();
        await admin.end({ timeout: 5 });
      }
    });
  },
  120_000,
);

async function killIdle(admin: Sql): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await admin<{ pid: string }[]>`
      select pid::text as pid
      from pg_stat_activity
      where application_name = 'okmodel'
        and datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'idle'
    `;
    const pid = rows[0]?.pid;
    if (pid !== undefined) {
      const killed = await admin<{ ok: boolean }[]>`select pg_terminate_backend(${pid}::int) as ok`;
      if (killed[0]?.ok !== true) throw new Error(`did not terminate ${pid}`);
      return pid;
    }
    await Bun.sleep(20);
  }
  throw new Error("no idle okmodel backend");
}

async function waitUntilGone(admin: Sql, pid: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await admin<{ pid: string }[]>`
      select pid::text as pid from pg_stat_activity where pid = ${pid}::int
    `;
    if (rows.length === 0) return;
    await Bun.sleep(20);
  }
  throw new Error(`backend ${pid} stayed up`);
}
