/**
 * Shared describe proof for PGlite and Postgres.
 */

import { expect } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { sqlStatements } from "../src/tooling/migrate/sql-lex.js";
import {
  attributeFacts,
  columnNullability,
  NULLABILITY_SQL,
} from "../src/tooling/describe/nullability.js";
import { resolvePgTypes } from "../src/tooling/describe/types.js";
import { FIXTURE_SQL, PROOF_CASES } from "./describe-fixture.js";

/**
 * Applies the fixture, one statement at a time.
 *
 * @param pool - Open pool
 */
export async function applyFixture(pool: DriverPool): Promise<void> {
  for (const statement of sqlStatements(FIXTURE_SQL)) await pool.execute(statement);
}

/**
 * Asserts the spike cases, the alias suffixes, and that describe does not run.
 *
 * @param pool - Pool whose `describe` returns table OID and attnum
 */
export async function expectProof(pool: DriverPool): Promise<void> {
  if (pool.describe === undefined) throw new Error("describe is not on the pool");
  for (const item of PROOF_CASES) {
    const described = await pool.describe(item.sql);
    const found = new Map<string, boolean>();
    for (const field of described.fields) {
      const facts =
        field.tableOid === 0 || field.attnum === 0
          ? undefined
          : attributeFacts(
              (await pool.execute(NULLABILITY_SQL, [String(field.tableOid), String(field.attnum)]))
                .rows[0] ?? [],
            );
      const decision = columnNullability(item.sql, field, facts);
      found.set(decision.name, decision.nullable);
    }
    for (const name of item.notNull) expect(found.get(name), item.sql).toBe(false);
    for (const name of item.nullable) expect(found.get(name), item.sql).toBe(true);
  }

  const left = await pool.execute("SELECT o.id FROM item i LEFT JOIN other o ON o.id = i.id");
  expect(left.rows[0]?.[0]).toBeNull();
  const right = await pool.execute("SELECT i.name FROM item i RIGHT JOIN other o ON o.id = i.id");
  expect(right.rows[0]?.[0]).toBeNull();

  await pool.describe("SELECT stamp()");
  const count = await pool.execute("SELECT count(*)::int4 FROM log");
  expect(count.rows[0]?.[0]).toBe("0");

  await expectSqlstate(pool, "SELECT * FROM missing_table", "42P01");
  await expectSqlstate(pool, "SELECT 1; SELECT 2", "42601");
}

async function expectSqlstate(pool: DriverPool, sql: string, code: string): Promise<void> {
  if (pool.describe === undefined) throw new Error("describe is not on the pool");
  try {
    await pool.describe(sql);
  } catch (error) {
    expect(sqlstate(error)).toBe(code);
    return;
  }
  throw new Error(`${sql} should have failed with ${code}`);
}

function sqlstate(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Asserts built-in, domain, enum, and array resolution for one connection.
 *
 * @param pool - Pool that can describe and run a catalog read
 */
export async function expectTypes(pool: DriverPool): Promise<void> {
  if (pool.describe === undefined) throw new Error("describe is not on the pool");
  const sql =
    "SELECT mood AS mood_col, pos AS pos_col, tags AS tags_col, $1::pos AS pos_param, $2::mood[] AS mood_array FROM item WHERE pos = $3";
  const described = await pool.describe(sql);
  const resolved = await resolvePgTypes(
    async (text) => (await pool.execute(text)).rows,
    [...described.fields.map((field) => field.typeOid), ...described.parameters],
  );
  const byName = new Map(
    described.fields.map((field) => [field.name, resolved.get(field.typeOid)]),
  );
  expect(byName.get("mood_col")).toEqual({ pgType: "mood", enumLabels: ["open", "closed"] });
  expect(byName.get("pos_col")).toEqual({ pgType: "integer" });
  expect(byName.get("tags_col")).toEqual({ pgType: "text[]" });
  expect(byName.get("pos_param")).toEqual({ pgType: "integer" });
  expect(byName.get("mood_array")).toEqual({ pgType: "mood[]", enumLabels: ["open", "closed"] });
  expect(resolved.get(described.parameters[0] ?? 0)).toEqual({ pgType: "integer" });
  expect(resolved.get(described.parameters[1] ?? 0)).toEqual({
    pgType: "mood[]",
    enumLabels: ["open", "closed"],
  });
  expect(resolved.get(described.parameters[2] ?? 0)).toEqual({ pgType: "integer" });
}
