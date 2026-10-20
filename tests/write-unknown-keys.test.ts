/**
 * Unknown keys on write input are refused (B-39).
 *
 * The message names the key and the table. Guarded, sealed, and computed
 * fields keep their existing codes.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { timestamps } from "../src/runtime/traits/index.js";

const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c41";

const notes = table(
  "notes",
  {
    id: id({ default: "none" }),
    title: text(),
    role: text().guarded(),
  },
  { traits: [timestamps()] },
);

const app = schema({ casing: "snake", tables: [notes] });

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

test("B-39: insert, update, upsert, and first-or-create refuse an unknown key", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;

  const insert = await codeOf(() =>
    db.notes.insert({ id: NOTE, title: "a", nope: 5 } as never).sql(),
  );
  expect(insert.code).toBe("OKM1120");
  expect(insert.message).toContain("nope");
  expect(insert.message).toContain("notes");

  const update = await codeOf(() =>
    db.notes.update({ where: { id: NOTE }, set: { title: "b", nope: 5 } as never }).sql(),
  );
  expect(update.code).toBe("OKM1120");
  expect(update.message).toContain("nope");
  expect(update.message).toContain("notes");

  const upsert = await codeOf(() =>
    db.notes
      .insert({ id: NOTE, title: "c", nope: 1 } as never, {
        onConflict: { on: "id", update: ["title"] },
      })
      .sql(),
  );
  expect(upsert.code).toBe("OKM1120");
  expect(upsert.message).toContain("nope");

  const first = await codeOf(() =>
    db.notes
      .insert({ id: NOTE, title: "d", nope: true } as never, {
        onConflict: { on: "id", return: true },
      })
      .sql(),
  );
  expect(first.code).toBe("OKM1120");
  expect(first.message).toContain("nope");

  const list = await codeOf(() =>
    db.notes.update([{ where: { id: NOTE }, set: { title: "e", extra: 1 } as never }]).sql(),
  );
  expect(list.code).toBe("OKM1120");
  expect(list.message).toContain("extra");
});

test("B-39: known keys, defaults, and sealed fields keep prior behaviour", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;

  const ok = await db.notes.insert({ id: NOTE, title: "ok" }).sql();
  expect(ok.statements[0]?.text).toContain("insert");

  const guarded = await codeOf(() =>
    db.notes.insert({ id: NOTE, title: "g", role: "admin" } as never).sql(),
  );
  expect(guarded.code).toBe("OKM1190");

  const sealed = await codeOf(() =>
    db.notes
      .insert({
        id: NOTE,
        title: "s",
        createdAt: Temporal.Instant.from("2020-01-02T03:04:05Z"),
      } as never)
      .sql(),
  );
  expect(sealed.code).toBe("OKM1190");
});
