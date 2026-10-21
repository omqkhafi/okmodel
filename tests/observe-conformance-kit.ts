/**
 * Shared rig for the observer conformance tests (G-8).
 *
 * One rig is one empty database and one driver. Postgres drivers share the
 * Docker topology and get an isolated database each. PGlite gets its own
 * in-memory database. The rig hands out clients, runs setup and check SQL on a
 * connection that is not the client under test, and drops the database.
 */

import type { DriverPool } from "../src/contracts/driver.js";
import type { QuerySchema } from "../src/dialects/pg/model.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import type { ObserveEvent, OutcomeEvent, WriteEvent } from "../src/runtime/observe-types.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import type { SessionContext } from "../src/runtime/session/index.js";
import type { ConnectOptions, Connected } from "../src/runtime/types.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

/** Every adapter the conformance tests drive. Neon has no local endpoint in this repo. */
export type DriverName = "postgresjs" | "pg" | "bun" | "pglite";

/** Adapters in the order the tests run them. */
export const DRIVERS: readonly DriverName[] = ["postgresjs", "pg", "bun", "pglite"];

/** Whether this runtime can drive `driver`. Bun.sql needs Bun 1.4 or later. */
export function runnable(driver: DriverName): boolean {
  return driver !== "bun" || (typeof Bun !== "undefined" && typeof Bun.SQL === "function");
}

/** Options a rig client takes: the connect options plus a pool size. */
export type RigOptions<
  S extends QuerySchema,
  C extends SessionContext | undefined,
> = ConnectOptions<S, C> & {
  readonly max?: number;
  readonly connectionUrl?: string;
};

/** One database, one driver. */
export type Rig = {
  readonly driver: DriverName;
  /** Primary URL of the database. Absent on PGlite. */
  readonly url: string | undefined;
  /** Connects a client for `options.schema`. A pool of one on PGlite. */
  connect<const S extends QuerySchema, const C extends SessionContext | undefined = undefined>(
    options: RigOptions<S, C>,
  ): Promise<Connected<S, C>>;
  /** Runs SQL on a connection the client under test does not own. */
  exec(sql: string): Promise<void>;
  /** Selects rows as objects on that connection. */
  rows(sql: string): Promise<readonly Record<string, unknown>[]>;
  /** Drops the database. */
  close(): Promise<void>;
};

/**
 * Opens a rig and runs `ddl`.
 *
 * @param driver - Adapter under test
 * @param ddl - Setup statements separated by `;` at the end of a line
 * @returns The rig
 */
export async function openRig(driver: DriverName, ddl: string): Promise<Rig> {
  const statements = ddl
    .split(/;\s*\n/)
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  if (driver === "pglite") return pgliteRig(statements);
  const database = await createIsolatedDatabase();
  const admin = openPostgres(database.url);
  for (const statement of statements) await admin.unsafe(statement);
  const open = {
    postgresjs: connectPostgres,
    pg: connectPg,
    bun: connectBun,
  }[driver] as unknown as (
    url: string,
    options: unknown,
  ) => Connected<QuerySchema, SessionContext | undefined>;
  return {
    driver,
    url: database.url,
    connect: (options) =>
      Promise.resolve(open(options.connectionUrl ?? database.url, options)) as never,
    async exec(sql) {
      await admin.unsafe(sql);
    },
    async rows(sql) {
      return (await admin.unsafe(sql)) as unknown as readonly Record<string, unknown>[];
    },
    async close() {
      await admin.end({ timeout: 5 });
      await database.close();
    },
  };
}

async function pgliteRig(statements: readonly string[]): Promise<Rig> {
  const pool: DriverPool = await openPglite({});
  for (const statement of statements) await pool.execute(statement);
  return {
    driver: "pglite",
    url: undefined,
    async connect(options) {
      return (await connectPglite(pool, options)) as never;
    },
    async exec(sql) {
      await pool.execute(sql);
    },
    async rows(sql) {
      const result = await pool.execute(
        `select coalesce(json_agg(t), '[]'::json)::text from (${sql}) t`,
      );
      return JSON.parse(String(result.rows[0]?.[0])) as readonly Record<string, unknown>[];
    },
    async close() {
      await pool.close();
    },
  };
}

/** The write events of a stream. */
export function writesOf(events: readonly ObserveEvent[]): WriteEvent[] {
  return events.filter((event): event is WriteEvent => event.type === "write");
}

/** The outcome events of a stream. */
export function outcomesOf(events: readonly ObserveEvent[]): OutcomeEvent[] {
  return events.filter((event): event is OutcomeEvent => event.type === "outcome");
}

/** Rejection of `promise`, or a failure when it resolved. */
export async function rejection(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}
