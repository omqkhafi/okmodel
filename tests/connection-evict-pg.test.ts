/**
 * A connection that ran ROLLBACK goes back to the pool clean.
 *
 * Two channels, on postgres.js, node-postgres, and Bun.sql:
 * - explicit `ROLLBACK` after session settings were set on that connection
 * - a failed statement that aborts the transaction, then release
 *
 * Session settings are set before `BEGIN`, so `ROLLBACK` alone leaves them.
 * `RESET ALL` on release is what clears them. A session advisory lock taken
 * inside `tx()` survives the transaction rollback; `pg_advisory_unlock_all`
 * on release is what drops it. The same backend is checked out again (`max: 1`).
 *
 * Product bugs stay in {@link KNOWN_EVICTION}. This file does not change them.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgresJs } from "../src/adapters/pg/postgresjs.js";
import type { DriverConnection, DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { fragment, raw, schema, t, table } from "../src/dialects/pg/index.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgresJs } from "../src/runtime/pg/postgresjs.js";

const gate = await loadPostgresGate();

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const DIRTY = "okm-evict-dirty";

/**
 * Open eviction bugs.
 *
 * `channel` is `pool` (reserve / release) or `tx` (public `tx()`).
 * `repro` is the shortest failing sequence, at most 15 lines.
 */
export const KNOWN_EVICTION: readonly {
  readonly driver: string;
  readonly channel: "pool" | "tx";
  readonly repro: string;
}[] = [];

type Open = (url: string) => DriverPool;

/** Fields every driver `connect` accepts. Their `ssl` option types are not the same. */
type ConnectOptions = {
  readonly schema: typeof app;
  readonly searchPath: string;
  readonly max: number;
};

type Connect = (url: string, options: ConnectOptions) => RootClient;

const DRIVERS: readonly {
  readonly name: string;
  readonly open: Open;
  readonly connect: Connect;
}[] = [
  {
    name: "postgres.js",
    open: (url) => openPostgresJs({ url, max: 1 }),
    connect: (url, options) => connectPostgresJs(url, options),
  },
  {
    name: "node-postgres",
    open: (url) => openPg({ url, max: 1 }),
    connect: (url, options) => connectPg(url, options),
  },
  {
    name: "bun",
    open: (url) => openBun({ url, max: 1 }),
    connect: (url, options) => connectBun(url, options),
  },
];

class Text {
  value = "";
}

postgresTest(
  gate,
  "a rolled-back connection returns to the pool with no transaction and reset session settings",
  async () => {
    const failures: string[] = [];
    for (const driver of DRIVERS) {
      const known = KNOWN_EVICTION.filter((bug) => bug.driver === driver.name);
      try {
        await provePool(driver.open);
      } catch (error) {
        if (!known.some((bug) => bug.channel === "pool"))
          failures.push(format(driver.name, "pool", error));
      }
      try {
        await proveTx(driver.connect);
      } catch (error) {
        if (!known.some((bug) => bug.channel === "tx"))
          failures.push(format(driver.name, "tx", error));
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join("\n\n"));
    }
  },
  90_000,
);

async function provePool(open: Open): Promise<void> {
  const pool = open(primaryUrl());
  try {
    await rolledBack(pool, "explicit");
    await rolledBack(pool, "failed");
  } finally {
    await pool.close();
  }
}

async function rolledBack(pool: DriverPool, kind: "explicit" | "failed"): Promise<void> {
  if (pool.reserve === undefined) throw new Error("driver does not reserve a connection");
  const conn = await pool.reserve();
  const pid = await cell(conn, "select pg_backend_pid()::text");
  await conn.execute("select set_config('okm.evict_probe', 'dirty', false)");
  await conn.execute(`set application_name = '${DIRTY}'`);
  await conn.execute("begin");
  if (kind === "explicit") {
    await conn.execute("select 1");
    await conn.execute("rollback");
  } else {
    await conn.execute("select 1/0").catch(() => undefined);
  }
  await conn.release();
  await expectClean(pool, pid);
}

