/**
 * Composed fragments: nesting, parameter order, quoting, and the tenant predicate.
 *
 * Rows on real Postgres are `sql-fragment-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { fragment, ident, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { app as tenantApp, TENANT_A } from "./tenancy-schema.js";

const notes = table("notes", {
  id: text(),
  title: text(),
  status: text(),
});

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

type Statement = { readonly text: string; readonly params: readonly (string | null)[] };

async function planned(query: { sql: () => Statement | Promise<Statement> }): Promise<Statement> {
  return await Promise.resolve(query.sql());
}

test("a nested fragment binds parameters in order and quotes identifiers", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const open = fragment`${ident("status")} = ${"open"}`;
  const plannedQuery = await planned(
    db.notes.find({
      where: { title: fragment`length(${fragment.column}) > ${3} and ${open}` },
      limit: 1,
    }),
  );
  expect(plannedQuery.text).toContain('(length(t."title") > $1 and (t."status" = $2))');
  expect(plannedQuery.params).toEqual(["3", "open", "1"]);
  expect(plannedQuery.text.includes("open")).toBe(false);
  expect(plannedQuery.text.includes("> 3")).toBe(false);
});

test("two fragment shapes do not share one statement", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const title = await planned(
    db.notes.find({ where: { title: fragment`${ident("title")} = ${"a"}` }, limit: 1 }),
  );
  const status = await planned(
    db.notes.find({ where: { title: fragment`${ident("status")} = ${"a"}` }, limit: 1 }),
  );
  expect(title.text).not.toBe(status.text);
  expect(title.text).toContain('t."title"');
  expect(status.text).toContain('t."status"');
});

test("an injection attempt stays a parameter", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const payload = "'; drop table notes; --";
  const plannedQuery = await planned(
    db.notes.find({
      where: { title: fragment`${ident("title")} = ${payload}` },
      limit: 1,
    }),
  );
  expect(plannedQuery.text.includes("drop table")).toBe(false);
  expect(plannedQuery.text.includes(payload)).toBe(false);
  expect(plannedQuery.params[0]).toBe(payload);
  expect(plannedQuery.text).toContain('t."title" = $1');
});

test("a fragment keeps the tenant predicate", async () => {
  const db = connect(pool, { schema: tenantApp });
  await db.connected;
  const scoped = db.for({ tenantId: TENANT_A });
  const plannedQuery = await planned(
    scoped.tasks.find({
      where: { title: fragment`true or ${ident("tenantId")} is null` },
      limit: 1,
    }),
  );
  expect(plannedQuery.text).toContain('"tenant_id" = ');
  const tenantAt = plannedQuery.text.indexOf('"tenant_id" = ');
  const fragmentAt = plannedQuery.text.indexOf("(true or ");
  expect(tenantAt).toBeGreaterThan(-1);
  expect(fragmentAt).toBeGreaterThan(tenantAt);
  expect(plannedQuery.params[0]).toBe(TENANT_A);
  expect(plannedQuery.text.includes(TENANT_A)).toBe(false);
});

test("a fragment that would close the predicate is refused before SQL", () => {
  const closePredicate = (): unknown => fragment`true) or (true`;
  expect(closePredicate).toThrow(OkmError);
  let caught: unknown;
  try {
    closePredicate();
  } catch (error) {
    caught = error;
    expect(caught).toBeInstanceOf(OkmError);
    expect((caught as OkmError).code).toBe("OKM1125");
    expect((caught as OkmError).fix.summary.length).toBeGreaterThan(0);
  }
  expect(() => fragment`true; drop table notes`).toThrow(OkmError);
  expect(() => fragment`title = $1`).toThrow(OkmError);
  expect(() => fragment`true --`).toThrow(OkmError);
  expect(() => fragment`title = '${"x"}'`).toThrow(OkmError);
  expect(() => fragment``).toThrow(OkmError);
  expect(() => ident("")).toThrow(OkmError);
  try {
    ident("");
  } catch (error) {
    expect((error as OkmError).code).toBe("OKM1122");
  }
});

test("a backslash in fragment text is OKM1125", () => {
  const payloads = [
    () => fragment`${ident("title")} = E'\\'' ) or ( true or title = E'\\''`,
    () => fragment`${ident("title")} = E'\\''`,
    () => fragment`${ident("title")} = e'\\''`,
    () => fragment`${ident("title")} = '\\''`,
    () => fragment`${ident("title")} = '\\x27'`,
    () => fragment`${ident("title")} = 'a\\b'`,
  ] as const;
  for (const payload of payloads) {
    expect(payload).toThrow(OkmError);
    try {
      payload();
    } catch (error) {
      expect(error).toBeInstanceOf(OkmError);
      expect((error as OkmError).code).toBe("OKM1125");
      expect((error as OkmError).message).toBe("A fragment cannot include a backslash.");
      expect((error as OkmError).fix.summary).toBe("Pass the value as an interpolation.");
    }
  }
  // Doubled quotes and a U& string without a backslash stay accepted.
  expect(() => fragment`${ident("title")} = 'it''s'`).not.toThrow();
  expect(() => fragment`${ident("title")} = U&'!0041' UESCAPE '!'`).not.toThrow();
  // Dollar quotes, comments, and semicolons inside quotes are plain text.
  expect(() => fragment`${ident("title")} = '$tag$x$tag$'`).not.toThrow();
  expect(() => fragment`${ident("title")} = '-- not a comment'`).not.toThrow();
  expect(() => fragment`${ident("title")} = '/* not a comment */'`).not.toThrow();
  expect(() => fragment`${ident("title")} = ';'`).not.toThrow();
});

