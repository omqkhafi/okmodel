/**
 * Domain columns: catalog type, check changes, and the base-type limit.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const check = "((VALUE > 0))";

function people(expression: string, base: "integer" | "text" = "integer") {
  const column =
    base === "integer"
      ? t.domain("pos", t.integer(), expression)
      : t.domain("pos", t.text(), expression);
  return schema({ tables: [table("people", { n: column })] });
}

test("a domain is one type object and the column depends on it", () => {
  const app = schema({
    tables: [
      table("people", {
        email: t.domain("email", t.text(), "((VALUE ~~ '%@%'::text))"),
        name: t.domain("label", t.varchar(20), "((length(VALUE) > 0))"),
        at: t.domain("moment", t.timestamptz(), "true"),
      }),
    ],
  });
  const types = app.catalog.objects.filter((object) => object.kind === "type");
  expect(types.map((object) => object.definition)).toEqual([
    { base: "text", check: "((VALUE ~~ '%@%'::text))" },
    { base: "character varying(20)", check: "((length(VALUE) > 0))" },
    { base: "timestamp with time zone", check: "true" },
  ]);
  const email = app.catalog.objects.find(
    (object) => object.kind === "column" && object.identity.name === "email",
  );
  expect(email?.kind === "column" ? email.definition.dataType : undefined).toBe("email");
  expect(email?.dependencies.some((edge) => edge.target.kind === "type")).toBe(true);
  const column = t.domain("email", t.text(), "((VALUE ~~ '%@%'::text))");
  expect(column.state.encode("a@b.c")).toBe(t.text().state.encode("a@b.c"));
  expect(column.state.decode("a@b.c")).toBe("a@b.c");
});

test("two columns can share a domain, and a second check is OKM1020", () => {
  const shared = schema({
    tables: [
      table("people", {
        work: t.domain("email", t.text(), "((VALUE ~~ '%@%'::text))"),
        home: t.domain("email", t.text(), "((VALUE ~~ '%@%'::text))"),
      }),
    ],
  });
  const types = shared.catalog.objects.filter((object) => object.kind === "type");
  expect(types).toHaveLength(1);
  const conflict = schema({
    tables: [
      table("people", { work: t.domain("email", t.text(), "((VALUE ~~ '%@%'::text))") }),
      table("orgs", { mail: t.domain("email", t.text(), "((length(VALUE) > 3))") }),
    ],
  });
  expect(codeOf(() => conflict.catalog)).toBe("OKM1020");
});

test("create domain precedes the table and does not cascade", () => {
  const plan = planMigration({
    before: schema({ tables: [] }).catalog,
    after: people(check).catalog,
    name: "create",
  });
  const sql = plan.steps.map((step) => step.sql);
  const created = sql.findIndex((statement) => statement.startsWith("create domain"));
  const tableSql = sql.findIndex((statement) => statement.startsWith("create table"));
  expect(created).toBeGreaterThanOrEqual(0);
  expect(created).toBeLessThan(tableSql);
  expect(sql[created]).toContain("as integer");
  expect(sql[created]).toContain(check);
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
});

test("changing a check adds it not valid, validates it, and drops the old one", () => {
  const plan = planMigration({
    before: people(check).catalog,
    after: people("((VALUE > 1))").catalog,
    name: "tighten",
  });
  const sql = plan.steps.map((step) => step.sql);
  expect(
    sql.some(
      (statement) => statement.includes("add constraint") && statement.includes("not valid"),
    ),
  ).toBe(true);
  const added = sql.findIndex((statement) => statement.includes("add constraint"));
  const validated = sql.findIndex((statement) => statement.includes("validate constraint"));
  const dropped = sql.findIndex((statement) => statement.includes("drop constraint"));
  expect(added).toBeGreaterThanOrEqual(0);
  expect(validated).toBeGreaterThan(added);
  expect(dropped).toBeGreaterThan(validated);
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
  expect(sql.some((statement) => statement.startsWith("drop type"))).toBe(false);
});

test("changing the base type is OKM1020 and names the limit", () => {
  const error = capture(() =>
    planMigration({
      before: people(check).catalog,
      after: people("((length(VALUE) > 0))", "text").catalog,
      name: "retype",
    }),
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.code).toBe("OKM1020");
    expect(error.message).toContain("base type");
    expect(error.message).toContain("integer");
    expect(error.message).toContain("text");
  }
});

test("dropping a domain is drop type and not cascade", () => {
  const plan = planMigration({
    before: people(check).catalog,
    after: schema({ tables: [] }).catalog,
    name: "drop",
  });
  const sql = plan.steps.map((step) => step.sql);
  const tableDrop = sql.findIndex((statement) => statement.startsWith("drop table"));
  const typeDrop = sql.findIndex((statement) => statement.startsWith("drop type"));
  expect(tableDrop).toBeGreaterThanOrEqual(0);
  expect(typeDrop).toBeGreaterThan(tableDrop);
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
});

test("an enum base and an empty check are OKM1060", () => {
  expect(codeOf(() => t.domain("shade", t.enum("color", ["red"]), "true"))).toBe("OKM1060");
  expect(codeOf(() => t.domain("pos", t.integer(), ""))).toBe("OKM1060");
  expect(codeOf(() => t.domain("", t.integer(), check))).toBe("OKM1060");
});

function codeOf(run: () => unknown): string | undefined {
  const error = capture(run);
  return error instanceof OkmError ? error.code : undefined;
}

function capture(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}
