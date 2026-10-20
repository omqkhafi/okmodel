/**
 * A typed function call is a `sql` fragment.
 *
 * Rows on real Postgres are `builder-fn-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { fragment, ident, schema, table, text, integer } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const notes = table("notes", { id: text(), title: text(), n: integer() });
const app = schema({ tables: [notes] });

const slugify = fn("slugify", {
  arguments: [{ name: "title", type: "text" }],
  returns: "text",
  language: "sql",
  body: "select lower(title)",
});

const double = fn("double_n", {
  arguments: [{ name: "n", type: "integer" }],
  returns: "integer",
  language: "sql",
  body: "select n * 2",
});

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

type Statement = { readonly text: string; readonly params: readonly (string | null)[] };

async function planned(query: { sql: () => Statement | Promise<Statement> }): Promise<Statement> {
  return await Promise.resolve(query.sql());
}

test("a call is the predicate, and a nested call is a parameter comparison", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const where = await planned(
    db.notes.find({ where: { title: slugify(ident("title")) }, limit: 1 }),
  );
  expect(where.text).toContain('("public"."slugify"(t."title"))');
  const compared = await planned(
    db.notes.find({
      where: { title: fragment`${slugify(ident("title"))} = ${"hello"}` },
      limit: 1,
    }),
  );
  expect(compared.text).toContain('("public"."slugify"(t."title")) = $1');
  expect(compared.params).toEqual(["hello", "1"]);
  expect(compared.text.includes("hello")).toBe(false);
});

test("select names a text or numeric result", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const textSelect = await planned(
    db.notes.find({ select: ["id", slugify(ident("title")).as("slug")], limit: 1 }),
  );
  expect(textSelect.text).toContain('("public"."slugify"(t."title"))::text');
  const numeric = await planned(
    db.notes.find({ select: ["id", double(ident("n")).as("twice")], limit: 1 }),
  );
  expect(numeric.text).toContain('("public"."double_n"(t."n"))::text');
});

test("the wrong number of arguments is OKM1120", () => {
  const call = slugify as unknown as () => unknown;
  expect(() => call()).toThrow(OkmError);
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    expect((error as OkmError).code).toBe("OKM1120");
  }
});
