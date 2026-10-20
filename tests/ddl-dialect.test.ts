/**
 * The planner asks the dialect about features and does not read the registry.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import type { DdlDialect } from "../src/dialects/ddl.js";
import { ddlStep } from "../src/dialects/ddl-step.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import { formatPlan, parsePlan, planMigration } from "../src/tooling/migrate/plan.js";
import { postgresDialect } from "../src/tooling/migrate/postgres-dialect.js";

test("postgres support is native for a registry key and absent otherwise", () => {
  expect(postgresDialect.support("schema.core")).toBe("native");
  expect(postgresDialect.support("no.such.feature")).toBeUndefined();
  expect(postgresDialect.lower({ op: "pending" })).toEqual([]);
});

test("the planner asks the dialect and keeps the postgres plan", () => {
  const asked: string[] = [];
  const before = schema({ tables: [] }).catalog;
  const after = schema({
    tables: [table("tasks", { id: t.integer().primaryKey() })],
  }).catalog;
  const dialect: DdlDialect = {
    ...postgresDialect,
    support(feature) {
      asked.push(feature);
      return postgresDialect.support(feature);
    },
  };
  const direct = planMigration({ before, after, name: "create" });
  const through = planMigration({ before, after, name: "create" }, dialect);
  expect(asked).toContain("schema.core");
  expect(through).toEqual(direct);
});

test("one logical column add can lower to three physical steps", () => {
  const before = schema({
    tables: [table("tasks", { id: t.integer().primaryKey() })],
  }).catalog;
  const after = schema({
    tables: [
      table("tasks", {
        id: t.integer().primaryKey(),
        note: t.text(),
        open: t.boolean(),
      }),
    ],
  }).catalog;
  const dialect: DdlDialect = {
    ...postgresDialect,
    lower(change) {
      if (change.op !== "add-column") return postgresDialect.lower(change);
      const column = change.column.identity.name;
      return [1, 2, 3].map((part) =>
        ddlStep(
          `alter table "public"."tasks" add column ${column}_${String(part)} text`,
          "add-column",
          "ddl",
          part === 3 ? "SHARE" : "ACCESS EXCLUSIVE",
        ),
      );
    },
  };
  const plan = planMigration({ before, after, name: "widen" }, dialect);
  const notes = plan.steps.filter((item) => item.sql.includes("note_"));
  const flags = plan.steps.filter((item) => item.sql.includes("open_"));
  expect(notes).toHaveLength(3);
  expect(flags).toHaveLength(3);
  expect(plan.steps.indexOf(notes[0]!)).toBeLessThan(plan.steps.indexOf(flags[0]!));
  expect(notes.map((item) => item.class)).toEqual(["expand", "expand", "expand"]);
  expect(notes[2]?.lock).toBe("SHARE");
  const parsed = parsePlan(formatPlan(plan));
  expect(parsed.steps.map((item) => item.sql)).toEqual(plan.steps.map((item) => item.sql));
  expect(parsed.class).toBe(plan.class);
});

test("one logical index create can lower to two steps and a deferred drop stays after them", () => {
  const before = schema({
    tables: [
      table(
        "tasks",
        { id: t.integer().primaryKey(), title: t.text() },
        { indexes: (columns) => [index(columns.title)] },
      ),
    ],
  }).catalog;
  const after = schema({
    tables: [
      table(
        "tasks",
        { id: t.integer().primaryKey(), title: t.text() },
        { indexes: (columns) => [index(columns.id)] },
      ),
    ],
  }).catalog;
  const dialect: DdlDialect = {
    ...postgresDialect,
    lower(change) {
      if (change.op !== "create-index") return postgresDialect.lower(change);
      const name = change.index.identity.name;
      return [1, 2].map((part) =>
        ddlStep(
          `create index "${name}_${String(part)}" on "public"."tasks" ("title")`,
          "create-index",
          "ddl",
          "SHARE",
        ),
      );
    },
  };
  const plan = planMigration({ before, after, name: "swap" }, dialect);
  const creates = plan.steps.filter((item) => item.kind === "create-index");
  const drops = plan.steps.filter((item) => item.kind === "drop-index");
  expect(creates).toHaveLength(2);
  expect(drops).toHaveLength(1);
  expect(plan.steps.indexOf(creates[1]!)).toBeLessThan(plan.steps.indexOf(drops[0]!));
  expect(creates.map((item) => item.class)).toEqual(["expand", "expand"]);
  const parsed = parsePlan(formatPlan(plan));
  expect(parsed.steps.map((item) => item.sql)).toEqual(plan.steps.map((item) => item.sql));
  expect(parsed.class).toBe(plan.class);
});

test("a dialect that refuses a used feature is OKM1860", () => {
  const after = schema({
    tables: [table("tasks", { id: t.integer().primaryKey() })],
  }).catalog;
  const dialect: DdlDialect = {
    ...postgresDialect,
    support(feature) {
      if (feature === "schema.core") return "refused";
      return postgresDialect.support(feature);
    },
    refuseUnsupported(features) {
      if (features.includes("schema.core")) {
        throw new OkmError("OKM1860", "sqlite refuses schema.core.", {
          fix: { summary: "Use a table this dialect can create." },
        });
      }
      return postgresDialect.refuseUnsupported(features);
    },
  };
  expect(() =>
    planMigration({ before: schema({ tables: [] }).catalog, after, name: "refuse" }, dialect),
  ).toThrow(OkmError);
  try {
    planMigration({ before: schema({ tables: [] }).catalog, after, name: "refuse" }, dialect);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    expect((error as OkmError).code).toBe("OKM1860");
  }
});
