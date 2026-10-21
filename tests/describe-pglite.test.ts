/**
 * PGlite describe returns table OID and attnum, and the nullability rule holds.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import { applyFixture, expectProof, expectTypes } from "./describe-proof.js";

test("PGlite describes without executing and types the spike columns", async () => {
  const pool = await open();
  try {
    await applyFixture(pool);
    const described = await pool.describe!("SELECT name FROM item");
    const name = described.fields[0];
    expect(name?.name).toBe("name");
    expect(name?.tableOid).toBeGreaterThan(0);
    expect(name?.attnum).toBeGreaterThan(0);
    expect(described.parameters).toEqual([]);
    await expectProof(pool);
    await expectTypes(pool);
  } finally {
    await pool.close();
  }
}, 20_000);
