/**
 * Pool operations a read does not use: checkout, describe, and stream.
 *
 * Loaded on the first reserve, batch, describe, or stream.
 */

import type { Sql } from "postgres";

import type { DescribeResult, DriverConnection, WireValue } from "../../contracts/driver.js";
import { driverErrors, mapFailure, rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { PgSession, type Canceller, type Counters, type NoticeBuffer } from "./postgresjs.js";
import { rowsFrom } from "./result.js";

const RESET_ALL = "RESET ALL";
const UNLOCK = "SELECT pg_advisory_unlock_all()";

/** State `open` shares with a checkout. */
export type HeldPool = {
  readonly sql: Sql;
  readonly acquireMs: number | undefined;
  readonly counters: Counters;
  readonly isClosed: () => boolean;
  readonly notices: NoticeBuffer;
  readonly named: boolean;
  readonly poolInflight: Set<Canceller>;
};

/**
 * Checks out one connection and clears it on release.
 *
 * @param pool - The open pool
 * @returns A connection the caller must release
 */
export async function checkout(pool: HeldPool): Promise<DriverConnection> {
  if (pool.isClosed()) return rejectClosed();
  const reserved = await reserveConnection(pool.sql, pool.acquireMs, pool.counters);
  pool.counters.reserved += 1;
  const local = new Set<Canceller>();
  const session = new PgSession(
    reserved,
    pool.counters,
    "reserved",
    local,
    pool.isClosed,
    pool.poolInflight,
    pool.notices,
    pool.named,
  );
  let released = false;
  return {
    execute: (text, params, options) =>
      runCall(pool.isClosed(), options, (watch) => session.query(text, params, watch)),
    batch: (statements, options) =>
      runCall(pool.isClosed(), options, async (watch: Watch | undefined) => {
        const { runAtomicBatch } = await import("./batch.js");
        return runAtomicBatch(session, statements, watch);
      }),
    cancel() {
      session.cancel();
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await resetConnection(reserved, session.depth());
      } finally {
        pool.counters.reserved = Math.max(0, pool.counters.reserved - 1);
        reserved.release();
      }
    },
  };
}

/**
 * Describes a statement.
 *
 * @param sql - Pool client
 * @param text - SQL
 * @param params - Wire parameters
 * @returns Column names and the parameter count
 */
export async function describe(
  sql: Sql,
  text: string,
  params?: readonly WireValue[],
): Promise<DescribeResult> {
  const pending = sql.unsafe(text, asParams(params), { prepare: true });
  const described = await pending.describe();
  return {
    columns: described.columns.map((column) => column.name),
    parameterCount: described.types.length,
  };
}

/**
 * Yields cursor chunks.
 *
 * @param sql - Pool client
 * @param text - SQL
 * @param params - Wire parameters
 * @returns Chunks of wire rows
 */
export async function* stream(
  sql: Sql,
  text: string,
  params?: readonly WireValue[],
): AsyncIterable<readonly (readonly WireValue[])[]> {
  const pending = sql.unsafe(text, asParams(params));
  for await (const chunk of pending.cursor(64)) {
    yield rowsFrom(chunk);
  }
}

type ReservedConnection = Sql & {
  release(): void;
};

function reserveConnection(
  sql: Sql,
  acquireMs: number | undefined,
  counters: Counters,
): Promise<ReservedConnection> {
  counters.waiting += 1;
  let settled = false;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (acquireMs !== undefined) {
      timer = setTimeout(() => {
        settled = true;
        counters.waiting = Math.max(0, counters.waiting - 1);
        void driverErrors().then((errors) => {
          reject(errors.acquireTimeout());
        });
      }, acquireMs);
    }
    sql.reserve().then(
      (connection) => {
        if (settled) {
          void resetConnection(connection, 0).finally(() => {
            connection.release();
          });
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        counters.waiting = Math.max(0, counters.waiting - 1);
        resolve(connection);
      },
      (error: unknown) => {
        if (settled) return;
        if (timer !== undefined) clearTimeout(timer);
        counters.waiting = Math.max(0, counters.waiting - 1);
        void mapFailure(error).then(reject);
      },
    );
  });
}

async function resetConnection(sql: Sql, depth: number): Promise<void> {
  if (depth > 0) await sql.unsafe("ROLLBACK").catch(() => undefined);
  try {
    await sql.unsafe(RESET_ALL);
    await sql.unsafe(UNLOCK);
  } catch {
    await sql.unsafe("ROLLBACK").catch(() => undefined);
    await sql.unsafe(RESET_ALL);
    await sql.unsafe(UNLOCK);
  }
}

function asParams(params: readonly WireValue[] | undefined): string[] {
  if (params === undefined) return [];
  return params as unknown as string[];
}
