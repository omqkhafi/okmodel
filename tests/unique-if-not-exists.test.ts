/**
 * `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` is still OKM1528 or OKM1529.
 */

import { expect, test } from "bun:test";

import { index, schema, table, t } from "../src/dialects/pg/index.js";
import { lintPlan } from "../src/tooling/migrate/lint.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

test("if not exists does not skip a unique index on an existing table", () => {
  const before = schema({
    tables: [table("tasks", { id: t.integer().primaryKey(), title: t.text() })],
  });
  const indexed = schema({
    tables: [
      table(
        "tasks",
        { id: t.integer().primaryKey(), title: t.text() },
        { indexes: (columns) => [index(columns.title).unique()] },
      ),
    ],
  });
  const indexPlan = planMigration({
    before: before.catalog,
    after: indexed.catalog,
    name: "index",
  });
  const indexSql = indexPlan.steps.map((step) => step.sql).join("\n");
  expect(indexSql).toContain("create unique index concurrently");
  expect(codes(indexPlan, before, indexed)).toContain("OKM1529");
  expect(codes(withIfNotExists(indexPlan), before, indexed)).toContain("OKM1529");

  const keyed = schema({
    tables: [
      table("tasks", {
        id: t.integer().primaryKey(),
        title: t.text().unique(),
      }),
    ],
  });
  const keyPlan = planMigration({
    before: before.catalog,
    after: keyed.catalog,
    name: "key",
  });
  expect(keyPlan.steps.some((step) => step.sql.includes("using index"))).toBe(true);
  expect(codes(keyPlan, before, keyed)).toContain("OKM1528");
  expect(codes(withIfNotExists(keyPlan), before, keyed)).toContain("OKM1528");
});

function withIfNotExists<T extends { readonly steps: readonly { readonly sql: string }[] }>(
  plan: T,
): T {
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      sql: step.sql.replaceAll(
        "create unique index concurrently ",
        "create unique index concurrently if not exists ",
      ),
    })),
  };
}

function codes(
  plan: ReturnType<typeof planMigration>,
  before: ReturnType<typeof schema>,
  after: ReturnType<typeof schema>,
): readonly string[] {
  return lintPlan(plan, before.catalog, after.catalog).map((item) => item.code);
}