test("a select fragment is a number and names its key", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const plannedQuery = await planned(
    db.notes.find({
      select: ["id", fragment`length(${ident("title")})`.as("len")],
      where: { title: fragment`${fragment.column} <> ${"x"}` },
      limit: 2,
    }),
  );
  expect(plannedQuery.text).toContain('(length(t."title"))::text');
  expect(plannedQuery.text).toContain('(t."title" <> $1)');
  expect(plannedQuery.text.indexOf("length")).toBeLessThan(plannedQuery.text.indexOf("<>"));
  expect(plannedQuery.params).toEqual(["x", "2"]);
});

const exposed = table("notes", {
  id: text(),
  title: text().sqlName('a"b'),
  ownerId: text(),
  secret: text().hidden(),
  code: text().hidden({ filterable: true }),
});

const exposedApp = schema({ casing: "snake", tables: [exposed] });

test("ident resolves the field, quotes sqlName, and follows the hidden rule", async () => {
  const db = connect(pool, { schema: exposedApp });
  await db.connected;
  const quoted = await planned(
    db.notes.find({
      where: { id: fragment`${ident("title")} = ${"x"}` },
      limit: 1,
    }),
  );
  expect(quoted.text).toContain('t."a""b"');
  const cased = await planned(
    db.notes.find({
      where: { id: fragment`${ident("ownerId")} = ${"x"}` },
      limit: 1,
    }),
  );
  expect(cased.text).toContain('t."owner_id"');
  const filterable = await planned(
    db.notes.find({
      where: { id: fragment`${ident("code")} = ${"k"}` },
      limit: 1,
    }),
  );
  expect(filterable.text).toContain('t."code"');

  const hiddenWhere = await catchPlanned(
    db.notes.find({
      where: { id: fragment`${ident("secret")} = ${"x"}` },
      limit: 1,
    }),
  );
  expect(hiddenWhere.code).toBe("OKM1120");
  expect(hiddenWhere.message).toBe("Field secret is hidden.");
  expect(hiddenWhere.fix.summary).toBe("Call hidden({ filterable: true }).");

  const hiddenSelect = await catchPlanned(
    db.notes.find({
      select: ["id", fragment`length(${ident("secret")})`.as("len")],
      limit: 1,
    }),
  );
  expect(hiddenSelect.code).toBe("OKM1120");
  expect(hiddenSelect.message).toBe("Field secret is hidden.");

  const filterableSelect = await catchPlanned(
    db.notes.find({
      select: ["id", fragment`length(${ident("code")})`.as("len")],
      limit: 1,
    }),
  );
  expect(filterableSelect.code).toBe("OKM1120");
  expect(filterableSelect.message).toBe("Field code is hidden.");
  expect(filterableSelect.fix.summary).toBe("A select fragment cannot name a hidden field.");

  const unknown = await catchPlanned(
    db.notes.find({
      where: { id: fragment`${ident("owner_id")} = ${"x"}` },
      limit: 1,
    }),
  );
  expect(unknown.code).toBe("OKM1120");
  expect(unknown.message).toContain("Field owner_id is not on notes.");
  expect(unknown.fix.summary.length).toBeGreaterThan(0);
});

async function catchPlanned(query: {
  sql: () => Statement | Promise<Statement>;
}): Promise<OkmError> {
  try {
    await planned(query);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) return error;
  }
  throw new Error("expected OKM1120");
}
