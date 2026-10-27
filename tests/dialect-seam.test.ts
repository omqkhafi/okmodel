/**
 * Dialect seam (N-121) and lowered statements (N-124).
 *
 * A dialect the planner cannot call is OKM1559. `support` and
 * `refuseUnsupported` are both asked. A statement whose SQL does not match
 * its kind is OKM1559. Safe rewrites stay outside `lower` (N-125).
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { ddlStep } from "../src/dialects/ddl-step.js";
import { lowerPostgres } from "../src/dialects/pg/lower.js";
import { schema, sql, table, t } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { postgresDialect as pd } from "../src/tooling/migrate/postgres-dialect.js";

const empty = schema({ tables: [] }).catalog;
const req = {
  before: empty,
  after: schema({ tables: [table("u", { id: t.identity(), meta: t.jsonb() })] }).catalog,
  name: "d",
};

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof OkmError ? error.code : (error as Error).name;
  }
  return "returned";
}

test("a dialect named sqlite whose support is always undefined is refused (N-121 D1)", () => {
  const base = JSON.stringify(planMigration(req));
  const same = () =>
    JSON.stringify(planMigration(req, { ...pd, name: "sqlite", support: () => undefined })) ===
    base;
  expect(codeOf(same)).toBe("OKM1860");
});

test("support refused is honored when refuseUnsupported still reads the registry (N-121 D2)", () => {
  const base = JSON.stringify(planMigration(req));
  const refusesJsonb = (feature: string) =>
    feature === "type.jsonb" ? "refused" : pd.support(feature);
  const same = () => JSON.stringify(planMigration(req, { ...pd, support: refusesJsonb })) === base;
  expect(codeOf(same)).toBe("OKM1860");
});

test("a dialect without featuresUsed is OKM1559 (N-121 D3)", () => {
  expect(codeOf(() => planMigration(req, { ...pd, featuresUsed: undefined } as never))).toBe(
    "OKM1559",
  );
});

test("a null dialect is OKM1559 (N-121 D4)", () => {
  expect(codeOf(() => planMigration(req, null as never))).toBe("OKM1559");
});

test("emulation notes returned by refuseUnsupported stay on the plan (N-121 D5)", () => {
  let notes: unknown = null;
  const plan = planMigration(req, {
    ...pd,
    refuseUnsupported: () => {
      notes = [{ feature: "type.jsonb", cost: "x" }];
      return notes as { feature: string; cost: string }[];
    },
  });
  expect(notes).toEqual([{ feature: "type.jsonb", cost: "x" }]);
  expect(plan.emulation).toEqual([{ feature: "type.jsonb", cost: "x" }]);
});

test("a feature refused only on the catalog being dropped is refused (N-121 D6)", () => {
  const refusesJsonb = (feature: string) =>
    feature === "type.jsonb" ? "refused" : pd.support(feature);
  expect(
    codeOf(() =>
      planMigration(
        { before: req.after, after: empty, name: "drop" },
        {
          ...pd,
          support: refusesJsonb,
          refuseUnsupported: (features) => {
            if (features.includes("type.jsonb")) throw new Error("refused jsonb");
            return [];
          },
        },
      ),
    ),
  ).toBe("Error");
});

test("lower of create-table without a table is OKM1559 (N-121 D9)", () => {
  expect(codeOf(() => pd.lower({ op: "create-table" } as never))).toBe("OKM1559");
});

test("lowerPostgres create-table without a table is OKM1559 (N-124 L2)", () => {
  expect(codeOf(() => lowerPostgres({ op: "create-table" } as never))).toBe("OKM1559");
});

test("lowerPostgres rename-table without to is OKM1559 (N-124 L3)", () => {
  expect(codeOf(() => lowerPostgres({ op: "rename-table", schema: "s", from: "a" } as never))).toBe(
    "OKM1559",
  );
});

test("a lowered statement whose SQL does not match its kind is OKM1559 (N-124 L9)", () => {
  const v1 = schema({
    tables: [table("parent", { id: t.identity(), q: t.integer().default(1) })],
  }).catalog;
  const v2 = schema({
    tables: [
      table(
        "parent",
        { id: t.identity(), q: t.integer().default(1), c: t.text().nullable() },
        { checks: { q_small: (c) => sql`${c.q} < 9` } },
      ),
    ],
  }).catalog;
  expect(
    codeOf(() =>
      planMigration(
        { before: v1, after: v2, name: "l" },
        {
          ...pd,
          lower: (change) =>
            change.op === "add-column"
              ? [ddlStep('drop table "public"."users"', "add-column", "ddl", "ACCESS EXCLUSIVE")]
              : pd.lower(change),
        },
      ),
    ),
  ).toBe("OKM1559");
});

test("safe rewrites are not asked of lower (N-125)", () => {
  const v1 = schema({
    tables: [table("parent", { id: t.identity(), q: t.integer().default(1) })],
  }).catalog;
  const v2 = schema({
    tables: [
      table(
        "parent",
        { id: t.identity(), q: t.integer().default(1), c: t.text().nullable() },
        { checks: { q_small: (c) => sql`${c.q} < 9` } },
      ),
    ],
  }).catalog;
  const request = { before: v1, after: v2, name: "l" };
  const base = planMigration(request);
  const calls: string[] = [];
  const plan = planMigration(request, {
    ...pd,
    lower: (change) => {
      calls.push(change.op);
      return pd.lower(change);
    },
  });
  expect(calls.includes("add-constraint")).toBe(false);
  expect(plan.steps.some((step) => step.kind === "add-constraint")).toBe(true);
  expect(JSON.stringify(plan)).toBe(JSON.stringify(base));
});
