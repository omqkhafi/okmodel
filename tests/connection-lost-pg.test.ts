/**
 * A backend that dies inside `tx()` must not crash the process.
 *
 * postgres.js writes the next statement with `setImmediate`. After
 * `pg_terminate_backend` that write throws on a null socket, off the promise.
 * The statement and the transaction reject, and the next call still runs.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";

const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

const gate = await loadPostgresGate();

type Driver = "postgresjs" | "pg" | "bun";
type Db = {
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  notes: { find(options?: { limit?: number }): Promise<readonly unknown[]> };
  close(): Promise<void>;
};
type Tx = {
  notes: {
    find(options?: { limit?: number }): Promise<readonly unknown[]>;
    insert(row: { id: number; title: string }): Promise<unknown>;
  };
};

const connectors: Record<Driver, (url: string) => Db> = {
  postgresjs: (url) => connectPostgres(url, { schema: app, max: 1 }) as unknown as Db,
  pg: (url) => connectPg(url, { schema: app, max: 1 }) as unknown as Db,
  bun: (url) => connectBun(url, { schema: app, max: 1 }) as unknown as Db,
};

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  postgresTest(
    gate,
    `${driver}: a lost backend inside tx does not escape the promise`,
    async () => {
      if (driver === "bun" && (typeof Bun === "undefined" || typeof Bun.SQL !== "function")) return;
      const database = await createIsolatedDatabase();
      const admin = openPostgres(database.url);
      const crashes: unknown[] = [];
      const onUncaught = (error: unknown): void => {
        crashes.push(error);
      };
      const onRejection = (error: unknown): void => {
        crashes.push(error);
      };
      process.on("uncaughtException", onUncaught);
      process.on("unhandledRejection", onRejection);
      try {
        await admin.unsafe("create table notes (id int primary key, title text not null)");
        await admin.unsafe(
          `create function okm_delay() returns trigger language plpgsql as $$ begin perform pg_sleep(8); return new; end $$`,
        );
        await admin.unsafe(
          `create constraint trigger okm_delay after insert on notes deferrable initially deferred for each row execute function okm_delay()`,
        );
        const db = connectors[driver](database.url);
        try {
          await expectLost(db, () => killIdle(admin), "unavailable");
          await db.notes.find({ limit: 1 });

          await admin.unsafe("begin");
          await admin.unsafe("lock table notes in access exclusive mode");
          const waiting = db.tx(async (tx) => {
            await tx.notes.find({ limit: 1 });
          });
          await Bun.sleep(300);
          await killApp(admin);
          const mid = await rejection(waiting);
          expect(kindOf(mid)).toBe("unavailable");
          await admin.unsafe("rollback");
          await db.notes.find({ limit: 1 });

          const committing = db.tx(async (tx) => {
            await tx.notes.insert({ id: 7, title: "commit" });
          });
          await killWhen(admin, "commit");
          const commit = await rejection(committing);
          expect(codeOf(commit)).toBe("OKM1401");
          expect(kindOf(commit)).toBe("outcome_unknown");
          await db.notes.find({ limit: 1 });
        } finally {
          await db.close();
        }
        await Bun.sleep(50);
        expect(crashes).toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
        process.off("unhandledRejection", onRejection);
        await admin.unsafe("rollback").catch(() => undefined);
        await admin.end({ timeout: 5 });
        await database.close();
      }
    },
    90_000,
  );
}

async function expectLost(db: Db, kill: () => Promise<void>, kind: string): Promise<void> {
  const error = await rejection(
    db.tx(async (tx) => {
      await tx.notes.find({ limit: 1 });
      await kill();
      await tx.notes.find({ limit: 1 });
    }),
  );
  expect(kindOf(error)).toBe(kind);
}

async function killIdle(admin: ReturnType<typeof openPostgres>): Promise<void> {
  await killWhen(admin, "idle");
}

async function killWhen(admin: ReturnType<typeof openPostgres>, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await admin<{ pid: string; state: string; query: string }[]>`
      select pid::text as pid, state, query
      from pg_stat_activity
      where application_name = 'okmodel'
        and datname = current_database()
        and pid <> pg_backend_pid()
    `;
    const match = rows.find((row) => {
      if (needle === "idle") return row.state === "idle in transaction";
      const query = row.query.toLowerCase();
      return query.includes("commit") || query.includes("pg_sleep");
    });
    if (match !== undefined) {
      await admin.unsafe(`select pg_terminate_backend(${match.pid})`);
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`no okmodel backend matched ${needle}`);
}

async function killApp(admin: ReturnType<typeof openPostgres>): Promise<void> {
  const rows = await admin<{ pid: string }[]>`
    select pid::text as pid
    from pg_stat_activity
    where application_name = 'okmodel'
      and datname = current_database()
      and pid <> pg_backend_pid()
  `;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("no okmodel backend");
  await admin.unsafe(`select pg_terminate_backend(${pid})`);
}

async function rejection(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

function kindOf(error: unknown): string | undefined {
  return error instanceof OkmError ? error.kind : undefined;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof OkmError ? error.code : undefined;
}
