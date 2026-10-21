/**
 * Declared `-- probe:` on a committed step.
 *
 * Parse and print, the two lint codes, and a fake connection for the
 * Postgres probe. A built-in probe still wins.
 */

import { expect, test } from "bun:test";

import type { DriverConnection, ExecuteResult } from "../src/contracts/driver.js";
import { enumColumn } from "../src/dialects/pg/enum.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import { lintPlan } from "../src/tooling/migrate/lint.js";
import { planDocument, type PlanDocument } from "../src/tooling/migrate/plan-json.js";
import { postgresStepEngine } from "../src/tooling/migrate/pg-probe.js";
import {
  formatPlan,
  parsePlan,
  planMigration,
  type PlanStep,
} from "../src/tooling/migrate/plan.js";
import { stepSqlHash } from "../src/tooling/migrate/step-engine.js";

const empty = schema({ tables: [] }).catalog;

const probeSql = "select note = 'a;b' and note = '-- probe: no'";

test("a probe round-trips, including a quoted semicolon, a comment-like string, and CRLF", () => {
  const step: PlanStep = {
    sql: "vacuum analyze notes",
    class: "expand",
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: false,
    probe: probeSql,
  };
  const plan = { name: "hand", class: "expand" as const, steps: [step] };
  const text = formatPlan(plan);
  expect(text).toContain(`-- probe: ${probeSql}`);
  expect(formatPlan(parsePlan(text))).toBe(text);
  expect(parsePlan(text.replaceAll("\n", "\r\n"))).toEqual(parsePlan(text));
  expect(parsePlan(text.replaceAll("\n", "\r")).steps[0]?.probe).toBe(probeSql);
  const parsed = parsePlan(text).steps[0];
  expect(parsed?.probe).toBe(probeSql);
  expect(stepSqlHash(parsed?.sql ?? "")).toBe(stepSqlHash(step.sql));
  const withProbe = documentOf(step);
  const { probe: declared, ...withoutProbe } = step;
  expect(declared).toBe(probeSql);
  const without = documentOf(withoutProbe);
  expect(withProbe.steps[0]?.probe).toBe(probeSql);
  expect(without.steps[0]?.probe).toBeUndefined();
  expect(withProbe.planHash).toBe(without.planHash);
});

test("OKM1557 fires only when a raw concurrent index cannot be parsed", () => {
  expect(codes("create index concurrently idx on t (id)")).not.toContain("OKM1557");
  expect(codes("create index concurrently on t (id)")).toContain("OKM1557");
  expect(codes("-- transactional: false\ncreate table notes (id int)")).toContain("OKM1557");
  expect(codes("create table notes (id int)")).not.toContain("OKM1557");
  expect(
    codes("-- probe: select true\n-- transactional: false\ncreate table notes (id int)"),
  ).not.toContain("OKM1557");
  expect(
    codes("-- okm-allow OKM1557: reviewed\n-- transactional: false\nvacuum analyze notes"),
  ).not.toContain("OKM1557");
  expect(codes("-- okm-allow OKM1557:\n-- transactional: false\nvacuum analyze notes")).toContain(
    "OKM1557",
  );
  expect(codes("-- okm-allow OKM1557:\n-- transactional: false\nvacuum analyze notes")).toContain(
    "OKM1510",
  );
});

test("planner steps that already have a probe are not OKM1557", () => {
  const before = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
  const indexed = table(
    "tasks",
    { id: t.identity(), title: t.text() },
    { indexes: (columns) => [index(columns.title)] },
  );
  const added = planMigration({
    before: before.catalog,
    after: schema({ tables: [indexed] }).catalog,
    name: "index",
  });
  expect(
    lintPlan(added, before.catalog, schema({ tables: [indexed] }).catalog).map((item) => item.code),
  ).not.toContain("OKM1557");
  const colored = table("tasks", {
    id: t.identity(),
    status: enumColumn("color", ["red"]),
  });
  const widened = table("tasks", {
    id: t.identity(),
    status: enumColumn("color", ["red", "blue"]),
  });
  const values = planMigration({
    before: schema({ tables: [colored] }).catalog,
    after: schema({ tables: [widened] }).catalog,
    name: "color",
  });
  expect(
    lintPlan(values, schema({ tables: [colored] }).catalog, schema({ tables: [widened] }).catalog)
      .map((item) => item.code)
      .includes("OKM1557"),
  ).toBe(false);
  expect(
    added.steps.some((step) => step.kind === "create-index" && step.transactional === false),
  ).toBe(true);
});

