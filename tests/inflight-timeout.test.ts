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
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";

const notes = table("notes", { id: t.integer().primaryKey() });
const app = schema({ tables: [notes] });

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

test("PGlite tx and batch refuse a positive timeout and still accept a signal", async () => {
  const db = await connectPglite(undefined, { schema: app });
  try {
    const timed = await failure(db.tx({ timeout: 50 }, async () => undefined));
    expect(timed).toBeInstanceOf(OkmError);
    if (timed instanceof OkmError) {
      expect(timed.code).toBe("OKM1120");
      expect(timed.kind).toBe("invalid");
      expect(timed.message).toBe("timeout");
    }
    const batched = await failure(db.batch([], { timeout: 50 }));
    expect(batched).toBeInstanceOf(OkmError);
    if (batched instanceof OkmError) {
      expect(batched.code).toBe("OKM1120");
      expect(batched.message).toBe("timeout");
    }
    const ran = await db.tx({ signal: new AbortController().signal }, async () => "ok");
    expect(ran).toBe("ok");
  } finally {
    await db.close();
  }
});

test("Bun.sql tx and batch refuse a positive timeout", async () => {
  if (typeof Bun === "undefined" || typeof Bun.SQL !== "function") return;
  const db = connectBun("postgres://127.0.0.1:1/none", { schema: app, max: 1 });
  try {
    const timed = await failure(db.tx({ timeout: 50 }, async () => undefined));
    expect(timed).toBeInstanceOf(OkmError);
    if (timed instanceof OkmError) {
      expect(timed.code).toBe("OKM1120");
      expect(timed.message).toBe("timeout");
    }
    const batched = await failure(db.batch([], { timeout: 50 }));
    expect(batched).toBeInstanceOf(OkmError);
    if (batched instanceof OkmError) expect(batched.code).toBe("OKM1120");
  } finally {
    await db.close();
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
