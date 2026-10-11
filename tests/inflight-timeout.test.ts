/**
 * Bun.sql and PGlite refuse a positive `timeout` (D224, D239).
 *
 * They cannot cancel a statement that is already running. `timeout: 0` stays
 * kind `timeout`. A `signal` on its own still runs.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { DriverError } from "../src/adapters/error.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openBun } from "../src/adapters/pg/bunsql.js";

test("PGlite throws OKM1120 for a positive timeout and still runs a signal", async () => {
  const pool = await openPglite();
  try {
    let thrown: unknown;
    try {
      await pool.execute("select 1", undefined, { timeout: 50 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OkmError);
    if (thrown instanceof OkmError) {
      expect(thrown.code).toBe("OKM1120");
      expect(thrown.kind).toBe("invalid");
      expect(thrown.message).toBe("timeout");
    }

    const immediate = await failure(pool.execute("select 1", undefined, { timeout: 0 }));
    expect(immediate).toBeInstanceOf(DriverError);
    if (immediate instanceof DriverError) expect(immediate.kind).toBe("timeout");

    const ran = await pool.execute("select 1", undefined, { signal: new AbortController().signal });
    expect(String(ran.rows[0]?.[0])).toBe("1");
  } finally {
    await pool.close();
  }
});

test("Bun.sql throws OKM1120 for a positive timeout", async () => {
  if (typeof Bun === "undefined" || typeof Bun.SQL !== "function") return;
  const pool = openBun({ url: "postgres://127.0.0.1:1/none", max: 1 });
  try {
    let thrown: unknown;
    try {
      await pool.execute("select 1", undefined, { timeout: 50 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OkmError);
    if (thrown instanceof OkmError) {
      expect(thrown.code).toBe("OKM1120");
      expect(thrown.kind).toBe("invalid");
    }
  } finally {
    await pool.close();
  }
});

async function failure(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}
