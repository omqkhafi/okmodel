/**
 * The planner asks the dialect about features and does not read the registry.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import type { DdlDialect } from "../src/dialects/ddl.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
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
