/**
 * The planner's own picklist swap and OKM1531 (D301, amended).
 *
 * Removing a value plans two backfills, then drop, add `NOT VALID`, validate.
 * That validate is not OKM1531 when the backfill precedes it. Any other
 * validate stays OKM1531. A plan read against a live target sees the checks
 * as the server prints them and still plans the backfills.
 */

import { expect, test } from "bun:test";

import type { Catalog } from "../src/contracts/catalog/types.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { lintPlan } from "../src/tooling/migrate/lint.js";
import {
  formatPlan,
  parsePlan,
  planMigration,
  type MigrationPlan,
  type PlanStep,
} from "../src/tooling/migrate/plan.js";
import { parseReplace } from "../src/tooling/migrate/values.js";

const before = schema({
  tables: [
    table("tasks", { id: t.identity(), status: t.text().picklist(["draft", "active", "done"]) }),
  ],
}).catalog;
const after = schema({
  tables: [table("tasks", { id: t.identity(), status: t.text().picklist(["active", "done"]) })],
}).catalog;
const replacements = [parseReplace("tasks.status.draft=active")];

/** The check text a server prints for a picklist: `= ANY (ARRAY[...])`. */
function asServerPrints(source: Catalog): Catalog {
  return {
    ...source,
    objects: source.objects.map((object) => {
      if (object.kind !== "constraint" || object.definition.constraintKind !== "check") {
        return object;
      }
      const match = /^\((\w+) IN \((.*)\)\)$/.exec(object.definition.expression ?? "");
      if (match === null) return object;
      const values = (match[2] ?? "").split(", ").map((value) => `${value}::text`);
      const expression = `(${match[1]} = ANY (ARRAY[${values.join(", ")}]))`;
      return { ...object, definition: { ...object.definition, expression } };
    }),
  };
}

function plan(): MigrationPlan {
  return planMigration({ before, after, replacements, name: "drop_draft" });
}

function codes(steps: readonly PlanStep[], kinds?: readonly string[]): readonly string[] {
  const text = formatPlan({ ...plan(), steps });
  const parsed = parsePlan(text);
  return lintPlan(parsed, before, after)
    .filter((item) => kinds === undefined || kinds.includes(item.code))
    .map((item) => item.code);
}

test("a picklist swap after its backfill does not trip OKM1531, in memory or from the file", () => {
  const planned = plan();
  expect(planned.steps.map((step) => step.kind)).toEqual([
    "backfill-expand",
    "backfill-contract",
    "narrow-check",
    "narrow-check",
    "narrow-check",
  ]);
  expect(lintPlan(planned, before, after).map((item) => item.code)).not.toContain("OKM1531");
  expect(codes(planned.steps, ["OKM1531"])).toEqual([]);
});

test("the same validate with no backfill before it stays OKM1531", () => {
  const swap = plan().steps.filter((step) => step.kind === "narrow-check");
  expect(codes(swap, ["OKM1531"])).toEqual(["OKM1531"]);
});

test("a write on the table between the backfill and the validate stays OKM1531", () => {
  const steps = plan().steps;
  const [write] = parsePlan(
    `-- class: expand\n\nupdate "public"."tasks" set "status" = 'draft';\n`,
  ).steps;
  const withWrite = [...steps.slice(0, 2), write as PlanStep, ...steps.slice(2)];
  expect(codes(withWrite, ["OKM1531"])).toEqual(["OKM1531"]);
});

test("a backfill of another column does not cover the validate", () => {
  const steps = plan().steps;
  const other: PlanStep[] = steps.map((step) =>
    step.kind === "backfill-expand" || step.kind === "backfill-contract"
      ? { ...step, sql: step.sql.replace('set "status"', 'set "title"') }
      : step,
  );
  expect(codes(other, ["OKM1531"])).toEqual(["OKM1531"]);
});

test("a validate that is not the planner's narrow-check stays OKM1531", () => {
  const steps = plan().steps.map((step) =>
    step.kind === "narrow-check" && step.sql.includes("validate constraint")
      ? { ...step, kind: undefined }
      : step,
  );
  expect(codes(steps as readonly PlanStep[], ["OKM1531"])).toEqual(["OKM1531"]);
});

test("catalogs sealed to the server's check text plan the same steps as the offline plan", () => {
  const offline = plan().steps.map((step) => step.sql);
  const live = planMigration({
    before: asServerPrints(before),
    after: asServerPrints(after),
    authored: { before, after },
    replacements,
    name: "drop_draft",
  });
  expect(live.steps.map((step) => step.sql)).toEqual(offline);
  expect(live.steps.map((step) => step.kind)).toEqual(plan().steps.map((step) => step.kind));
});
