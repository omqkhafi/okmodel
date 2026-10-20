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
