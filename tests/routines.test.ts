/**
 * Function and trigger declarations, and the plan that applies them.
 *
 * Postgres execution is in `routines-pg.test.ts`.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { fn, trigger } from "../src/dialects/pg/fn/index.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { timestamps } from "../src/runtime/traits/index.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { formatTriggers } from "../src/tooling/migrate/doctor.js";
import { formatPlan, parsePlan, planMigration } from "../src/tooling/migrate/plan.js";

const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });

test("plpgsql without dependsOn is OKM1824 and security definer without search_path is OKM1823", () => {
  const missing = capture(() =>
    fn("touch", { returns: "trigger", language: "plpgsql", body: "begin return new; end" }),
  );
  expect(missing.code).toBe("OKM1824");
  const empty = fn("touch", {
    returns: "trigger",
    language: "plpgsql",
    body: "begin return new; end",
    dependsOn: [],
  });
  expect(empty.argTypes).toEqual([]);
  const definer = capture(() =>
    fn("read", {
      returns: "integer",
      language: "sql",
      security: "definer",
      body: "begin atomic select 1; end",
    }),
  );
  expect(definer.code).toBe("OKM1823");
});

test("overloads are distinct and a plan creates tables, then functions, then triggers", () => {
  const byText = fn("slugify", {
    arguments: [{ name: "title", type: "text" }],
    returns: "text",
    language: "plpgsql",
    body: "begin return title; end",
    dependsOn: [{ table: tasks, column: "title" }],
  });
  const byCount = fn("slugify", {
    arguments: [{ name: "n", type: "integer" }],
    returns: "text",
    language: "plpgsql",
    body: "begin return n::text; end",
    dependsOn: [tasks],
  });
  const touch = fn("touch", {
    returns: "trigger",
    language: "plpgsql",
    volatility: "volatile",
    body: "begin return new; end",
    dependsOn: [tasks],
  });
  const fired = trigger("tasks_touch", {
    on: tasks,
    timing: "before",
    events: ["update"],
    level: "row",
    updateOf: ["title"],
    calls: touch,
  });
  const app = schema({
    tables: [tasks],
    functions: [byText, byCount, touch],
    triggers: [fired],
  });
  const functions = app.catalog.objects.filter((object) => object.kind === "function");
  const signatures = functions.map((object) =>
    object.kind === "function"
      ? `${object.identity.name}(${object.identity.argTypes.join(",")})`
      : "",
  );
  expect(signatures.sort()).toEqual(["slugify(integer)", "slugify(text)", "touch()"]);
  const triggerObject = app.catalog.objects.find((object) => object.kind === "trigger");
  expect(triggerObject?.dependencies.map((edge) => edge.target.kind).sort()).toEqual([
    "column",
    "function",
    "table",
  ]);
  const sql = statements(catalog([]), app.catalog);
  expect(indexOf(sql, "create table")).toBeLessThan(indexOf(sql, "create function"));
  expect(indexOf(sql, 'create function "public"."slugify"')).toBeLessThan(
    indexOf(sql, "create trigger"),
  );
  expect(sql.some((step) => step.includes("update of"))).toBe(true);
});

test("a compatible body change is create or replace and an incompatible one recreates the trigger", () => {
  const before = declared("integer", "begin return 1; end");
  const replaced = declared("integer", "begin return 2; end");
  const compatible = planMigration({
    before: before.catalog,
    after: replaced.catalog,
    name: "body",
  });
  expect(compatible.steps.map((step) => step.sql).join("\n")).toContain(
    "create or replace function",
  );
  expect(compatible.steps.some((step) => step.behavior === "change")).toBe(true);
  expect(compatible.steps.some((step) => step.sql.startsWith("drop "))).toBe(false);
  expect(compatible.steps.some((step) => step.sql.includes("search_path"))).toBe(true);
  const printed = formatPlan(compatible);
  expect(printed).toContain("-- behavior: change");
  expect(parsePlan(printed).steps.some((step) => step.behavior === "change")).toBe(true);

  const incompatible = planMigration({
    before: before.catalog,
    after: declared("text", "begin return 'a'; end").catalog,
    name: "returns",
  });
  const sql = incompatible.steps.map((step) => step.sql);
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
  expect(sql.some((step) => step.startsWith("create or replace"))).toBe(false);
  expect(indexOf(sql, "drop trigger")).toBeLessThan(indexOf(sql, "drop function"));
  expect(indexOf(sql, "drop function")).toBeLessThan(indexOf(sql, "create function"));
  expect(indexOf(sql, "create function")).toBeLessThan(indexOf(sql, "create trigger"));
});

test("dropping a table drops its trigger before its function, and a leftover dependent is refused", () => {
  const app = declared("integer", "begin return 1; end");
  const sql = statements(app.catalog, catalog([]));
  expect(indexOf(sql, "drop trigger")).toBeLessThan(indexOf(sql, "drop function"));
  expect(indexOf(sql, "drop function")).toBeLessThan(indexOf(sql, "drop table"));
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");

  const after = {
    version: app.catalog.version,
    objects: app.catalog.objects.filter((object) => object.kind !== "function"),
  };
  const refused = capture(() => planMigration({ before: app.catalog, after, name: "stuck" }));
  expect(refused.code).toBe("OKM1821");
});

test("timestamps enforcement contributes its function and trigger", () => {
  const app = schema({
    casing: "snake",
    tables: [
      table(
        "notes",
        { id: t.text().primaryKey() },
        { traits: [timestamps({ enforce: "trigger" })] },
      ),
    ],
  });
  expect(formatTriggers(app.catalog.objects)).toBe("notes: notes_touch\n");
  const fnObject = app.catalog.objects.find((object) => object.kind === "function");
  expect(fnObject?.identity).toMatchObject({ name: "okm_touch_updated_at", argTypes: [] });
  expect(fnObject?.provenance).toEqual({ origin: "trait", name: "timestamps" });
});

test("okm doctor explains a code and lists triggers", async () => {
  const explained: string[] = [];
  await run(["doctor", "OKM1823"], {
    stdout: (text) => explained.push(text),
  });
  expect(explained.join("")).toContain("search_path");

  const root = repoRoot();
  const cwd = mkdtempSync(join(tmpdir(), "okm-doctor-"));
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { fn, trigger } from ${JSON.stringify(join(root, "src/dialects/pg/fn/index.ts"))};`,
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'const tasks = table("tasks", { id: t.text().primaryKey() });',
        'const touch = fn("touch", { returns: "trigger", language: "plpgsql", body: "begin return new; end", dependsOn: [tasks] });',
        "export const app = schema({",
        "  tables: [tasks],",
        "  functions: [touch],",
        '  triggers: [trigger("tasks_touch", { on: tasks, timing: "before", events: ["update"], level: "row", calls: touch })],',
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        'export default defineConfig({ schema: "./schema.ts", migrations: "./migrations" });',
        "",
      ].join("\n"),
    );
    mkdirSync(join(cwd, "migrations"));
    const lines: string[] = [];
    await run(["doctor"], { cwd, stdout: (text) => lines.push(text) });
    expect(lines.join("")).toBe("tasks: tasks_touch\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function declared(returns: string, body: string) {
  const slug = fn("slugify", {
    arguments: [{ name: "title", type: "text" }],
    returns,
    language: "plpgsql",
    body,
    dependsOn: [tasks],
    ...(returns === "integer" ? { security: "definer" as const, searchPath: "public" } : {}),
  });
  return schema({
    tables: [tasks],
    functions: [slug],
    triggers: [
      trigger("tasks_touch", {
        on: tasks,
        timing: "before",
        events: ["update"],
        level: "row",
        calls: slug,
      }),
    ],
  });
}

function statements(
  before: ReturnType<typeof declared>["catalog"],
  after: ReturnType<typeof declared>["catalog"],
): string[] {
  return planMigration({ before, after, name: "move" }).steps.map((step) => step.sql);
}

function indexOf(sql: readonly string[], needle: string): number {
  const found = sql.findIndex((step) => step.includes(needle));
  expect(found, needle).toBeGreaterThanOrEqual(0);
  return found;
}

function capture(runBody: () => unknown): OkmError {
  try {
    runBody();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}
