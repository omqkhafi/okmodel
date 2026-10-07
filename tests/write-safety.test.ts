/**
 * A where with no effective predicate is the same as `{}` (D210).
 *
 * Reads still match every row. `delete` and `update` are OKM1102.
 * `.all(reason)` stays the way to name that on purpose.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { eq, has, id, many, not, or, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { tag } from "../src/dialects/pg/operators.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { effectivePredicate } from "../src/runtime/plan.js";
import { app as archiveApp } from "./archive-schema.js";

const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";

const comments = table("comments", {
  id: id({ default: "none" }),
  noteId: uuid().references("notes"),
  body: text(),
});

const notes = table(
  "notes",
  { id: id({ default: "none" }), title: text() },
  { relations: { comments: many("comments", "noteId") } },
);

const app = schema({ casing: "snake", tables: [notes, comments] });

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
    prepared: "unnamed",
    describe: false,
  },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

function client() {
  return connect(pool, { schema: app });
}

async function codeOf(run: () => unknown): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected a refusal");
}

test("QA-C1: undefined-only where is OKM1102", async () => {
  const db = client();
  await db.connected;
  const deleted = await codeOf(() => db.notes.delete({ where: { id: undefined } }));
  expect(deleted.code).toBe("OKM1102");
  const updated = await codeOf(() =>
    db.notes.update({ where: { id: undefined, title: undefined }, set: { title: "x" } }),
  );
  expect(updated.code).toBe("OKM1102");
  const listed = await codeOf(() =>
    db.notes.update([{ where: { title: undefined }, set: { title: "x" } }]),
  );
  expect(listed.code).toBe("OKM1102");
  const kept = await db.notes.delete({}).all("reset notes").sql();
  expect(kept.statements[0]?.text.includes("where true")).toBe(false);
  const one = await db.notes.update({ where: { id: NOTE }, set: { title: "next" } }).sql();
  expect(one.statements[0]?.text).toContain('"id" = ');
});

test("QA-C1: a read with only undefined matches the empty where", async () => {
  const db = client();
  await db.connected;
  const empty = db.notes.find({ where: {}, limit: 1 }).sql();
  const missing = db.notes.find({ where: { id: undefined, title: undefined }, limit: 1 }).sql();
  if (empty instanceof Promise || missing instanceof Promise) {
    throw new Error("a read without include plans synchronously");
  }
  expect(missing.text).toBe(empty.text);
  expect(missing.text.includes("where")).toBe(false);
  const oneEmpty = db.notes.one({ where: {} }).sql();
  const oneMissing = db.notes.one({ where: { id: undefined } }).sql();
  if (oneEmpty instanceof Promise || oneMissing instanceof Promise) {
    throw new Error("one() planned asynchronously");
  }
  expect(oneMissing.text).toBe(oneEmpty.text);
});

test("QA-H1: an or() branch with no predicate is OKM1121", async () => {
  const db = client();
  await db.connected;
  for (const where of [or([{}]), or([{ id: undefined }]), or([{ id: NOTE }, {}])]) {
    const read = await codeOf(() => db.notes.find({ where, limit: 1 }).sql());
    expect(read.code).toBe("OKM1121");
    expect(read.message).toContain("or() branch is empty");
    const write = await codeOf(() => db.notes.delete({ where }));
    expect(write.code).toBe("OKM1121");
    expect(write.message).toContain("or() branch is empty");
  }
  const none = db.notes.find({ where: or([]), limit: 1 }).sql();
  if (none instanceof Promise) throw new Error("or([]) planned asynchronously");
  expect(none.text).toContain("where false");
  const nested = await codeOf(() =>
    db.notes.find({ where: { comments: has(or([{}])) }, limit: 1 }).sql(),
  );
  expect(nested.code).toBe("OKM1121");
  const kept = db.notes.find({ where: or([{ title: "a" }, { title: "b" }]), limit: 1 }).sql();
  if (kept instanceof Promise) throw new Error("or planned asynchronously");
  expect(kept.text).toContain(" or ");
});

test("QA-M4: or() without one array is OKM1121", async () => {
  const spread = or as (left: unknown, right?: unknown) => unknown;
  for (const run of [
    () => spread({ id: NOTE }, { title: "a" }),
    () => spread([{ id: NOTE }], { title: "b" }),
    () => (or as () => unknown)(),
    () => spread("nope"),
  ]) {
    const error = await codeOf(run);
    expect(error.code).toBe("OKM1121");
    expect(error.message).toContain("Pass an array: or([a, b])");
  }
  const db = client();
  await db.connected;
  const planned = await codeOf(() =>
    db.notes.find({ where: tag("or", { id: NOTE }), limit: 1 }).sql(),
  );
  expect(planned.code).toBe("OKM1121");
  expect(planned.message).toContain("Pass an array: or([a, b])");
  expect(planned.message.includes("false")).toBe(false);
});

test("QA-H2: archive and restore refuse an undefined-only where", async () => {
  const db = connect(pool, { schema: archiveApp });
  await db.connected;
  const archived = await codeOf(() => db.lists.archive({ where: { id: undefined } }).sql());
  expect(archived.code).toBe("OKM1102");
  const restored = await codeOf(() => db.lists.restore({ where: { name: undefined } }));
  expect(restored.code).toBe("OKM1102");
  const branch = await codeOf(() => db.lists.archive({ where: or([{}]) }));
  expect(branch.code).toBe("OKM1121");
  const every = await db.lists.archive({}).all("clear the inbox").sql();
  expect(every.statements[0]?.text.includes("and true")).toBe(false);
  expect(every.statements[0]?.text).toContain("archived_at");
});

test("effective predicate ignores undefined through and, not, relations, and operators", () => {
  expect(effectivePredicate(undefined)).toBe(false);
  expect(effectivePredicate({})).toBe(false);
  expect(effectivePredicate({ id: undefined })).toBe(false);
  expect(effectivePredicate({ id: undefined, title: undefined })).toBe(false);
  expect(effectivePredicate({ id: NOTE, title: undefined })).toBe(true);
  expect(effectivePredicate(tag("and", [{ id: undefined }, { title: undefined }]))).toBe(false);
  expect(effectivePredicate(tag("and", [{ id: undefined }, { title: "next" }]))).toBe(true);
  expect(effectivePredicate(tag("and", []))).toBe(false);
  expect(effectivePredicate(not(undefined))).toBe(false);
  expect(effectivePredicate(not(null))).toBe(true);
  expect(effectivePredicate({ title: not("x") })).toBe(true);
  expect(effectivePredicate({ title: not(undefined) })).toBe(false);
  expect(effectivePredicate({ comments: has({}) })).toBe(true);
  expect(effectivePredicate({ comments: has({ body: undefined }) })).toBe(true);
  expect(effectivePredicate({ comments: undefined })).toBe(false);
  expect(effectivePredicate({ title: eq("next") })).toBe(true);
  expect(effectivePredicate({ title: eq(undefined) })).toBe(true);
});
