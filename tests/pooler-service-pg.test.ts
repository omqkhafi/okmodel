/**
 * PgBouncer transaction-mode smoke for the CI service container (CI-P).
 *
 * Opt in with `OKM_POOLER_URL`. Suite shards leave it unset and keep the
 * direct topology URL (`primaryUrl`). PGlite and PGlite wire are in-process.
 * Neon speaks HTTP or WebSocket to a Neon endpoint. Those three cannot open
 * this TCP pooler. postgres.js, node-postgres, and Bun.sql can.
 *
 * The CI image is `edoburu/pgbouncer` v1.26.1-p0 (PgBouncer 1.26.1,
 * `sha256:488422e38cff912895d0d65d8963fcd306e6ac589a724398b6eb8e294e94d624`).
 * `max_prepared_statements` exists since 1.21 and defaults to 200 in 1.26.1,
 * so protocol-level prepared statements work in transaction mode. This smoke
 * uses simple queries. The container is `pool_mode=transaction` and
 * `default_pool_size=1`. Transaction pooling does not run `server_reset_query`,
 * so a `SET` outside a transaction stays on that server connection.
 */

import { expect, test } from "bun:test";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import type { DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { sessionSettings } from "../src/runtime/session/index.js";

/** How long the first transaction holds the only server connection. */
const HOLD_MS = 2_000;

/** A queued transaction on a pool of one waits at least this long. */
const WAIT_FLOOR_MS = 1_000;

const POOLER_URL = process.env.OKM_POOLER_URL;

type Opener = (config: { readonly url: string; readonly max: number }) => DriverPool;

const DRIVERS: readonly { readonly name: string; readonly open: Opener }[] = [
  { name: "postgresjs", open: openPostgres },
  { name: "pg", open: openPg },
  { name: "bun", open: openBun },
];

if (POOLER_URL === undefined || POOLER_URL.length === 0) {
  test.skip("PgBouncer service (set OKM_POOLER_URL to opt in)", () => {});
} else {
  const url = POOLER_URL;

  for (const driver of DRIVERS) {
    test(`${driver.name}: simple query through the pooler`, async () => {
      const pool = driver.open({ url, max: 1 });
      try {
        expect(oneCell(await pool.execute("select 1"))).toBe("1");
      } finally {
        await pool.close();
      }
    }, 15_000);

    test(`${driver.name}: two sequential transactions share one server connection`, async () => {
      await expectSharedServer(url, driver.open);
    }, 20_000);

    test(`${driver.name}: a set outside a transaction is visible to the next client`, async () => {
      await expectSessionLeak(url, driver.open);
    }, 15_000);

    test(`${driver.name}: session settings never reach the next client on the one server`, async () => {
      await expectNoSettingLeak(url, driver.open);
    }, 30_000);
  }
}

/**
 * Reads the first cell of a one-row result.
 *
 * @param result - A statement result
 * @returns Wire text of `rows[0][0]`
 */
function oneCell(result: ExecuteResult): string {
  const value = result.rows[0]?.[0];
  if (value === undefined || value === null) {
    throw new Error("expected one non-null cell");
  }
  return value;
}

/**
 * Proves `default_pool_size=1`: a second transaction waits, then lands on
 * the same `pg_backend_pid()` as the transaction that was holding the server.
 *
 * @param url - Pooler URL
 * @param open - Adapter opener
 */
async function expectSharedServer(url: string, open: Opener): Promise<void> {
  const first = open({ url, max: 1 });
  const second = open({ url, max: 1 });
  try {
    // The second pool connects before the hold, so the timed `begin` measures
    // the queue and not a cold TCP handshake.
    expect(oneCell(await second.execute("select 1"))).toBe("1");
    await first.execute("begin");
    const held = oneCell(await first.execute("select pg_backend_pid()"));
    const began = (async (): Promise<number> => {
      const started = Date.now();
      await second.execute("begin");
      return Date.now() - started;
    })();
    await first.execute(`select pg_sleep(${String(HOLD_MS / 1000)})`);
    await first.execute("commit");
    const waitedMs = await began;
    const reused = oneCell(await second.execute("select pg_backend_pid()"));
    await second.execute("commit");
    expect(reused).toBe(held);
    expect(waitedMs).toBeGreaterThanOrEqual(WAIT_FLOOR_MS);
  } finally {
    await second.close().catch(() => undefined);
    await first.close().catch(() => undefined);
  }
}

/**
 * Proves the session leak a later pool-size-1 test asserts: `SET` outside a
 * transaction survives on the single server and the next client sees it.
 *
 * `lock_timeout` is not a startup parameter PgBouncer 1.26 tracks, so the
 * pooler does not restore it when the next client is assigned.
 *
 * @param url - Pooler URL
 * @param open - Adapter opener
 */
async function expectSessionLeak(url: string, open: Opener): Promise<void> {
  const first = open({ url, max: 1 });
  try {
    await first.execute("reset lock_timeout");
    expect(oneCell(await first.execute("show lock_timeout"))).toBe("0");
    await first.execute("set lock_timeout = '7s'");
    expect(oneCell(await first.execute("show lock_timeout"))).toBe("7s");
  } finally {
    await first.close();
  }

  const second = open({ url, max: 1 });
  try {
    expect(oneCell(await second.execute("show lock_timeout"))).toBe("7s");
    await second.execute("reset lock_timeout");
  } finally {
    await second.close();
  }
}

const USER_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const USER_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

const SETTINGS = sessionSettings({
  userId: { name: "app.leak_user", type: "uuid" },
});

/**
 * The leak test: two clients with different values share the one PgBouncer
 * server connection, and neither ever reads the other's value.
 *
 * Each row stores `current_setting('app.leak_user')` at insert. One client
 * holds a transaction open across a pause while the other writes. After
 * every unit a third pool on the same server reads the setting as empty, and
 * a client that never calls `with()` stores NULL.
 *
 * @param url - Pooler URL
 * @param open - Adapter opener
 */
async function expectNoSettingLeak(url: string, open: Opener): Promise<void> {
  const name = "leaks";
  const notes = table(name, { id: t.identity(), actor: t.text().nullable() });
  const app = schema({ casing: "snake", tables: [notes] });
  const admin = open({ url, max: 1 });
  const first = open({ url, max: 1 });
  const second = open({ url, max: 1 });
  const dbA = connect(first, { schema: app, session: SETTINGS });
  const dbB = connect(second, { schema: app, session: SETTINGS });
  try {
    await admin.execute(`drop table if exists "${name}"`);
    await admin.execute(
      `create table "${name}" (id bigint generated always as identity primary key, actor text default nullif(current_setting('app.leak_user', true), ''))`,
    );
    await Promise.all([dbA.connected, dbB.connected]);
    const pid = oneCell(await admin.execute("select pg_backend_pid()"));
    expect(oneCell(await first.execute("select pg_backend_pid()"))).toBe(pid);
    expect(oneCell(await second.execute("select pg_backend_pid()"))).toBe(pid);

    const a = dbA.with({ userId: USER_A });
    const b = dbB.with({ userId: USER_B });
    const held = a.tx(async (tx) => {
      const before = await tx.leaks.insert({});
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = await tx.leaks.insert({});
      return [before.actor, after.actor];
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const written = await Promise.all(
      Array.from({ length: 6 }, async () => (await b.leaks.insert({})).actor),
    );
    expect(written).toEqual(Array.from({ length: 6 }, () => USER_B));
    expect(await held).toEqual([USER_A, USER_A]);

    const loop = await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) => {
        const side = index % 2 === 0;
        const row = await (side ? a : b).leaks.insert({});
        return [row.actor, side ? USER_A : USER_B];
      }),
    );
    for (const [got, want] of loop) expect(got).toBe(want);

    expect(oneCell(await admin.execute("select current_setting('app.leak_user', true)"))).toBe("");
    const bare = await dbB.leaks.insert({});
    expect(bare.actor).toBeNull();
    const counts = await admin.execute(
      `select actor, count(*) from "${name}" group by actor order by actor`,
    );
    expect(counts.rows.map((row) => row[0])).toEqual([USER_A, USER_B, null]);
  } finally {
    await admin.execute(`drop table if exists "${name}"`).catch(() => undefined);
    await dbA.close().catch(() => undefined);
    await dbB.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await admin.close().catch(() => undefined);
  }
}
