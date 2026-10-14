/**
 * Claim SQL and the operator checks that do not need a database (P93).
 *
 * `lock: "skip"` is one update. A read keeps `wait: "skip"`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { inc, integer, numeric, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { build as lockFind } from "../src/runtime/lock.js";
import { explainWrite } from "../src/runtime/write.js";

const jobs = table("jobs", {
  id: uuid(),
  status: text(),
  qty: integer().nullable(),
  title: text(),
});

const app = schema({ casing: "snake", tables: [jobs] });

const ID = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";

async function updateSql(input: object, options: object = {}): Promise<string> {
  const planned = await explainWrite(app, "update", "jobs", input, options, {});
  return planned.statements[0]?.text ?? "";
}

async function rejection(input: object): Promise<OkmError> {
  try {
    await explainWrite(app, "update", "jobs", input, {}, {});
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected a refusal");
}

test("a plain update does not claim, and lock: skip is one statement", async () => {
  const plain = await updateSql({ where: { id: ID }, set: { status: "running" } });
  expect(plain.startsWith('update "jobs" as t set ')).toBe(true);
  expect(plain).not.toContain("ctid");
  expect(plain).not.toContain("skip locked");

  const claimed = await updateSql({
    where: { status: "pending" },
    set: { status: "running", qty: inc(1) },
    limit: 10,
    lock: "skip",
  });
  expect(claimed).toContain('update "jobs" as t set ');
  expect(claimed).toContain('"status" = $1::text');
  expect(claimed).toContain('t."qty" + $2::integer');
  expect(claimed).not.toContain("coalesce");
  expect(claimed).toContain(
    'where (t.tableoid, t.ctid) in (select s.tableoid, s.ctid from "jobs" as s where s."status" = $3 for update of s skip locked limit $4::integer)',
  );
  expect(claimed.startsWith('update "jobs" as t set ')).toBe(true);

  const returned = await updateSql(
    { where: { status: "pending" }, set: { status: "running" }, limit: 1, lock: "skip" },
    { returning: ["id"] },
  );
  expect(returned.endsWith(' returning t."id"')).toBe(true);
});

test("inc on text is refused before a statement, in developer terms", async () => {
  const error = await rejection({ where: { id: ID }, set: { title: inc(1) } });
  expect(error.code).toBe("OKM1124");
  expect(error.message).toBe("inc adds to a number. title is a text column.");
  expect(error.message).not.toContain("+");
  expect(error.message.toLowerCase()).not.toContain("sql");
});

test("a list cannot mix a value and an operator on one field", async () => {
  const error = await rejection([
    { id: ID, set: { qty: inc(1) } },
    { id: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02", set: { qty: 5 } },
  ]);
  expect(error.code).toBe("OKM1120");
  expect(error.message).toBe("qty is both inc and a value in this update.");
  expect(error.fix?.summary).toBe("Use one value or one operator for qty in every row.");
});

test("the same operator on every row of a list is one update", async () => {
  const text = await updateSql([
    { id: ID, set: { qty: inc(1) } },
    { id: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02", set: { qty: inc(2) } },
  ]);
  expect(text.startsWith('update "jobs" as t set ')).toBe(true);
  expect(text).toContain('t."qty" + ');
  expect(text).not.toContain("skip locked");
});

test("a repeated target is still refused when the sets use inc", async () => {
  const error = await rejection([
    { id: ID, set: { qty: inc(1) } },
    { where: { id: ID }, set: { qty: inc(2) } },
  ]);
  expect(error.code).toBe("OKM1120");
  expect(error.message).toBe("update on jobs lists the same target twice.");
});

test("lock and limit are a pair, and wait stays on a read", async () => {
  const missing = await rejection({
    where: { id: ID },
    set: { status: "running" },
    lock: "skip",
  });
  expect(missing.code).toBe("OKM1120");
  expect(missing.message).toBe('lock: "skip" needs a limit.');

  const bare = await rejection({
    where: { id: ID },
    set: { status: "running" },
    limit: 1,
  });
  expect(bare.message).toBe('limit on an update needs lock: "skip".');

  const nowait = await rejection({
    where: { id: ID },
    set: { status: "running" },
    limit: 1,
    lock: "nowait",
  });
  expect(nowait.message).toContain('lock on an update must be "skip".');
  expect(nowait.message).not.toContain("NOWAIT");

  const wait = await rejection({
    where: { id: ID },
    set: { status: "running" },
    wait: "skip",
  });
  expect(wait.message).toBe('wait belongs on a read. An update claims rows with lock: "skip".');

  const zero = await rejection({
    where: { id: ID },
    set: { status: "running" },
    limit: 0,
    lock: "skip",
  });
  expect(zero.code).toBe("OKM1121");
});

test("inc on a numeric column stored as text still adds", async () => {
  const priced = table("priced", { id: uuid(), amount: numeric() });
  const pricedApp = schema({ casing: "snake", tables: [priced] });
  const planned = await explainWrite(
    pricedApp,
    "update",
    "priced",
    { where: { id: ID }, set: { amount: inc("1") } },
    {},
    {},
  );
  expect(planned.statements[0]?.text).toContain('t."amount" + $1::numeric');
});

test('find rejects lock: "skip" and names the read form', () => {
  let caught: unknown;
  try {
    void lockFind({ pool: {} } as never, "jobs", { lock: "skip", limit: 1 }, {}, undefined);
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    code: "OKM1120",
    message: 'lock: "skip" claims rows on update. A read uses lock: "update" and wait: "skip".',
  });
});
