/**
 * node-postgres and Bun.sql return the same wire text as postgres.js.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import type { DriverPool, ExecuteResult } from "../src/contracts/driver.js";

const gate = await loadPostgresGate();

const QUERY = `
SELECT
  true AS b,
  false AS bf,
  NULL::int AS n,
  1::int2 AS i2,
  2::int4 AS i4,
  9223372036854775807::int8 AS i8,
  1.5::float4 AS f4,
  1.25::float8 AS f8,
  12345678901234567890.25::numeric AS num,
  'hi'::text AS txt,
  '\\x0001'::bytea AS bta,
  '{"a":1}'::json AS j,
  '{"a":1}'::jsonb AS jb,
  DATE '2020-01-02' AS d,
  TIMESTAMP '2020-01-02 03:04:05' AS ts,
  TIMESTAMPTZ '2020-01-02 03:04:05+00' AS tstz,
  '550e8400-e29b-41d4-a716-446655440000'::uuid AS u,
  ARRAY[1,2,3]::int[] AS ia,
  ARRAY[true,false]::bool[] AS ba
`;

postgresTest(gate, "node-postgres rows match postgres.js", async () => {
  await compare(openPg({ url: primaryUrl(), max: 1 }));
});

postgresTest(gate, "bun.sql rows match postgres.js", async () => {
  if (typeof Bun === "undefined" || typeof Bun.SQL !== "function") {
    throw new Error("Bun.sql runs only under Bun");
  }
  await compare(openBun({ url: primaryUrl(), max: 1 }));
});

postgresTest(gate, "node-postgres does not leave a named prepared statement", async () => {
  await expectUnnamed(openPg({ url: primaryUrl(), max: 1 }));
});

postgresTest(gate, "bun.sql does not leave a named prepared statement", async () => {
  if (typeof Bun === "undefined" || typeof Bun.SQL !== "function") {
    throw new Error("Bun.sql runs only under Bun");
  }
  await expectUnnamed(openBun({ url: primaryUrl(), max: 1 }));
});

/**
 * Compares one driver's rows to postgres.js for the column suite.
 *
 * @param other - The driver under test. This function closes it
 */
async function compare(other: DriverPool): Promise<void> {
  const reference = openPostgres({ url: primaryUrl(), max: 1 });
  try {
    const left = await reference.execute(QUERY);
    const right = await other.execute(QUERY);
    expect(right.rows).toEqual(left.rows);
    const bound = await other.execute("SELECT $1::int8, $2::numeric, $3::jsonb", [
      "9223372036854775807",
      "12345678901234567890.25",
      '{"a":1}',
    ]);
    const expected = await reference.execute("SELECT $1::int8, $2::numeric, $3::jsonb", [
      "9223372036854775807",
      "12345678901234567890.25",
      '{"a":1}',
    ]);
    expect(bound.rows).toEqual(expected.rows);
  } finally {
    await reference.close();
    await other.close();
  }
}

/**
 * A parameterized query on one connection leaves `pg_prepared_statements` empty.
 *
 * @param pool - The driver under test. This function closes it
 */
async function expectUnnamed(pool: DriverPool): Promise<void> {
  try {
    if (pool.reserve === undefined) throw new Error("reserve is not declared");
    const connection = await pool.reserve();
    try {
      await connection.execute("SELECT $1::int4", ["1"]);
      const count: ExecuteResult = await connection.execute(
        "SELECT count(*)::text FROM pg_prepared_statements",
      );
      expect(count.rows[0]?.[0]).toBe("0");
    } finally {
      await connection.release();
    }
  } finally {
    await pool.close();
  }
}
