/**
 * A statement over 65,533 parameters is OKM1126 before it reaches the driver (B-40, B-48).
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { id, inList, schema, table, text } from "../src/dialects/pg/index.js";
import { PG_PARAM_LIMIT } from "../src/runtime/param-limit.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
});
const app = schema({ casing: "snake", tables: [notes] });

function stubPool(): DriverPool {
  let checked = false;
  return {
    capabilities: {
      transactions: "interactive",
      stream: false,
      listen: false,
      cancel: false,
    },
    execute: () => {
      if (!checked) {
        checked = true;
        return Promise.resolve({
          rows: [["170000", "PostgreSQL 17"]],
          count: 1,
          notices: [],
        });
      }
      return Promise.resolve({ rows: [], count: 0, notices: [] });
    },
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  } as DriverPool;
}

function ids(count: number): string[] {
  const out = Array.from({ length: count }, (_, index) => {
    return `01890c5a-8f0e-7c3a-9b2d-${String(index).padStart(12, "0")}`;
  });
  return out;
}

test("B-48: exactly 65533 parameters run; 65534 is OKM1126 with the count", async () => {
  const db = connect(stubPool(), { schema: app });
  await db.connected;

  const atLimit = await db.notes.find({
    where: { id: inList(ids(PG_PARAM_LIMIT - 1)) },
    limit: 1,
  });
  expect(Array.isArray(atLimit)).toBe(true);

  const over = await db.notes.find({ where: { id: inList(ids(PG_PARAM_LIMIT)) }, limit: 1 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(over).toBeInstanceOf(OkmError);
  if (over instanceof OkmError) {
    expect(over.code).toBe("OKM1126");
    expect(over.kind).toBe("invalid");
    expect(over.retryable).toBe(false);
    expect(over.message).toContain(String(PG_PARAM_LIMIT + 1));
    expect(over.message).toContain(String(PG_PARAM_LIMIT));
    expect(over.fix.summary.toLowerCase()).toContain("chunk");
  }
});

test("B-40: inList plus other filters counts every parameter", async () => {
  const db = connect(stubPool(), { schema: app });
  await db.connected;

  const ok = await db.notes.find({
    where: { id: inList(ids(PG_PARAM_LIMIT - 2)), title: "x" },
    limit: 1,
  });
  expect(Array.isArray(ok)).toBe(true);

  const over = await db.notes
    .find({
      where: { id: inList(ids(PG_PARAM_LIMIT - 1)), title: "x" },
      limit: 1,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(over).toBeInstanceOf(OkmError);
  if (over instanceof OkmError) {
    expect(over.code).toBe("OKM1126");
    expect(over.message).toContain(String(PG_PARAM_LIMIT + 1));
  }
});
