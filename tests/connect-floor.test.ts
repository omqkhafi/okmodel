/**
 * `connect()` refuses a Postgres older than 15 unless the schema opts in.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";

const app = schema({ tables: [table("items", { id: t.identity(), name: t.text() })] });

test("connect refuses PostgreSQL 14 and accepts a declared older major", async () => {
  const refused = createClient(app, fakePool("140000", "PostgreSQL 14.13"), { ownsPool: false });
  const error = await refused.connected.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ code: "OKM1803" });
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) {
    expect(error.message).toContain("PostgreSQL 14");
    expect(error.message).toContain("15");
  }

  const opted = schema({
    requires: { postgres: ">=13" },
    tables: [table("items", { id: t.identity(), name: t.text() })],
  });
  const allowed = createClient(opted, fakePool("130000", "PostgreSQL 13.16"), {
    ownsPool: false,
  });
  await allowed.connected;

  const current = createClient(app, fakePool("150000", "PostgreSQL 15.8"), { ownsPool: false });
  await current.connected;

  const newer = schema({
    requires: { postgres: ">=18" },
    tables: [table("items", { id: t.identity(), name: t.text() })],
  });
  const behind = createClient(newer, fakePool("150000", "PostgreSQL 15.8"), { ownsPool: false });
  const behindError = await behind.connected.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(behindError).toMatchObject({ code: "OKM1802" });
});

function fakePool(versionNum: string, label: string): DriverPool {
  return {
    capabilities: {
      transactions: "none",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "none",
      describe: false,
    },
    execute() {
      return Promise.resolve({ rows: [[versionNum, label, null]], count: 1, notices: [] });
    },
    batch() {
      return Promise.resolve([]);
    },
    stats() {
      return { size: 0, idle: 0, inflight: 0, waiting: 0 };
    },
    close() {
      return Promise.resolve();
    },
  };
}
