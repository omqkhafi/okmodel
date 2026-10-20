/**
 * Driver conformance suite v1.
 *
 * The same cases run against any adapter. A case that needs a capability the
 * adapter did not declare is skipped. Error-mapping cases are a separate suite.
 */

import { DriverError } from "../../../src/adapters/error.js";
import { expect } from "./expect.js";
import { OkmError } from "../../../src/contracts/error.js";
import type {
  DriverCapabilities,
  DriverPool,
  ExecuteResult,
  Statement,
} from "../../../src/contracts/driver.js";

/** Opens one pool. The caller closes it. */
export type DriverOpener = () => DriverPool | Promise<DriverPool>;

/**
 * Registers one suite case.
 *
 * `skip` records a case the adapter did not declare. `unsupported` names the
 * capability, so a report can say unsupported instead of dropping the case.
 */
export type SuiteTest = {
  (name: string, fn: () => Promise<void>, timeoutMs?: number): void;
  skip(name: string, fn: () => Promise<void>, timeoutMs?: number): void;
  /**
   * Records a case this driver cannot run.
   *
   * @param name - Case title
   * @param capability - The limit that explains it, for example `cancel`
   */
  unsupported?(name: string, capability: string): void;
};

/**
 * Returns a registrar that does not run the case.
 *
 * When `test.unsupported` exists, the case is recorded with `capability` and
 * is not also skipped. Otherwise the case is skipped. `title` changes the
 * skipped name. The default keeps `name`.
 *
 * @param test - Registrar the suite was given
 * @param capability - Why the case cannot run
 * @param title - Skipped title. Omitted keeps `name`
 * @returns A registrar that records the case and does not run it
 */
export function skipFor(
  test: SuiteTest,
  capability: string,
  title?: (name: string) => string,
): SuiteTest {
  const label = title ?? ((name: string) => name);
  const register: SuiteTest = (name, fn, timeoutMs) => {
    if (test.unsupported !== undefined) {
      test.unsupported(name, capability);
      return;
    }
    test.skip(label(name), fn, timeoutMs);
  };
  register.skip = (name, fn, timeoutMs) => {
    if (test.unsupported !== undefined) {
      test.unsupported(name, capability);
      return;
    }
    test.skip(label(name), fn, timeoutMs);
  };
  return register;
}

/** What one adapter run needs. */
export type DriverSuite = {
  /** Name used in test titles. */
  readonly name: string;
  /** Pool for the general cases. */
  readonly open: DriverOpener;
  /** Pool with a short `timeouts.acquire`, for OKM1846. */
  readonly openLimited: DriverOpener;
  /** A second endpoint. Acquire failure on the first must not use it. */
  readonly openOther: DriverOpener;
  /** `stats().size` after {@link DriverSuite.open}. */
  readonly size: number;
  /** Flags the opener declares. Undeclared cases are skipped. */
  readonly capabilities: DriverCapabilities;
  /**
   * The pool can describe a statement without running it.
   *
   * This is not a capability flag. Omitted skips the describe case.
   */
  readonly statementDescribe?: boolean;
  /**
   * When false, the notice case is skipped.
   *
   * Omitted means the driver returns server notices. Bun.sql does not.
   */
  readonly notices?: boolean;
  /** Test registrar. Postgres passes the shared skip rule. */
  readonly test: SuiteTest;
};

/**
 * Registers the v1 suite.
 *
 * @param suite - The adapter under test
 */