test("OKM1558 refuses an empty, multi-statement, writing, or transactional probe", () => {
  expect(codes("-- probe:\n-- transactional: false\nvacuum analyze notes")).toContain("OKM1558");
  expect(
    codes("-- probe: delete from notes\n-- transactional: false\nvacuum analyze notes"),
  ).toContain("OKM1558");
  expect(
    codes("-- probe: select true; select false\n-- transactional: false\nvacuum analyze notes"),
  ).toContain("OKM1558");
  expect(
    codes(
      "-- probe: with x as (insert into notes values (1) returning id) select id is not null\n-- transactional: false\nvacuum analyze notes",
    ),
  ).toContain("OKM1558");
  expect(codes("-- probe: select true\ncreate table notes (id int)")).toContain("OKM1558");
  expect(
    codes(`-- probe: ${probeSql}\n-- transactional: false\nvacuum analyze notes`),
  ).not.toContain("OKM1558");
  expect(
    codes("-- probe: select true;\n-- transactional: false\nvacuum analyze notes"),
  ).not.toContain("OKM1558");
  expect(
    codes(
      "-- okm-allow OKM1558: reviewed\n-- probe: delete from notes\n-- transactional: false\nvacuum analyze notes",
    ),
  ).not.toContain("OKM1558");
  expect(
    codes("-- okm-allow OKM1558:\n-- probe:\n-- transactional: false\nvacuum analyze notes"),
  ).toContain("OKM1558");
});

test("a declared probe reads one boolean inside a read-only transaction", async () => {
  expect(await verdict([["t"]])).toBe("applied");
  expect(await verdict([["true"]])).toBe("applied");
  expect(await verdict([["f"]])).toBe("absent");
  expect(await verdict([["false"]])).toBe("absent");
  expect(await verdict([[null]])).toBe("unknown");
  expect(await verdict([["t"], ["t"]])).toBe("unknown");
  expect(await verdict([["yes"]])).toBe("unknown");
  expect(await verdict([["t", "extra"]])).toBe("unknown");
  const failed = scripted(() => {
    throw new Error("probe failed");
  });
  expect(await failed.engine.probe()).toBe("unknown");
  expect(failed.calls).toEqual(["begin read only", "select true", "rollback"]);
});

test("a built-in probe wins over a declared one and a declared probe has no cleanup", async () => {
  const calls: string[] = [];
  const connection = {
    execute(text: string) {
      calls.push(text);
      return Promise.resolve(done([]));
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  const engine = postgresStepEngine(
    connection,
    {
      kind: "raw-sql",
      sql: "create index concurrently idx on items (id)",
      lockTimeoutMs: 1_000,
      probe: "select true",
    },
    () => Promise.resolve(),
  );
  expect(engine.probed).toBe(true);
  expect(await engine.probe()).toBe("absent");
  expect(calls.some((text) => text.includes("begin read only"))).toBe(false);
  expect(calls.some((text) => text.includes("pg_class"))).toBe(true);
  const declared = scripted(() => done([["t"]]));
  await declared.engine.cleanup();
  expect(declared.calls).toEqual([]);
});

function documentOf(step: PlanStep): PlanDocument {
  return planDocument({ name: "hand", class: "expand", steps: [step] }, []);
}

function codes(sql: string): readonly string[] {
  return lintPlan(parsePlan(`-- name: hand\n\n${sql};\n`), empty, empty).map((item) => item.code);
}

async function verdict(rows: readonly (readonly (string | null)[])[]): Promise<string> {
  const world = scripted(() => done(rows));
  const value = await world.engine.probe();
  expect(world.calls).toEqual(["begin read only", "select true", "rollback"]);
  return value;
}

function scripted(reply: () => ExecuteResult): {
  engine: ReturnType<typeof postgresStepEngine>;
  calls: string[];
} {
  const calls: string[] = [];
  const connection = {
    execute(text: string) {
      calls.push(text);
      if (text === "begin read only" || text === "rollback") return Promise.resolve(done([]));
      try {
        return Promise.resolve(reply());
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("probe failed"));
      }
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  } as DriverConnection;
  return {
    calls,
    engine: postgresStepEngine(
      connection,
      { kind: "raw-sql", sql: "vacuum analyze notes", lockTimeoutMs: 1_000, probe: "select true" },
      () => Promise.resolve(),
    ),
  };
}

function done(rows: readonly (readonly (string | null)[])[]): ExecuteResult {
  return { rows, count: rows.length, notices: [] };
}
