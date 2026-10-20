/**
 * An include `select` that names a hidden column is refused.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/index.js";
import { id, many, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";

const notes = table(
  "notes",
  { id: id({ default: "none" }), title: text() },
  { relations: { secrets: many("secrets", "noteId") } },
);
const secrets = table("secrets", {
  id: id({ default: "none" }),
  noteId: uuid().references("notes"),
  body: text().hidden(),
});
const app = schema({ tables: [notes, secrets] });

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  },
  execute: () => Promise.resolve({ rows: [], count: 0, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

test("include select of a hidden column is OKM1120", async () => {
  const db = createClient(app, pool, { ownsPool: false });
  const hidden = await rejection(
    Promise.resolve(
      db.notes
        .find({
          include: { secrets: { select: ["body"] as never, limit: 5 } },
          limit: 1,
        })
        .sql(),
    ),
  );
  expect(hidden.code).toBe("OKM1120");
  expect(hidden.message).toContain("hidden");
  const shown = await db.notes
    .find({ include: { secrets: { select: ["id"], limit: 5 } }, limit: 1 })
    .sql();
  expect(shown.text).not.toContain("body");
  await db.close();
});

async function rejection(pending: Promise<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected a refusal");
}