export function registerDriverSuite(suite: DriverSuite): void {
  const { name } = suite;
  const test = suite.test;
  const optional = (flag: boolean, capability: string): SuiteTest =>
    flag ? test : skipFor(test, capability);

  test(`${name} execute returns rows`, async () => {
    await using(suite.open, async (pool) => {
      const result = await pool.execute("SELECT 1::text AS n");
      expect(result.rows).toEqual([["1"]]);
      expect(result.count).toBe(1);
      expect(result.notices).toEqual([]);
    });
  });

  test(`${name} keeps null as null`, async () => {
    await using(suite.open, async (pool) => {
      const result = await pool.execute("SELECT $1::text, $2::int4", ["a", null]);
      expect(result.rows).toEqual([["a", null]]);
    });
  });

  test(`${name} keeps timestamps as wire text`, async () => {
    await using(suite.open, async (pool) => {
      const zone = "with cfg as (select set_config('TimeZone', 'UTC', true))";
      const equal = await pool.execute(
        `${zone} select ($1::timestamptz = TIMESTAMPTZ '2020-01-02 03:04:05+00') from cfg`,
        ["2020-01-02 03:04:05+00"],
      );
      expect(equal.rows[0]?.[0]).toBe("t");
      const printed = await scalar(pool, `${zone} select $1::timestamptz::text from cfg`, [
        "2020-01-02 03:04:05+00",
      ]);
      expect(printed).toContain("2020-01-02");
      expect(printed).toContain("03:04:05");
    });
  });

  test(`${name} keeps numeric as wire text`, async () => {
    await using(suite.open, async (pool) => {
      expect(await scalar(pool, "SELECT $1::numeric", ["12345678901234567890.25"])).toBe(
        "12345678901234567890.25",
      );
    });
  });

  test(`${name} keeps bigint as wire text`, async () => {
    await using(suite.open, async (pool) => {
      expect(await scalar(pool, "SELECT $1::int8", ["9223372036854775807"])).toBe(
        "9223372036854775807",
      );
    });
  });

  test(`${name} keeps json as wire text`, async () => {
    await using(suite.open, async (pool) => {
      const cell = await scalar(pool, "SELECT $1::jsonb", ['{"a":1}']);
      expect(JSON.parse(cell ?? "null")).toEqual({ a: 1 });
    });
  });

  test(`${name} keeps arrays as wire text`, async () => {
    await using(suite.open, async (pool) => {
      expect(await scalar(pool, "SELECT $1::int[]", ["{1,2,3}"])).toBe("{1,2,3}");
    });
  });

  const notices = suite.notices === false ? skipFor(test, "notices") : test;
  notices(`${name} returns notices`, async () => {
    await using(suite.open, async (pool) => {
      const result = await pool.execute("DO $$ BEGIN RAISE NOTICE 'okm-p13'; END $$");
      expect(result.notices.some((notice) => notice.message.includes("okm-p13"))).toBe(true);
    });
  });

  test(`${name} batch commits every statement`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      await pool.execute(`CREATE TABLE ${table} (id int)`);
      const results = await pool.batch([insert(table, 1), insert(table, 2)]);
      expect(results).toHaveLength(2);
      expect(await countOf(pool, table)).toBe("2");
    });
  });

  test(`${name} batch rolls back a failure at each position`, async () => {
    await using(suite.open, async (pool) => {
      for (const index of [0, 1, 2]) {
        const table = tableName();
        await pool.execute(`CREATE TABLE ${table} (id int)`);
        const statements: Statement[] = [insert(table, 1), insert(table, 2), insert(table, 3)];
        statements[index] = { text: "SELECT 1/0" };
        const error = await failure(pool.batch(statements));
        expect(error).toBeInstanceOf(DriverError);
        expect(error.batchIndex).toBe(index);
        expect(await countOf(pool, table)).toBe("0");
      }
    });
  });

  test(`${name} batch reports a deferred constraint at commit`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      await pool.execute(`CREATE TABLE ${table} (n int)`);
      await pool.execute(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_n UNIQUE (n) DEFERRABLE INITIALLY DEFERRED`,
      );
      const error = await failure(pool.batch([insert(table, 1, "n"), insert(table, 1, "n")]));
      expect(error.batchIndex).toBe(null);
      expect(error.sqlstate).toBe("23505");
      expect(await countOf(pool, table)).toBe("0");
    });
  });

  test(`${name} rejects a pre-aborted signal before the statement`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      await pool.execute(`CREATE TABLE ${table} (id int)`);
      const error = await failure(
        pool.execute(`INSERT INTO ${table} (id) VALUES (1)`, undefined, {
          signal: AbortSignal.abort(),
        }),
      );
      expect(error.kind).toBe("cancelled");
      expect(await countOf(pool, table)).toBe("0");
    });
  });

  optional(suite.capabilities.cancel, "cancel")(
    `${name} cancels an in-flight statement`,
    async () => {
      await using(suite.open, async (pool) => {
        const started = Date.now();
        const error = await failure(
          pool.execute("SELECT pg_sleep(5)", undefined, { signal: AbortSignal.timeout(40) }),
        );
        expect(error.kind).toBe("cancelled");
        expect(Date.now() - started).toBeLessThan(2_000);
      });
    },
    10_000,
  );

  optional(suite.capabilities.cancel, "cancel")(
    `${name} times out an in-flight statement`,
    async () => {
      await using(suite.open, async (pool) => {
        const started = Date.now();
        const error = await failure(pool.execute("SELECT pg_sleep(5)", undefined, { timeout: 80 }));
        expect(error.kind).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(2_000);
      });
    },
    10_000,
  );

  optional(suite.capabilities.cancel, "cancel")(
    `${name} cancels a batch and rolls it back`,
    async () => {
      await using(suite.open, async (pool) => {
        const table = tableName();
        await pool.execute(`CREATE TABLE ${table} (id int)`);
        const error = await failure(
          pool.batch([insert(table, 1), { text: "SELECT pg_sleep(5)" }], {
            signal: AbortSignal.timeout(40),
          }),
        );
        expect(error.kind).toBe("cancelled");
        expect(await countOf(pool, table)).toBe("0");
      });
    },
    10_000,
  );

  optional(suite.capabilities.cancel, "cancel")(
    `${name} times out a batch and rolls it back`,
    async () => {
      await using(suite.open, async (pool) => {
        const table = tableName();
        await pool.execute(`CREATE TABLE ${table} (id int)`);
        const error = await failure(
          pool.batch([insert(table, 1), { text: "SELECT pg_sleep(5)" }], { timeout: 80 }),
        );
        expect(error.kind).toBe("timeout");
        expect(await countOf(pool, table)).toBe("0");
      });
    },
    10_000,
  );

  test(`${name} runs a batch inside a transaction on a savepoint`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      const connection = await mustReserve(pool);
      try {
        await connection.execute(`CREATE TABLE ${table} (id int primary key)`);
        await connection.execute("BEGIN");
        await connection.execute(`INSERT INTO ${table} (id) VALUES (1)`);
        const error = await failure(
          connection.batch([
            { text: `INSERT INTO ${table} (id) VALUES (2)` },
            { text: `INSERT INTO ${table} (id) VALUES (2)` },
          ]),
        );
        expect(error.batchIndex).toBe(1);
        expect(await scalar(connection, `SELECT count(*)::text FROM ${table}`)).toBe("1");
        await connection.execute("ROLLBACK");
      } finally {
        await connection.release();
      }
    });
  });

  test(`${name} clears a custom setting and an advisory lock on release`, async () => {
    await using(suite.open, async (pool) => {
      const first = await mustReserve(pool);
      await first.execute("SELECT set_config('okm.p13', 'yes', false)");
      await first.execute("SELECT pg_advisory_lock(42)");
      const pid = await scalar(first, "SELECT pg_backend_pid()::text");
      await first.release();
      const second = await mustReserve(pool);
      try {
        const setting = await scalar(second, "SELECT current_setting('okm.p13', true)");
        expect(setting).not.toBe("yes");
        // Reset is observed on the released backend (`pid`), not by forcing the
        // next checkout to reuse that session. Bun.sql returns the handle to
        // its pool; the next reserve may be a different backend.
        expect(
          await scalar(
            second,
            `SELECT count(*)::text FROM pg_locks WHERE locktype = 'advisory' AND pid = ${pid}`,
          ),
        ).toBe("0");
      } finally {
        await second.release();
      }
    });
  });

  test(`${name} reports pool stats`, async () => {
    await using(suite.open, async (pool) => {
      expect(pool.stats()).toEqual({
        size: suite.size,
        idle: suite.size,
        inflight: 0,
        waiting: 0,
      });
      const connection = await mustReserve(pool);
      expect(pool.stats().idle).toBe(suite.size - 1);
      await connection.release();
      expect(pool.stats().idle).toBe(suite.size);
    });
  });

  test(`${name} close rejects a later execute`, async () => {
    const pool = await suite.open();
    await pool.close();
    expect(await failure(pool.execute("SELECT 1"))).toBeInstanceOf(DriverError);
  });

  test(`${name} acquire timeout is OKM1846 and does not use another pool`, async () => {
    const limited = await suite.openLimited();
    const other = await suite.openOther();
    try {
      const held = await mustReserve(limited);
      try {
        const error = await failure(mustReserve(limited));
        expect(error).toBeInstanceOf(OkmError);
        if (error instanceof OkmError) expect(error.code).toBe("OKM1846");
        expect(await scalar(other, "SELECT 1::text")).toBe("1");
      } finally {
        await held.release();
      }
    } finally {
      await limited.close();
      await other.close();
    }
  }, 10_000);

  optional(suite.statementDescribe === true, "describe")(
    `${name} describes a statement`,
    async () => {
      await using(suite.open, async (pool) => {
        if (pool.describe === undefined) throw new DriverError("describe is not on the pool");
        const described = await pool.describe("SELECT $1::int AS n");
        expect(described.columns).toEqual(["n"]);
        expect(described.parameterCount).toBe(1);
      });
    },
  );

  optional(suite.capabilities.stream, "stream")(`${name} streams rows`, async () => {
    await using(suite.open, async (pool) => {
      if (pool.stream === undefined) throw new DriverError("stream is not on the pool");
      const rows: string[] = [];
      for await (const chunk of pool.stream("SELECT generate_series(1, 3)::text")) {
        for (const row of chunk) {
          const cell = row[0];
          if (typeof cell === "string") rows.push(cell);
        }
      }
      expect(rows).toEqual(["1", "2", "3"]);
    });
  });

  optional(suite.capabilities.listen, "listen")(`${name} delivers a notification`, async () => {
    await using(suite.open, async (pool) => {
      if (pool.listen === undefined) throw new DriverError("listen is not on the pool");
      const payloads: string[] = [];
      const stop = await pool.listen("okm_p13", (payload) => {
        payloads.push(payload);
      });
      try {
        await pool.execute("SELECT pg_notify('okm_p13', 'hello')");
        await wait(50);
        expect(payloads).toContain("hello");
      } finally {
        await stop();
      }
    });
  });
}

async function using(open: DriverOpener, fn: (pool: DriverPool) => Promise<void>): Promise<void> {
  const pool = await open();
  try {
    await fn(pool);
  } finally {
    await dropOkmTables(pool);
    await pool.close();
  }
}

/** Drops leftover `okm_*` tables from this case (B-05 / B-06). */
async function dropOkmTables(pool: DriverPool): Promise<void> {
  try {
    await pool.execute(`
      do $$
      declare
        r record;
      begin
        for r in
          select tablename
          from pg_tables
          where schemaname = current_schema()
            and tablename like 'okm\\_%' escape '\\'
        loop
          execute format('drop table if exists %I cascade', r.tablename);
        end loop;
      end $$`);
  } catch {
    // The pool may already be closed or the session aborted.
  }
}

function tableName(): string {
  return `okm_${Math.random().toString(36).slice(2, 10)}`;
}

function insert(table: string, id: number, column = "id"): Statement {
  return { text: `INSERT INTO ${table} (${column}) VALUES (${String(id)})` };
}

async function countOf(pool: DriverPool, table: string): Promise<string | null> {
  return scalar(pool, `SELECT count(*)::text FROM ${table}`);
}

async function scalar(
  runner: { execute(text: string, params?: readonly (string | null)[]): Promise<ExecuteResult> },
  text: string,
  params?: readonly (string | null)[],
): Promise<string | null> {
  const result = await runner.execute(text, params);
  return result.rows[0]?.[0] ?? null;
}

async function failure(pending: Promise<unknown>): Promise<DriverError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof DriverError || error instanceof OkmError) return error as DriverError;
    throw error;
  }
  throw new DriverError("expected the call to fail");
}

function mustReserve(pool: DriverPool): Promise<{
  execute(text: string, params?: readonly (string | null)[]): Promise<ExecuteResult>;
  batch(
    statements: readonly Statement[],
    options?: { readonly signal?: AbortSignal; readonly timeout?: number },
  ): Promise<readonly ExecuteResult[]>;
  release(): Promise<void>;
}> {
  if (pool.reserve === undefined) return Promise.reject(new DriverError("reserve is not declared"));
  return pool.reserve();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
