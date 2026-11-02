/**
 * Bun.sql read recovery on a raw `open()` pool.
 *
 * Bun 1.4.4 can report the socket close before the 57P01 rejection, so
 * `closedDuring` is true for a statement the server ended while it ran.
 */

import { expect, test } from "bun:test";

import type { SQL } from "../src/adapters/pg/bun-sql.js";
import { recover } from "../src/adapters/pg/bunsql-extra.js";
import { DriverError } from "../src/adapters/error.js";

const live = { unsafe: () => Promise.resolve([]) } as unknown as SQL;

async function outcome(error: unknown, closedDuring: boolean): Promise<string> {
  let again = 0;
  try {
    await recover(live, error, "select pg_sleep(30)", 0, false, closedDuring, () => {
      again += 1;
      return Promise.resolve("again");
    });
    return `ran again ${String(again)}`;
  } catch (caught) {
    return caught === error ? "rethrown" : `other ${String(caught)}`;
  }
}

test("a read the server terminated is not run again when the close is seen first", async () => {
  const terminated = new DriverError("terminating connection due to administrator command", {
    sqlstate: "57P01",
  });
  expect(await outcome(terminated, true)).toBe("rethrown");
  expect(await outcome(terminated, false)).toBe("rethrown");
});

test("a read sent on a socket that was already closed is tried once", async () => {
  expect(await outcome(new Error("Connection closed"), false)).toBe("ran again 1");
});
