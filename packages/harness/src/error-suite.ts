/**
 * Error-mapping conformance.
 *
 * The same constraint, timeout, cancel, and connection cases run on any
 * adapter. The adapter returns a `DriverError`. `mapPostgresError` turns it
 * into an `OkmError`.
 */

import { expect } from "bun:test";

import type { DriverCapabilities, DriverPool, Statement } from "../../../src/contracts/driver.js";
import { OkmError, type ErrorKind } from "../../../src/contracts/error.js";
import { mapPostgresError } from "../../../src/dialects/pg/errors.js";
import type { SuiteTest } from "./driver-suite.js";

/** What one adapter run needs. */
export type ErrorSuite = {
  /** Name used in test titles. */
  readonly name: string;
  /** Pool for the cases. The caller closes it per test. */
  readonly open: () => DriverPool | Promise<DriverPool>;
  /** Flags. An in-flight timeout runs only when `cancel` is set. */
  readonly capabilities: DriverCapabilities;
  /** Test registrar. Postgres passes the shared skip rule. */
  readonly test: SuiteTest;
};

/**
 * Registers the error-mapping cases.
 *
 * @param suite - The adapter under test
 */
export function registerErrorMappingSuite(suite: ErrorSuite): void {
  const { name, test } = suite;
  const optional = (flag: boolean): SuiteTest => (flag ? test : skipped(test));

  test(`${name} maps a unique violation`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      await pool.execute(`CREATE TABLE ${table} (email text)`);
      await pool.execute(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_email_taken_key UNIQUE (email)`,
      );
      await pool.execute(`INSERT INTO ${table} (email) VALUES ('ada@example.com')`);
      const error = await mapped(
        pool.execute(`INSERT INTO ${table} (email) VALUES ('ada@example.com')`),
      );
      expectKind(error, "unique", 409, false);
      expect(error.table).toBe(table);
      expect(error.columns).toEqual(["email"]);
      expect(error.fields()).toEqual({ email: "email_taken" });
      expect(error.summary).toBe(`Unique violation on ${table}.email (email_taken)`);
      expect(error.batchIndex).toBe(null);
      expectNoValue(error, "ada@example.com");
    });
  });

  test(`${name} maps a not-null violation`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      await pool.execute(`CREATE TABLE ${table} (email text NOT NULL)`);
      const error = await mapped(pool.execute(`INSERT INTO ${table} (email) VALUES (NULL)`));
      expectKind(error, "not_null", 422, false);
      expect(error.table).toBe(table);
      expect(error.columns).toEqual(["email"]);
      expect(error.fields()).toEqual({ email: "not_null" });
    });
  });

  test(`${name} maps a check violation`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      await pool.execute(`CREATE TABLE ${table} (n int)`);
      await pool.execute(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_positive_check CHECK (n > 0)`,
      );
      const error = await mapped(pool.execute(`INSERT INTO ${table} (n) VALUES (0)`));
      expectKind(error, "check", 422, false);
      expect(error.table).toBe(table);
      expect(error.fields()).toEqual({});
      expect(error.summary).toContain("positive");
    });
  });

  test(`${name} maps a foreign key violation`, async () => {
    await using(suite.open, async (pool) => {
      const parent = tableName();
      const child = tableName();
      await pool.execute(`CREATE TABLE ${parent} (id int PRIMARY KEY)`);
      await pool.execute(`CREATE TABLE ${child} (list_id int)`);
      await pool.execute(
        `ALTER TABLE ${child} ADD CONSTRAINT ${child}_list_id_fkey FOREIGN KEY (list_id) REFERENCES ${parent} (id)`,
      );
      const error = await mapped(pool.execute(`INSERT INTO ${child} (list_id) VALUES (1)`));
      expectKind(error, "foreign_key", 422, false);
      expect(error.table).toBe(child);
      expect(error.columns).toEqual(["list_id"]);
      expect(error.fields()).toEqual({ list_id: "list_id" });
      expectNoValue(error, "(1)");
    });
  });

  test(`${name} maps an exclusion violation`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      await pool.execute(`CREATE TABLE ${table} (r int4range)`);
      await pool.execute(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_span_excl EXCLUDE USING gist (r WITH &&)`,
      );
      await pool.execute(`INSERT INTO ${table} (r) VALUES ('[1,5)')`);
      const error = await mapped(pool.execute(`INSERT INTO ${table} (r) VALUES ('[4,6)')`));
      expectKind(error, "exclusion", 409, false);
      expect(error.table).toBe(table);
      expect(error.columns).toEqual(["r"]);
      expectNoValue(error, "[4,6)");
    });
  });

  test(`${name} maps serialization, deadlock, and lock timeout`, async () => {
    await using(suite.open, async (pool) => {
      const serialization = await mapped(raise(pool, "40001"));
      expectKind(serialization, "serialization", 503, true);
      const deadlock = await mapped(raise(pool, "40P01"));
      expectKind(deadlock, "deadlock", 503, true);
      const lockTimeout = await mapped(raise(pool, "55P03"));
      expectKind(lockTimeout, "lock_timeout", 503, true);
    });
  });

  test(`${name} maps a statement timeout`, async () => {
    await using(suite.open, async (pool) => {
      const error = await mapped(pool.execute("SELECT 1", undefined, { timeout: 0 }));
      expectKind(error, "timeout", 503, true);
      expect(error.kind).not.toBe("cancelled");
    });
  });

  optional(suite.capabilities.cancel)(
    `${name} maps an in-flight statement timeout`,
    async () => {
      await using(suite.open, async (pool) => {
        const error = await mapped(pool.execute("SELECT pg_sleep(5)", undefined, { timeout: 80 }));
        expectKind(error, "timeout", 503, true);
      });
    },
    10_000,
  );

  test(`${name} maps a cancelled call and does not retry it`, async () => {
    await using(suite.open, async (pool) => {
      const error = await mapped(
        pool.execute("SELECT 1", undefined, { signal: AbortSignal.abort() }),
      );
      expectKind(error, "cancelled", 503, false);
      expect(error.fix.summary).toContain("Do not retry");
    });
  });

  test(`${name} maps a connection failure`, async () => {
    const pool = await suite.open();
    await pool.close();
    const error = await mapped(pool.execute("SELECT 1"));
    expectKind(error, "unavailable", 503, true);
  });

  test(`${name} carries batchIndex on a batch failure and null at commit`, async () => {
    await using(suite.open, async (pool) => {
      const table = tableName();
      await pool.execute(`CREATE TABLE ${table} (email text)`);
      await pool.execute(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_email_taken_key UNIQUE (email)`,
      );
      const failed = await mapped(
        pool.batch([insert(table, "one@example.com"), insert(table, "one@example.com")]),
      );
      expect(failed.kind).toBe("unique");
      expect(failed.batchIndex).toBe(1);
      expectNoValue(failed, "one@example.com");

      const deferred = tableName();
      await pool.execute(`CREATE TABLE ${deferred} (n int)`);
      await pool.execute(
        `ALTER TABLE ${deferred} ADD CONSTRAINT ${deferred}_n_key UNIQUE (n) DEFERRABLE INITIALLY DEFERRED`,
      );
      const atCommit = await mapped(
        pool.batch([
          { text: `INSERT INTO ${deferred} (n) VALUES (1)` },
          { text: `INSERT INTO ${deferred} (n) VALUES (1)` },
        ]),
      );
      expect(atCommit.kind).toBe("unique");
      expect(atCommit.batchIndex).toBe(null);
    });
  });
}

