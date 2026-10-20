/**
 * Unknown write keys with validation on (R1) — mock pool.
 *
 * Typo-only update names the key; it must not say "update set is empty."
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { v } from "../src/runtime/validate/index.js";

const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c61";

const notes = table(
  "notes",
  {
    id: id({ default: "none" }),
    title: text().validate([v.min(1, "title_required")]),
  },
  { validation: true },
);

const app = schema({ casing: "snake", tables: [notes], validation: true });

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

async function codeOf(run: () => unknown): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected a refusal");
}

test("R1: validation true refuses unknown keys on insert and update", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;

  const insert = await codeOf(() =>
    db.notes.insert({ id: NOTE, title: "a", nope: 5 } as never).sql(),
  );
  expect(insert.code).toBe("OKM1120");
  expect(insert.message).toContain("nope");
  expect(insert.message).toContain("notes");

  const mixed = await codeOf(() =>
    db.notes.update({ where: { id: NOTE }, set: { title: "b", nope: 5 } as never }).sql(),
  );
  expect(mixed.code).toBe("OKM1120");
  expect(mixed.message).toContain("nope");

  const typo = await codeOf(() =>
    db.notes.update({ where: { id: NOTE }, set: { titl: "x" } as never }).sql(),
  );
  expect(typo.code).toBe("OKM1120");
  expect(typo.message).toContain("titl");
  expect(typo.message).toContain("notes");
  expect(typo.message).not.toContain("update set is empty");
  expect(typo.message).toContain("Did you mean");
});
