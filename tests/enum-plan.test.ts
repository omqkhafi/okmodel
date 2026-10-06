/**
 * Enum planning: create, add value, removal, and drop order.
 *
 * Applying these statements on Postgres is `migrate-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { parseReplace } from "../src/tooling/migrate/values.js";

test("create type is emitted before the table that uses it", () => {
  const after = colored(["red", "blue"]);
  const plan = planMigration({
    before: schema({ tables: [] }).catalog,
    after: after.catalog,
    name: "create",
  });
  const sql = plan.steps.map((step) => step.sql);
  const type = sql.findIndex((statement) => statement.startsWith("create type"));
  const tableSql = sql.findIndex((statement) => statement.startsWith("create table"));
  expect(type).toBeGreaterThanOrEqual(0);
  expect(type).toBeLessThan(tableSql);
  expect(sql[type]).toContain("'red', 'blue'");
});

test("adding a label is a non-transactional alter type and keeps the type", () => {
  const plan = planMigration({
    before: colored(["red", "blue"]).catalog,
    after: colored(["red", "green", "blue"]).catalog,
    name: "add",
  });
  const added = plan.steps.filter((step) => step.sql.includes("add value"));
  expect(added).toHaveLength(1);
  expect(added[0]?.transactional).toBe(false);
  expect(added[0]?.sql).toContain("before 'blue'");
  expect(plan.steps.some((step) => step.sql.startsWith("drop type"))).toBe(false);
  expect(plan.class).toBe("expand");
});

test("removing a label requires --replace and swaps the type after the backfill", () => {
  const before = colored(["red", "blue"]);
  const after = colored(["red"]);
  expect(() =>
    planMigration({ before: before.catalog, after: after.catalog, name: "remove" }),
  ).toThrow(OkmError);
  try {
    planMigration({ before: before.catalog, after: after.catalog, name: "remove" });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    expect((error as OkmError).code).toBe("OKM1541");
    expect((error as OkmError).fix?.summary).toContain("--replace");
  }
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    replacements: [parseReplace("tasks.status.blue=red")],
    name: "remove",
  });
  const sql = plan.steps.map((step) => step.sql);
  const expand = sql.findIndex(
    (statement) =>
      statement.startsWith("update") && plan.steps[sql.indexOf(statement)]?.class === "expand",
  );
  const contract = sql.findIndex(
    (statement, index) => statement.startsWith("update") && plan.steps[index]?.class === "contract",
  );
  const rename = sql.findIndex((statement) => statement.includes("rename to"));
  expect(expand).toBeGreaterThanOrEqual(0);
  expect(expand).toBeLessThan(contract);
  expect(contract).toBeLessThan(rename);
  expect(sql[rename + 1]).toContain("create type");
  expect(sql[rename + 2]).toContain("alter column");
  expect(sql[rename + 3]).toContain("drop type");
  expect(plan.class).toBe("contract");
});

test("several columns and several removed labels share one replacement and one type", () => {
  const before = schema({
    tables: [
      table("tasks", {
        id: t.integer().primaryKey(),
        status: t.enum("color", ["red", "blue", "green"]),
        shade: t.enum("color", ["red", "blue", "green"]),
      }),
    ],
  });
  const after = schema({
    tables: [
      table("tasks", {
        id: t.integer().primaryKey(),
        status: t.enum("color", ["red"]),
        shade: t.enum("color", ["red"]),
      }),
    ],
  });
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    replacements: [
      parseReplace("tasks.status.blue=red"),
      parseReplace("tasks.status.green=red"),
      parseReplace("tasks.shade.blue=red"),
      parseReplace("tasks.shade.green=red"),
    ],
    name: "many",
  });
  const updates = plan.steps.filter((step) => step.sql.startsWith("update"));
  expect(updates.filter((step) => step.class === "expand")).toHaveLength(4);
  expect(updates.filter((step) => step.class === "contract")).toHaveLength(4);
  const alters = plan.steps.filter((step) => step.sql.includes("alter column"));
  expect(alters).toHaveLength(2);
  expect(plan.steps.filter((step) => step.sql.startsWith("create type"))).toHaveLength(1);
});

test("dropping the table drops the type after the table", () => {
  const plan = planMigration({
    before: colored(["red"]).catalog,
    after: schema({ tables: [] }).catalog,
    name: "drop-table",
  });
  const sql = plan.steps.map((step) => step.sql);
  const dropped = sql.findIndex((statement) => statement.startsWith("drop table"));
  const type = sql.findIndex((statement) => statement.startsWith("drop type"));
  expect(dropped).toBeGreaterThanOrEqual(0);
  expect(type).toBeGreaterThan(dropped);
});

test("the type is dropped after the last column that uses it", () => {
  const before = colored(["red"]);
  const after = schema({ tables: [table("tasks", { id: t.integer() })] });
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: "drop" });
  const sql = plan.steps.map((step) => step.sql);
  const column = sql.findIndex((statement) => statement.includes("drop column"));
  const type = sql.findIndex((statement) => statement.startsWith("drop type"));
  expect(column).toBeGreaterThanOrEqual(0);
  expect(type).toBeGreaterThan(column);
});

function colored(labels: readonly string[]) {
  return schema({
    tables: [
      table("tasks", {
        id: t.integer().primaryKey(),
        status: t.enum("color", labels),
      }),
    ],
  });
}
