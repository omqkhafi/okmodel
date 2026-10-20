/**
 * Neon adapter shape.
 *
 * These cases do not open a socket. Live Neon cases are in `neon-live.test.ts`
 * and skip when the credentials are unset.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { open } from "../src/adapters/pg/neon.js";
import { httpCapabilities, capabilities } from "../src/runtime/pg/neon.js";

test("websocket mode is interactive and does not claim session features", () => {
  expect(capabilities).toEqual({
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  });
});

test("http mode is batch and has no interactive transaction", async () => {
  expect(httpCapabilities).toEqual({
    transactions: "batch",
    stream: false,
    listen: false,
    cancel: false,
  });
  const pool = await open({ url: "postgres://localhost/okm", mode: "http" });
  expect("reserve" in pool).toBe(false);
  expect("listen" in pool).toBe(false);
  expect("stream" in pool).toBe(false);
  const error = await failure(pool.execute("select 1", undefined, { timeout: 5 }));
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) expect(error.code).toBe("OKM1120");
  await pool.close();
  expect(await failure(pool.execute("select 1"))).toBeInstanceOf(Error);
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}
