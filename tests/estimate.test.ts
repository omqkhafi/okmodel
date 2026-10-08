/**
 * Lock lines with row estimates (D194).
 *
 * The phrases are display. `formatPlan` without a lock callback, and
 * `okm generate`, stay free of them. An unreachable target prints the
 * offline text and does not throw.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schema, table, t, index } from "../src/dialects/pg/index.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import {
  aboutRows,
  annotateLock,
  LARGE_TABLE_ROWS,
  renameAliases,
} from "../src/tooling/migrate/estimate.js";
import { formatPlan, planMigration, type PlanStep } from "../src/tooling/migrate/plan.js";

const root = repoRoot();

test("estimates use compact row counts and a note past one million", () => {
  expect(LARGE_TABLE_ROWS).toBe(1_000_000);
  expect(aboutRows(4_200_000)).toBe("about 4.2M rows");
  expect(aboutRows(1_000_000)).toBe("about 1M rows");
  expect(aboutRows(1_500)).toBe("about 1.5K rows");
  expect(aboutRows(12)).toBe("about 12 rows");
  expect(aboutRows(0)).toBe("about 0 rows");

  const alter = columnStep();
  const rows = new Map([["tasks", { kind: "rows" as const, reltuples: 4_200_000 }]]);
  expect(annotateLock(alter, rows)).toBe(
    "ACCESS EXCLUSIVE on tasks, about 4.2M rows; note: more than 1000000 estimated rows",
  );
  expect(annotateLock({ ...alter, safeRewrite: true }, rows)).toBe(
    "ACCESS EXCLUSIVE on tasks, about 4.2M rows; safe rewrite applied",
  );
  expect(annotateLock(alter, new Map([["tasks", { kind: "unknown" }]]))).toBe(
    "ACCESS EXCLUSIVE on tasks, rows unknown (table not analyzed)",
  );
  expect(annotateLock(alter, new Map())).toBe("ACCESS EXCLUSIVE on tasks, new table");

  const share: PlanStep = {
    ...alter,
    lock: "SHARE UPDATE EXCLUSIVE",
    safeRewrite: true,
  };
  expect(annotateLock(share, rows)).toBe(
    "SHARE UPDATE EXCLUSIVE on tasks, about 4.2M rows; safe rewrite applied",
  );
  const sharePlain: PlanStep = { ...alter, lock: "SHARE UPDATE EXCLUSIVE" };
  expect(annotateLock(sharePlain, rows)).toBe("SHARE UPDATE EXCLUSIVE on tasks, about 4.2M rows");

  const foreign: PlanStep = {
    ...alter,
    lock: 'ACCESS EXCLUSIVE; SHARE ROW EXCLUSIVE on "public"."users"',
    tables: ["tasks", "users"],
  };
  const both = new Map<string, { kind: "rows"; reltuples: number }>([
    ["tasks", { kind: "rows", reltuples: 4_200_000 }],
    ["users", { kind: "rows", reltuples: 12 }],
  ]);
  expect(annotateLock(foreign, both)).toBe(
    "ACCESS EXCLUSIVE on tasks, about 4.2M rows; SHARE ROW EXCLUSIVE on users, about 12 rows; note: more than 1000000 estimated rows",
  );
});

test("a safe rewrite is labelled and a file keeps the bare lock", () => {
  const before = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
  const after = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), title: t.text() },
        { indexes: (columns) => [index(columns.title)] },
      ),
    ],
  });
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: "index" });
  expect(plan.steps[0]?.safeRewrite).toBe(true);
  expect(plan.steps[0]?.tables).toEqual(["tasks"]);
  const offline = formatPlan(plan);
  expect(offline).toContain("-- lock: SHARE UPDATE EXCLUSIVE");
  expect(offline).not.toContain("safe rewrite applied");
  expect(offline).not.toContain("about");
  const printed = formatPlan(plan, (step) =>
    annotateLock(step, new Map([["tasks", { kind: "rows", reltuples: 3 }]])),
  );
  expect(printed).toContain(
    "-- lock: SHARE UPDATE EXCLUSIVE on tasks, about 3 rows; safe rewrite applied",
  );
  expect(formatPlan(plan)).toBe(offline);
});

test("an added column names the table and a rename does not name the new column", () => {
  const before = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
  const added = planMigration({
    before: before.catalog,
    after: schema({
      tables: [table("tasks", { id: t.identity(), title: t.text(), note: t.text().nullable() })],
    }).catalog,
    name: "note",
  });
  const column = added.steps.find((step) => step.kind === "add-column");
  expect(column?.tables).toEqual(["tasks"]);
  expect(column?.safeRewrite).toBeUndefined();

  const renamed = planMigration({
    before: before.catalog,
    after: schema({
      tables: [table("tasks", { id: t.identity(), heading: t.text().renamedFrom("title") })],
    }).catalog,
    renames: [{ kind: "column", table: "tasks", from: "title", to: "heading" }],
    name: "rename",
  });
  const rename = renamed.steps.find((step) => step.kind === "rename-column");
  expect(rename?.sql).toContain("rename column");
  expect(rename?.tables).toEqual(["tasks"]);
});

test("QA-L6: a renamed table uses the old table's row estimate", () => {
  const before = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
  const after = schema({
    tables: [
      table(
        "items",
        { id: t.identity(), title: t.text(), note: t.text().nullable() },
        { renamedFrom: "tasks" },
      ),
    ],
  });
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    renames: [{ kind: "table", from: "tasks", to: "items" }],
    name: "rename",
  });
  const added = plan.steps.find((step) => step.kind === "add-column");
  expect(added?.tables).toEqual(["items"]);
  const estimates = new Map([["tasks", { kind: "rows" as const, reltuples: 42 }]]);
  const text = annotateLock(added ?? columnStep(), estimates, renameAliases(plan.steps));
  expect(text).toContain("about 42 rows");
  expect(text).not.toContain("new table");
});

test("no target, an unreachable target, and a pooler host print the offline plan", async () => {
  const offline = await projectPlan();
  const refused = await projectPlan({ url: "postgres://okm:okm@127.0.0.1:1/okm" });
  expect(refused).toBe(offline);
  const pooler = await projectPlan({ url: "postgres://okm:okm@db.pooler.invalid:1/okm" });
  expect(pooler).toBe(offline);
  const several = await projectPlan(undefined, {
    targets: `{
      dev: { url: "postgres://okm:okm@127.0.0.1:1/okm" },
      live: { url: "postgres://okm:okm@127.0.0.1:1/other", protected: true },
    }`,
  });
  expect(several).toBe(offline);
  expect(offline).not.toContain("about");
  expect(offline).not.toContain("new table");
  expect(offline).not.toContain("safe rewrite");
}, 20_000);

test("okm generate does not write estimates", async () => {
  const cwd = writeProject();
  try {
    const lines: string[] = [];
    await run(["generate", "create"], { cwd, stdout: (text) => lines.push(text) });
    const directory = join(cwd, "migrations");
    const files = readdirSync(directory);
    expect(files.some((file) => file.endsWith(".sql"))).toBe(true);
    for (const file of files) {
      const text = readFileSync(join(directory, file), "utf8");
      expect(text).not.toContain("about");
      expect(text).not.toContain("rows unknown");
      expect(text).not.toContain("new table");
      expect(text).not.toContain("safe rewrite applied");
      expect(text).not.toContain("estimated rows");
      expect(text).not.toContain("reltuples");
    }
    expect(lines.join("")).not.toContain("about");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function columnStep(): PlanStep {
  return {
    sql: 'alter table "public"."tasks" add column "note" text',
    class: "expand",
    kind: "add-column",
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: true,
    tables: ["tasks"],
  };
}

async function projectPlan(
  database?: { readonly url: string },
  extra?: { readonly targets: string },
): Promise<string> {
  const cwd = writeProject(database, extra);
  try {
    const lines: string[] = [];
    await run(["migrate", "plan", "create"], { cwd, stdout: (text) => lines.push(text) });
    return lines.join("");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writeProject(
  database?: { readonly url: string },
  extra?: { readonly targets: string },
): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-estimate-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { identity, schema, table, text } from ${pg};\nexport const app = schema({ tables: [table("tasks", { id: identity(), title: text() })] });\n`,
  );
  const target =
    extra !== undefined
      ? `targets: ${extra.targets},`
      : database === undefined
        ? ""
        : `database: { url: ${JSON.stringify(database.url)} },`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      target,
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "migrations"));
  return cwd;
}
