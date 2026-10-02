/**
 * Migration planning: renames, D131 replacements, the trusted catalog loader,
 * and the `okm` commands that write SQL.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import {
  catalogHash,
  loadTrustedCatalog,
  parseCatalog,
  renameColumn,
  serializeCatalog,
} from "../src/contracts/catalog/document.js";
import { staticNamespace } from "../src/contracts/catalog/identity.js";
import { sha256 } from "../src/contracts/sha256.js";
import { OkmError } from "../src/contracts/error.js";
import { schemaDeclarations } from "../src/dialects/pg/declarations.js";
import { schema, sql, table, t } from "../src/dialects/pg/index.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { planMigration, staleRenames } from "../src/tooling/migrate/plan.js";
import { unlistedTableFiles } from "../src/tooling/migrate/project.js";
import { parseReplace } from "../src/tooling/migrate/values.js";

const namespace = staticNamespace("public");

test("rename rewrites expression text and the plan does not recreate the check", () => {
  const before = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), email: t.text() },
        { checks: { present: (columns) => sql`${columns.email} <> ''` } },
      ),
    ],
  });
  const after = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), contact: t.text().renamedFrom("email") },
        { checks: { present: (columns) => sql`${columns.contact} <> ''` } },
      ),
    ],
  });
  const rewritten = renameColumn(before.catalog, {
    parent: { namespace, name: "tasks" },
    from: "email",
    to: "contact",
  });
  const check = rewritten.objects.find(
    (object) => object.kind === "constraint" && object.definition.constraintKind === "check",
  );
  expect(check?.kind === "constraint" ? check.definition.expression : "").toContain("contact");

  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    renames: schemaDeclarations(after).renames,
    name: "rename-email",
  });
  const sqlText = plan.steps.map((step) => step.sql).join("\n");
  expect(sqlText).toContain("rename column");
  expect(sqlText.toLowerCase()).not.toContain("cascade");
  expect(sqlText.toLowerCase()).not.toContain("drop constraint");
  expect(plan.class).toBe("contract");
});

test("an unexplained drop and add is OKM1530 and shows the line to add", () => {
  const before = schema({
    tables: [table("tasks", { id: t.identity(), title: t.text() })],
  });
  const after = schema({
    tables: [table("tasks", { id: t.identity(), name: t.text() })],
  });
  const error = capture(() =>
    planMigration({ before: before.catalog, after: after.catalog, name: "rename" }),
  );
  expect(error.code).toBe("OKM1530");
  expect(error.fix.summary).toContain('.renamedFrom("title")');
  expect(error.fix.summary).toContain("name");
});

test("picklist removal requires --replace and then plans expand and contract", () => {
  const before = schema({
    tables: [table("tasks", { id: t.identity(), status: t.text().picklist(["a", "b", "c"]) })],
  });
  const after = schema({
    tables: [table("tasks", { id: t.identity(), status: t.text().picklist(["b"]) })],
  });
  const missing = capture(() =>
    planMigration({ before: before.catalog, after: after.catalog, name: "drop-a" }),
  );
  expect(missing.code).toBe("OKM1541");
  expect(missing.fix.summary).toContain("--replace tasks.status.a=");

  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    replacements: [parseReplace("tasks.status.a=b"), parseReplace("tasks.status.c=b")],
    name: "drop-a",
  });
  const updates = plan.steps.filter((step) => step.action === "backfill");
  expect(updates.length).toBe(4);
  expect(updates.every((step) => step.sql.includes(`= 'b'`) && step.sql.includes("where"))).toBe(
    true,
  );
  expect(plan.steps.some((step) => step.class === "expand" && step.action === "backfill")).toBe(
    true,
  );
  expect(plan.steps.some((step) => step.sql.includes("not valid"))).toBe(true);
  expect(plan.steps.some((step) => step.sql.includes("validate constraint"))).toBe(true);
  expect(plan.class).toBe("contract");
  expect(
    plan.steps
      .map((step) => step.sql)
      .join("\n")
      .toLowerCase(),
  ).not.toContain("cascade");
});

test("null replacement and chains follow D131", () => {
  const before = schema({
    tables: [
      table("tasks", { id: t.identity(), status: t.text().nullable().picklist(["a", "b", "c"]) }),
    ],
  });
  const after = schema({
    tables: [table("tasks", { id: t.identity(), status: t.text().nullable().picklist(["b"]) })],
  });
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    replacements: [parseReplace("tasks.status.a=null"), parseReplace("tasks.status.c=null")],
    name: "nulls",
  });
  expect(plan.steps.some((step) => step.sql.includes("= null"))).toBe(true);

  const chained = capture(() =>
    planMigration({
      before: before.catalog,
      after: after.catalog,
      replacements: [parseReplace("tasks.status.a=c"), parseReplace("tasks.status.c=b")],
      name: "chain",
    }),
  );
  expect(chained.code).toBe("OKM1541");

  const outside = capture(() =>
    planMigration({
      before: before.catalog,
      after: after.catalog,
      replacements: [parseReplace("tasks.status.a=z"), parseReplace("tasks.status.c=b")],
      name: "outside",
    }),
  );
  expect(outside.code).toBe("OKM1541");
  expect(outside.message).toContain("not in the new list");
});

test("enum removal plans a backfill and a type recreate", () => {
  const before = schema({
    tables: [table("tasks", { id: t.identity(), status: t.enum("status", ["a", "b"]) })],
  });
  const after = schema({
    tables: [table("tasks", { id: t.identity(), status: t.enum("status", ["b"]) })],
  });
  expect(schemaDeclarations(before).enums[0]?.labels).toEqual(["a", "b"]);
  expect(schemaDeclarations(after).enums[0]?.labels).toEqual(["b"]);
  const stored = schema({
    tables: [table("tasks", { id: t.identity(), status: t.text() })],
  }).catalog;
  const missing = capture(() =>
    planMigration({
      before: stored,
      after: stored,
      enumsBefore: schemaDeclarations(before).enums,
      enumsAfter: schemaDeclarations(after).enums,
      name: "enum",
    }),
  );
  expect(missing.code).toBe("OKM1541");
  expect(missing.fix.summary).toContain("--replace tasks.status.a=");

  const plan = planMigration({
    before: stored,
    after: stored,
    enumsBefore: schemaDeclarations(before).enums,
    enumsAfter: schemaDeclarations(after).enums,
    replacements: [parseReplace("tasks.status.a=b")],
    name: "enum",
  });
  const sqlText = plan.steps.map((step) => step.sql).join("\n");
  expect(sqlText).toContain("update ");
  expect(plan.steps.some((step) => step.action === "backfill")).toBe(true);
  expect(sqlText).toContain("create type");
  expect(sqlText).toContain("::text::");
  expect(sqlText).toContain("drop type");
});

test("stale renames need a previous snapshot that still has the old name", () => {
  const current = schema({
    tables: [table("tasks", { id: t.identity(), contact: t.text().renamedFrom("email") })],
  });
  const previous = schema({
    tables: [table("tasks", { id: t.identity(), email: t.text() })],
  });
  const renames = schemaDeclarations(current).renames;
  expect(staleRenames(undefined, renames)).toEqual([]);
  expect(staleRenames(previous.catalog, renames)).toEqual([]);
  expect(staleRenames(catalog([]), renames).length).toBe(1);
});

test("unlisted table files are the ones the schema source does not mention", () => {
  expect(unlistedTableFiles('import { tasks } from "./tasks";', ["tasks.ts", "extra.ts"])).toEqual([
    "extra.ts",
  ]);
});

test("trusted loader checks the hash and does not rebuild the catalog", () => {
  const built = schema({
    tables: [table("tasks", { id: t.identity(), title: t.text() })],
  }).catalog;
  const text = serializeCatalog(built);
  const loaded = loadTrustedCatalog(text, catalogHash(built));
  expect(serializeCatalog(loaded)).toBe(text);
  expect(serializeCatalog(parseCatalog(text))).toBe(text);

  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.objects)) {
    throw new Error("catalog json");
  }
  const objects = parsed.objects.filter((object) => !isRecord(object) || object.kind !== "table");
  const hand = JSON.stringify({ version: 1, objects });
  const trusted = loadTrustedCatalog(hand, sha256(hand));
  expect(trusted.objects.length).toBe(objects.length);
  expect(() => parseCatalog(hand)).toThrow(OkmError);

  expect(() => loadTrustedCatalog(text, "00")).toThrow(OkmError);
  const wrong = JSON.stringify({ version: 9, objects: [] });
  expect(() => loadTrustedCatalog(wrong, sha256(wrong))).toThrow(OkmError);
});

test("okm generate writes SQL and okm migrate plan prints the class", async () => {
  const root = repoRoot();
  const cwd = mkdtempSync(join(tmpdir(), "okm-migrate-"));
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        "export const app = schema({",
        '  tables: [table("tasks", { id: identity(), title: text() })],',
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        '  tables: "./tables",',
        '  migrations: "./migrations",',
        '  out: "./.okm",',
        "});",
        "",
      ].join("\n"),
    );
    mkdirSync(join(cwd, "tables"));
    writeFileSync(join(cwd, "tables/tasks.ts"), "export const tasks = true;\n");
    const lines: string[] = [];
    await run(["build"], { cwd, stdout: (text) => lines.push(text) });
    const types = readFileSync(join(cwd, ".okm/types.d.ts"), "utf8");
    expect(types).toContain("export type TableName");
    expect(types).toContain("references(");
    expect(types).not.toContain("okmodel/pg/postgresjs");
    const hash = readFileSync(join(cwd, ".okm/catalog.hash"), "utf8").trim();
    const catalogText = readFileSync(join(cwd, ".okm/catalog.json"), "utf8");
    expect(serializeCatalog(loadTrustedCatalog(catalogText, hash))).toBe(
      serializeCatalog(parseCatalog(catalogText)),
    );

    lines.length = 0;
    await run(["check"], { cwd, stdout: (text) => lines.push(text) });
    expect(lines.join("")).toContain("ok");

    writeFileSync(join(cwd, "tables/extra.ts"), "export const extra = true;\n");
    const unlisted = await rejectRun(["check"], cwd);
    expect(unlisted.code).toBe("OKM1024");

    lines.length = 0;
    await run(["generate"], { cwd, stdout: (text) => lines.push(text) });
    const sqlPath = lines.join("").trim();
    const sqlText = readFileSync(sqlPath, "utf8");
    expect(sqlPath.endsWith(".sql")).toBe(true);
    expect(sqlText.toLowerCase()).toContain("create table");
    expect(sqlText).not.toContain("export ");
    expect(sqlText).toContain("-- class:");

    lines.length = 0;
    await run(["migrate", "plan", "again"], { cwd, stdout: (text) => lines.push(text) });
    const printed = lines.join("");
    expect(printed).toContain("-- class:");
    expect(printed).not.toContain("export ");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function capture(fn: () => void): OkmError {
  try {
    fn();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

async function rejectRun(argv: readonly string[], cwd: string): Promise<OkmError> {
  try {
    await run(argv, { cwd, stdout: () => {} });
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
