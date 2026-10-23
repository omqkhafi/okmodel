/**
 * Planner comparisons that must agree with what introspection reads back.
 *
 * The Postgres side of each case is `migrate-live-match-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { schema, table, t } from "../src/dialects/pg/index.js";
import { previousCatalogGaps } from "../src/tooling/migrate/check.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

function withReference(options?: {
  readonly onDelete?: "no action" | "cascade";
  readonly onUpdate?: "no action" | "cascade";
}) {
  return schema({
    tables: [
      table("authors", { id: t.integer().primaryKey() }),
      table("posts", {
        id: t.integer().primaryKey(),
        authorId: t.integer().references("authors", options),
      }),
    ],
  });
}

test("an explicit no action foreign key matches the absent action Postgres prints (N-123)", () => {
  const live = withReference();
  for (const options of [
    { onDelete: "no action" },
    { onUpdate: "no action" },
    { onDelete: "no action", onUpdate: "no action" },
  ] as const) {
    const plan = planMigration({
      before: live.catalog,
      after: withReference(options).catalog,
      name: "same",
    });
    expect(plan.steps).toEqual([]);
  }
});

test("a real action change still plans a foreign key swap (N-123)", () => {
  const plan = planMigration({
    before: withReference({ onDelete: "no action" }).catalog,
    after: withReference({ onDelete: "cascade" }).catalog,
    name: "change",
  });
  expect(plan.steps.some((step) => step.sql.includes("on delete cascade"))).toBe(true);
});

function colored(labels: readonly string[]) {
  return schema({
    tables: [table("tasks", { id: t.integer().primaryKey(), status: t.enum("color", labels) })],
  }).catalog;
}

test("an added enum label leaves no previous-catalog gap (N-118)", () => {
  const before = colored(["red", "blue"]);
  expect(previousCatalogGaps(before, colored(["red", "blue", "green"]))).toEqual([]);
  expect(previousCatalogGaps(before, colored(["red", "green", "blue"]))).toEqual([]);
  expect(previousCatalogGaps(before, colored(["green", "red", "blue"]))).toEqual([]);
});

test("a removed or reordered enum label is still a previous-catalog gap (N-118)", () => {
  const before = colored(["red", "blue"]);
  expect(previousCatalogGaps(before, colored(["red"]))).toEqual(["type color changed"]);
  expect(previousCatalogGaps(before, colored(["blue", "red"]))).toEqual(["type color changed"]);
});
