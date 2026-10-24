/**
 * A new column's default or NULL against the check that will validate it.
 */

import { expect, test } from "bun:test";

import { schema, sql, table, t } from "../src/dialects/pg/index.js";
import { checkRejectsNull, defaultViolatesCheck } from "../src/tooling/migrate/check-value.js";
import { lintPlan } from "../src/tooling/migrate/lint.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

test("a literal default fails an IN check, and a listed value does not", () => {
  expect(defaultViolatesCheck("status", "'nope'", "(status IN ('a', 'b'))")).toBe(true);
  expect(defaultViolatesCheck("status", "'a'", "(status IN ('draft', 'a'))")).toBe(false);
  expect(defaultViolatesCheck("n", "0", "(n > 0)")).toBe(true);
  expect(defaultViolatesCheck("n", "1", "(n > 0)")).toBe(false);
  expect(defaultViolatesCheck("status", "'a'::text", "(status = 'a')")).toBe(false);
});

test("NULL fails IS NOT NULL and passes an IN check", () => {
  expect(checkRejectsNull("status", "status IS NOT NULL")).toBe(true);
  expect(checkRejectsNull("status", "(status IN ('a', 'b'))")).toBe(false);
  expect(checkRejectsNull("status", "coalesce(status, '') <> ''")).toBe(true);
});

test("adding a column whose default fails its check is OKM1531", () => {
  const before = schema({
    tables: [table("tasks", { id: t.integer().primaryKey(), title: t.text() })],
  });
  const violating = schema({
    tables: [
      table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text(),
          status: t.text().default("nope"),
        },
        { checks: { ok: (columns) => sql`${columns.status} IN ('a', 'b')` } },
      ),
    ],
  });
  expect(codes(before, violating)).toContain("OKM1531");

  const listed = schema({
    tables: [
      table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text(),
          status: t.text().default("a"),
        },
        { checks: { ok: (columns) => sql`${columns.status} IN ('a', 'b')` } },
      ),
    ],
  });
  expect(codes(before, listed)).not.toContain("OKM1531");

  const rejectsNull = schema({
    tables: [
      table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text(),
          status: t.text().nullable(),
        },
        { checks: { present: (columns) => sql`${columns.status} IS NOT NULL` } },
      ),
    ],
  });
  expect(codes(before, rejectsNull)).toContain("OKM1531");
});

test("a write or a volatile default between ADD COLUMN and VALIDATE is OKM1531", () => {
  const before = schema({
    tables: [table("tasks", { id: t.integer().primaryKey(), title: t.text() })],
  });
  const after = schema({
    tables: [
      table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text(),
          status: t.text().default("a"),
        },
        { checks: { ok: (columns) => sql`${columns.status} IN ('a', 'b')` } },
      ),
    ],
  });
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: "add" });
  expect(codesOf(plan, before, after)).not.toContain("OKM1531");

  const validate = plan.steps.find((step) => /validate constraint/i.test(step.sql));
  const tableSql = /^alter table\s+(\S+)\s+validate constraint/i.exec(validate?.sql ?? "")?.[1];
  expect(tableSql).toBeDefined();
  const update = {
    sql: `update ${tableSql} set "status" = 'nope'`,
    class: "expand" as const,
    action: "backfill" as const,
    lock: "",
    transactional: true,
    backfill: { table: tableSql ?? "", key: ['"id"'], batch: 100 },
  };
  const withUpdate = {
    ...plan,
    steps: plan.steps.flatMap((step) => (step === validate ? [update, step] : [step])),
  };
  expect(codesOf(withUpdate, before, after)).toContain("OKM1531");
  expect(codesOf(withUpdate, before, after)).not.toContain("OKM1542");

  const sameStep = {
    ...plan,
    steps: plan.steps.map((step) =>
      step === validate ? { ...step, sql: `${update.sql};\n${step.sql}` } : step,
    ),
  };
  expect(codesOf(sameStep, before, after)).toContain("OKM1531");

  const volatile = {
    ...plan,
    steps: plan.steps.map((step) =>
      /add column/i.test(step.sql)
        ? { ...step, sql: step.sql.replace(/default 'a'/, "default gen_random_uuid()::text") }
        : step,
    ),
  };
  expect(volatile.steps.some((step) => step.sql.includes("gen_random_uuid()"))).toBe(true);
  expect(codesOf(volatile, before, after)).toContain("OKM1531");
});

function codes(
  before: ReturnType<typeof schema>,
  after: ReturnType<typeof schema>,
): readonly string[] {
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    name: "add",
  });
  return codesOf(plan, before, after);
}

function codesOf(
  plan: ReturnType<typeof planMigration>,
  before: ReturnType<typeof schema>,
  after: ReturnType<typeof schema>,
): readonly string[] {
  return lintPlan(plan, before.catalog, after.catalog).map((item) => item.code);
}