async function expectClean(pool: DriverPool, pid: string): Promise<void> {
  if (pool.reserve === undefined) throw new Error("driver does not reserve a connection");
  const conn = await pool.reserve();
  try {
    const row = await cells(
      conn,
      "select pg_backend_pid()::text, current_setting('application_name'), coalesce(current_setting('okm.evict_probe', true), ''), (pg_current_xact_id_if_assigned() is null)::text, 1::text",
    );
    expect(row[0]).toBe(pid);
    expect(row[1]).not.toBe(DIRTY);
    expect(row[2]).toBe("");
    expect(row[3]).toBe("true");
    expect(row[4]).toBe("1");
  } finally {
    await conn.release();
  }
}

async function proveTx(connect: Connect): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      await explicitTx(db);
      await failedTx(db);
    } finally {
      await db.close();
    }
  });
}

async function explicitTx(db: RootClient): Promise<void> {
  let pid = "";
  try {
    await db.tx(async (tx) => {
      pid = await readPid(tx);
      await raw(tx.notes, Text, "read", fragment`select pg_advisory_lock(91001)::text as value`);
      throw new Error("explicit rollback");
    });
    throw new Error("explicit rollback did not throw");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "explicit rollback") throw error;
  }
  await expectTxClean(db, pid, "91001");
}

async function failedTx(db: RootClient): Promise<void> {
  let pid = "";
  try {
    await db.tx(async (tx) => {
      pid = await readPid(tx);
      await raw(tx.notes, Text, "read", fragment`select pg_advisory_lock(91002)::text as value`);
      await tx.notes.insert({ id: "a", title: "a" });
      await tx.notes.insert({ id: "a", title: "dup" });
    });
    throw new Error("duplicate insert did not throw");
  } catch (error) {
    if (!(error instanceof OkmError)) throw error;
  }
  const left = await db.notes.find({ where: { id: "a" }, limit: 1 });
  expect(left).toEqual([]);
  await expectTxClean(db, pid, "91002");
  await db.notes.insert({ id: "b", title: "next" });
  expect(await db.notes.find({ where: { id: "b" }, limit: 1 })).toHaveLength(1);
}

async function expectTxClean(db: TxHandle, pid: string, lock: "91001" | "91002"): Promise<void> {
  // A session advisory lock shows up in `pg_locks` until release runs
  // `pg_advisory_unlock_all`.
  const probe =
    lock === "91001"
      ? fragment`select (pg_backend_pid()::text || ' ' || (pg_current_xact_id_if_assigned() is null)::text || ' ' || (exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid = 0 and objid = 91001))::text || ' ' || 1::text) as value`
      : fragment`select (pg_backend_pid()::text || ' ' || (pg_current_xact_id_if_assigned() is null)::text || ' ' || (exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid = 0 and objid = 91002))::text || ' ' || 1::text) as value`;
  const [state] = await raw(db.notes, Text, "read", probe);
  expect(state?.value).toBe(`${pid} true false 1`);
}

async function readPid(tx: TxHandle): Promise<string> {
  const [row] = await raw(tx.notes, Text, "read", fragment`select pg_backend_pid()::text as value`);
  if (row === undefined || row.value === "") throw new Error("pid probe returned no row");
  return row.value;
}

function format(driver: string, channel: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split("\n");
  const body = lines.slice(0, 15).join("\n");
  return `${driver} ${channel} (${String(lines.length)} lines)\n${body}`;
}

async function cell(conn: DriverConnection, text: string): Promise<string> {
  const row = await cells(conn, text);
  const value = row[0];
  if (value === undefined || value === "") throw new Error(`probe returned no value: ${text}`);
  return value;
}

async function cells(conn: DriverConnection, text: string): Promise<readonly string[]> {
  const result = await conn.execute(text);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`probe returned no row: ${text}`);
  return row.map((value) => (value === null || value === undefined ? "" : String(value)));
}

/** Tables the transaction callback uses. It has no pool `close`. */
type TxHandle = {
  readonly notes: {
    insert(row: { readonly id: string; readonly title: string }): Promise<unknown>;
    find(options: {
      readonly where: { readonly id: string };
      readonly limit: number;
    }): Promise<readonly unknown[]>;
  };
};

/** The root client this file calls. */
type RootClient = TxHandle & {
  readonly connected: Promise<void>;
  close(): Promise<void>;
  tx<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T>;
};
