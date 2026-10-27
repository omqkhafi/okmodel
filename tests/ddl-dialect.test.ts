/**
 * The planner asks the dialect about features of both catalogs.
 * A lowered step has SQL, a kind, the class of that kind, and SQL that matches.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { requireLowered, sealLowered, type DdlDialect } from "../src/dialects/ddl.js";
import { ddlStep } from "../src/dialects/ddl-step.js";
import { classOf } from "../src/dialects/step-class.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import {
  formatPlan,
  parsePlan,
  planMigration,
  planStatements,
} from "../src/tooling/migrate/plan.js";
import { postgresDialect } from "../src/tooling/migrate/postgres-dialect.js";
import { repoRoot } from "../scripts/root.js";

test("the planner does not import the postgres dialect", () => {
  const source = readFileSync(join(repoRoot(), "src/tooling/migrate/plan.ts"), "utf8");
  expect(source.includes("dialects/pg")).toBe(false);
});

test("postgres support is native for a registry key and absent otherwise", () => {
  expect(postgresDialect.support("schema.core")).toBe("native");
  expect(postgresDialect.support("no.such.feature")).toBeUndefined();
  expect(postgresDialect.lower({ op: "pending" })).toEqual([]);
});

test("a plan asks the dialect about the catalogs it diffs", () => {
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
  const replay = planMigration({ before, after, name: "create" }, dialect);
  expect(asked).toContain("schema.core");
  expect(replay).toEqual(direct);
  asked.length = 0;
  const through = planStatements({ before, after, name: "create" }, dialect);
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

test("one logical enum add can lower to two physical steps", () => {
  const before = schema({
    tables: [
      table("tasks", {
        id: t.integer().primaryKey(),
        status: t.enum("color", ["red", "blue"]),
      }),
    ],
  }).catalog;
  const after = schema({
    tables: [
      table("tasks", {
        id: t.integer().primaryKey(),
        status: t.enum("color", ["red", "green", "blue"]),
      }),
    ],
  }).catalog;
  const dialect: DdlDialect = {
    ...postgresDialect,
    lower(change) {
      if (change.op !== "add-enum-values") return postgresDialect.lower(change);
      return [1, 2].map((part) =>
        ddlStep(
          `alter type "public"."color" add value 'green_${String(part)}'`,
          "add-enum-value",
          "ddl",
          "ACCESS EXCLUSIVE",
          false,
        ),
      );
    },
  };
  const plan = planMigration({ before, after, name: "add" }, dialect);
  const added = plan.steps.filter((item) => item.kind === "add-enum-value");
  expect(added).toHaveLength(2);
  expect(added.every((item) => item.transactional === false)).toBe(true);
  expect(added.map((item) => item.class)).toEqual(["expand", "expand"]);
  const parsed = parsePlan(formatPlan(plan));
  expect(parsed.steps.map((item) => item.sql)).toEqual(plan.steps.map((item) => item.sql));
  expect(parsed.class).toBe(plan.class);
});

test("one logical function create can lower to two physical steps", () => {
  const read = fn("read_tasks", { returns: "integer", language: "sql", body: "select 1" });
  const before = schema({ tables: [] }).catalog;
  const after = schema({ tables: [], functions: [read] }).catalog;
  const dialect: DdlDialect = {
    ...postgresDialect,
    lower(change) {
      if (change.op !== "create-function") return postgresDialect.lower(change);
      return [1, 2].map((part) =>
        ddlStep(
          `create function read_tasks_${String(part)}() returns integer language sql as $$ select 1 $$`,
          "create-function",
          "ddl",
          "ACCESS EXCLUSIVE",
        ),
      );
    },
  };
  const plan = planMigration({ before, after, name: "fn" }, dialect);
  const created = plan.steps.filter((item) => item.kind === "create-function");
  expect(created).toHaveLength(2);
  expect(created.map((item) => item.class)).toEqual(["expand", "expand"]);
  const parsed = parsePlan(formatPlan(plan));
  expect(parsed.steps.map((item) => item.sql)).toEqual(plan.steps.map((item) => item.sql));
  expect(parsed.class).toBe(plan.class);
});

test("a dialect that refuses a used feature is OKM1860 for the plan", () => {
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
  const request = { before: schema({ tables: [] }).catalog, after, name: "refuse" };
  expect(() => planMigration(request, dialect)).toThrow(OkmError);
  expect(() => planStatements(request, dialect)).toThrow(OkmError);
  try {
    planStatements(request, dialect);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    expect((error as OkmError).code).toBe("OKM1860");
  }
});

test("a lowered step has sql, a kind, and that kind's class", () => {
  expect(postgresDialect.lower({ op: "pending" })).toEqual([]);
  const steps = postgresDialect.lower({
    op: "rename-table",
    schema: "public",
    from: "tasks",
    to: "work",
  });
  expect(steps).toHaveLength(1);
  const step = steps[0];
  expect(step?.sql).toBe('alter table "public"."tasks" rename to "work"');
  expect(step?.kind).toBe("rename-table");
  expect(step?.class).toBe(classOf("rename-table"));
  expect(sealLowered(steps)).toBe(steps);

  const blank = caught(() => sealLowered([{ ...step!, sql: "  " }]));
  const untyped = caught(() => sealLowered([{ ...step!, sql: undefined as unknown as string }]));
  const missingResult = caught(() => requireLowered(undefined));
  const missing = caught(() =>
    sealLowered([
      {
        sql: step!.sql,
        class: step!.class,
        action: step!.action,
        lock: step!.lock,
        transactional: step!.transactional,
      },
    ]),
  );
  const lied = caught(() => sealLowered([{ ...step!, class: "expand" }]));
  expect(blank).toBeInstanceOf(OkmError);
  expect(untyped).toBeInstanceOf(OkmError);
  expect(missingResult).toBeInstanceOf(OkmError);
  expect(missing).toBeInstanceOf(OkmError);
  expect(lied).toBeInstanceOf(OkmError);
  if (blank instanceof OkmError) expect(blank.code).toBe("OKM1559");
  if (untyped instanceof OkmError) expect(untyped.code).toBe("OKM1559");
  if (missingResult instanceof OkmError) expect(missingResult.code).toBe("OKM1559");
  if (missing instanceof OkmError) {
    expect(missing.code).toBe("OKM1559");
    expect(missing.message).toContain("no kind");
  }
  if (lied instanceof OkmError) {
    expect(lied.code).toBe("OKM1559");
    expect(lied.message).toContain("rename-table");
  }

  const before = schema({ tables: [] }).catalog;
  const after = schema({
    tables: [table("tasks", { id: t.integer().primaryKey() })],
  }).catalog;
  const dialect: DdlDialect = {
    ...postgresDialect,
    lower(change) {
      return postgresDialect
        .lower(change)
        .map((item) =>
          item.kind === "create-table" ? { ...item, class: "contract" as const } : item,
        );
    },
  };
  const refused = caught(() => planMigration({ before, after, name: "class" }, dialect));
  expect(refused).toBeInstanceOf(OkmError);
  if (refused instanceof OkmError) {
    expect(refused.code).toBe("OKM1559");
    expect(refused.message).toContain("create-table");
  }
});

function caught(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}