function skipped(test: SuiteTest): SuiteTest {
  const register: SuiteTest = (name, fn, timeoutMs) => {
    test.skip(name, fn, timeoutMs);
  };
  register.skip = (name, fn, timeoutMs) => {
    test.skip(name, fn, timeoutMs);
  };
  return register;
}

async function using(
  open: () => DriverPool | Promise<DriverPool>,
  fn: (pool: DriverPool) => Promise<void>,
): Promise<void> {
  const pool = await open();
  try {
    await fn(pool);
  } finally {
    await pool.close();
  }
}

async function mapped(pending: Promise<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    return mapPostgresError(error);
  }
  throw new OkmError("driver", "expected the call to fail", { kind: "driver" });
}

function expectKind(error: OkmError, kind: ErrorKind, status: number, retryable: boolean): void {
  expect(error).toBeInstanceOf(OkmError);
  expect(error.kind).toBe(kind);
  expect(error.retryable).toBe(retryable);
  expect(error.toHttp().status).toBe(status);
  expect(error.toHttp().body.reason).toBe(error.summary);
}

function expectNoValue(error: OkmError, value: string): void {
  expect(error.message.includes(value)).toBe(false);
  expect(JSON.stringify(error.log()).includes(value)).toBe(false);
  expect(error.values()).toBeUndefined();
}

function raise(pool: DriverPool, sqlstate: string): Promise<unknown> {
  return pool.execute(`DO $$ BEGIN RAISE EXCEPTION 'okm' USING ERRCODE = '${sqlstate}'; END $$`);
}

function insert(table: string, email: string): Statement {
  return { text: `INSERT INTO ${table} (email) VALUES ('${email}')` };
}

let ids = 0;

function tableName(): string {
  ids += 1;
  return `okm_e${ids.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
