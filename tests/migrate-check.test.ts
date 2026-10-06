/**
 * Previous-catalog gaps and the class used to allow them.
 *
 * The class comes from step kinds. A hand-edited `-- class:` line does not
 * authorize a gap, and a line changed to `expand` does not hide one.
 */

import { expect, test } from "bun:test";

import { schema, t, table } from "../src/dialects/pg/index.js";
import {
  migrationAllowsPreviousGaps,
  previousCatalogGaps,
  recomputedMigrationClass,
} from "../src/tooling/migrate/check.js";
import { formatPlan, parsePlan, planMigration } from "../src/tooling/migrate/plan.js";

const withNote = () =>
  schema({
    tables: [table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })],
  });

const withoutNote = () => schema({ tables: [table("items", { id: t.integer().primaryKey() })] });

test("a dropped column is a gap, and a hand-edited expand class does not allow it", () => {
  const before = withNote();
  const after = withoutNote();
  const gaps = previousCatalogGaps(before.catalog, after.catalog);
  expect(gaps.some((gap) => gap.includes("column items.note"))).toBe(true);

  const planned = planMigration({
    before: before.catalog,
    after: after.catalog,
    name: "drop",
  });
  expect(planned.class).toBe("contract");
  expect(recomputedMigrationClass(planned, before.catalog, after.catalog)).toBe("contract");
  expect(migrationAllowsPreviousGaps(planned, before.catalog, after.catalog)).toBe(true);

  const edited = parsePlan(
    formatPlan(planned).replaceAll("-- class: contract", "-- class: expand"),
  );
  expect(edited.class).toBe("expand");
  expect(recomputedMigrationClass(edited, before.catalog, after.catalog)).toBe("contract");
  expect(migrationAllowsPreviousGaps(edited, before.catalog, after.catalog)).toBe(false);
});

test("nullability tightens only when the column has no default, and a type change is a gap", () => {
  const loose = schema({
    tables: [table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })],
  });
  const tight = schema({
    tables: [table("items", { id: t.integer().primaryKey(), note: t.text() })],
  });
  const filled = schema({
    tables: [table("items", { id: t.integer().primaryKey(), note: t.text().default("n") })],
  });
  expect(
    previousCatalogGaps(loose.catalog, tight.catalog).some((gap) => gap.includes("nullability")),
  ).toBe(true);
  expect(
    previousCatalogGaps(loose.catalog, filled.catalog).some((gap) => gap.includes("nullability")),
  ).toBe(false);

  const textId = schema({
    tables: [table("items", { id: t.text().primaryKey(), note: t.text().nullable() })],
  });
  expect(
    previousCatalogGaps(loose.catalog, textId.catalog).some((gap) => gap.includes("changed type")),
  ).toBe(true);
  expect(previousCatalogGaps(loose.catalog, loose.catalog)).toEqual([]);
});
