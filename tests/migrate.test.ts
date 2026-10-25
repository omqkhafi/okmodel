/**
 * Migration planning: renames, D131 replacements, the trusted catalog loader,
 * and the `okm` commands that write SQL.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import {
  column as catalogColumn,
  index as catalogIndex,
  table as catalogTable,
} from "../src/contracts/catalog/object.js";
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
import { index, schema, sql, table, t } from "../src/dialects/pg/index.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import {
  planMigration,
  staleRenames,
  type MigrationPlan,
  type PlanStep,
} from "../src/tooling/migrate/plan.js";
import { extensionStatement } from "../src/tooling/migrate/extensions.js";
import { retargetSteps } from "../src/tooling/migrate/sandbox.js";
import { unlistedTableFiles } from "../src/tooling/migrate/project.js";
import { parseReplace } from "../src/tooling/migrate/values.js";

const namespace = staticNamespace("public");

test("check replay retargets CREATE EXTENSION schema", () => {
  const scratch = "okm_check_abc";
  const steps = retargetSteps(
    [
      replayStep('create extension "citext" schema "public"'),
      replayStep('alter default privileges in schema "public" grant select on tables to "app"'),
      replayStep('grant usage on schema "public" to "app"'),
      replayStep('create table "public"."people" ("email" citext not null)'),
    ],
    scratch,
  );
  expect(steps.map((item) => item.sql)).toEqual([
    `create extension "citext" schema "${scratch}"`,
    `alter default privileges in schema "${scratch}" grant select on tables to "app"`,
    `grant usage on schema "${scratch}" to "app"`,
    `create table "${scratch}"."people" ("email" citext not null)`,
  ]);
  const moved = retargetSteps(
    [replayStep('create extension "citext" schema "tenant"')],
    scratch,
    "tenant",
  );
  expect(moved[0]?.sql).toBe(`create extension "citext" schema "${scratch}"`);
});

test("check replay retargets identifiers only, never a string or a comment (N-99)", () => {
  const scratch = "okm_check_abc";
  const steps = retargetSteps(
    [
      replayStep(
        `alter table "public"."notes" alter column "hint" set default 'see schema "public"'`,
      ),
      replayStep(`comment on table "public"."notes" is 'a "public"."notes" table'`),
      replayStep(`select 1 -- schema "public"\n; select 2 /* "public"."x" */`),
      {
        ...replayStep('create table "public"."notes" ("id" int)'),
        action: "backfill" as const,
        backfill: { table: '"public"."notes"', key: ['"id"'], batch: 100 },
      },
    ],
    scratch,
  );
  expect(steps.map((item) => item.sql)).toEqual([
    `alter table "${scratch}"."notes" alter column "hint" set default 'see schema "public"'`,
    `comment on table "${scratch}"."notes" is 'a "public"."notes" table'`,
    `select 1 -- schema "public"\n; select 2 /* "public"."x" */`,
    `create table "${scratch}"."notes" ("id" int)`,
  ]);
  expect(steps[3]?.backfill?.table).toBe(`"${scratch}"."notes"`);
});

test("extensionStatement reads every extension form the planner writes", () => {
  expect(extensionStatement('create extension "citext" schema "public" version \'1.6\'')).toEqual({
    kind: "create",
    name: "citext",
    schema: "public",
  });
  expect(extensionStatement("CREATE EXTENSION IF NOT EXISTS Pg_Trgm")).toEqual({
    kind: "create",
    name: "pg_trgm",
  });
  expect(extensionStatement('drop extension "citext"')).toEqual({
    kind: "drop",
    names: ["citext"],
    ifExists: false,
    cascade: false,
  });
  expect(extensionStatement('drop extension if exists "a", b, "c,d" cascade')).toEqual({
    kind: "drop",
    names: ["a", "b", "c,d"],
    ifExists: true,
    cascade: true,
  });
  expect(extensionStatement('alter extension "citext" set schema "tenant"')).toEqual({
    kind: "set-schema",
    name: "citext",
    schema: "tenant",
  });
  expect(extensionStatement(`alter extension "citext" update to '1.7'`)).toEqual({
    kind: "update",
    name: "citext",
    version: "1.7",
  });
  expect(extensionStatement('alter extension "citext" add function f()')).toEqual({
    kind: "other",
    name: "citext",
  });
  expect(extensionStatement('create table "extension" (id int)')).toBeUndefined();
  expect(extensionStatement("select 1")).toBeUndefined();
});

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

test("an identity sequence is not planned as its own statement", () => {
  const empty = catalog([]);
  const created = schema({
    tables: [table("authors", { id: t.identity(), name: t.text() })],
  });
  const createSql = sqlOf(planMigration({ before: empty, after: created.catalog, name: "create" }));
  expect(createSql).toContain("generated always as identity");
  expect(createSql).not.toContain("create sequence");

  const books = schema({ tables: [table("books", { title: t.text() })] });
  const booksId = schema({
    tables: [table("books", { title: t.text(), id: t.identity() })],
  });
  const addSql = sqlOf(
    planMigration({ before: books.catalog, after: booksId.catalog, name: "add" }),
  );
  expect(addSql).toContain("add column");
  expect(addSql).toContain("generated always as identity");
  expect(addSql).not.toContain("create sequence");

  const dropTableSql = sqlOf(
    planMigration({ before: created.catalog, after: empty, name: "drop-table" }),
  );
  expect(dropTableSql).toContain("drop table");
  expect(dropTableSql).not.toContain("drop sequence");

  const plain = schema({ tables: [table("authors", { id: t.bigint(), name: t.text() })] });
  const dropIdentitySql = sqlOf(
    planMigration({ before: created.catalog, after: plain.catalog, name: "drop-identity" }),
  );
  expect(dropIdentitySql).toContain("drop identity");
  expect(dropIdentitySql).not.toContain("drop sequence");
  expect(dropIdentitySql).not.toContain("drop column");
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

test("a table drop and add without renamedFrom is OKM1530", () => {
  const before = schema({ tables: [table("tasks", { id: t.identity() })] });
  const after = schema({ tables: [table("items", { id: t.identity() })] });
  const error = capture(() =>
    planMigration({ before: before.catalog, after: after.catalog, name: "rename" }),
  );
  expect(error.code).toBe("OKM1530");
  expect(error.fix.summary).toContain('renamedFrom: "tasks"');
  expect(error.message).not.toContain("casing");
});

test("a casing change names casing as the cause of OKM1530", () => {
  const columnBefore = schema({
    tables: [table("notes", { id: t.identity(), publishedAt: t.timestamptz().nullable() })],
  });
  const columnAfter = schema({
    tables: [table("notes", { id: t.identity(), publishedAt: t.timestamptz().nullable() })],
    casing: "snake",
  });
  const column = capture(() =>
    planMigration({ before: columnBefore.catalog, after: columnAfter.catalog, name: "casing" }),
  );
  expect(column.code).toBe("OKM1530");
  expect(column.message).toContain("caused by casing");
  expect(column.message).toContain('.sqlName("publishedAt")');
  expect(column.message).toContain('.renamedFrom("publishedAt")');
  expect(column.fix.summary).toContain('.sqlName("publishedAt")');
  expect(column.fix.summary).toContain('.renamedFrom("publishedAt")');

  const tableBefore = schema({
    tables: [table("userNotes", { id: t.identity() })],
  });
  const tableAfter = schema({
    tables: [table("userNotes", { id: t.identity() })],
    casing: "snake",
  });
  const renamed = capture(() =>
    planMigration({ before: tableBefore.catalog, after: tableAfter.catalog, name: "casing" }),
  );
  expect(renamed.code).toBe("OKM1530");
  expect(renamed.message).toContain("caused by casing");
  expect(renamed.message).toContain('.sqlName("userNotes")');
  expect(renamed.message).toContain('sqlName: "userNotes"');
  expect(renamed.message).toContain('.renamedFrom("userNotes")');
  expect(renamed.message).toContain('renamedFrom: "userNotes"');

  const camel = schema({
    tables: [table("user_notes", { id: t.identity(), user_id: t.bigint() })],
    casing: "camel",
  });
  const fromSnake = capture(() =>
    planMigration({ before: tableAfter.catalog, after: camel.catalog, name: "camel" }),
  );
  expect(fromSnake.code).toBe("OKM1530");
  expect(fromSnake.message).toContain("caused by casing");
});

test("a column rename renames the identity sequence derived from that column", () => {
  const before = schema({
    tables: [table("notes", { entryId: t.identity(), title: t.text() })],
  });
  const after = schema({
    tables: [table("notes", { noteId: t.identity().renamedFrom("entryId"), title: t.text() })],
  });
  const text = sqlOf(
    planMigration({
      before: before.catalog,
      after: after.catalog,
      renames: schemaDeclarations(after).renames,
      name: "rename-column",
    }),
  );
  expect(text).toContain('rename column "entryid" to "noteid"');
  expect(text).toContain(
    'alter sequence "public"."notes_entryid_seq" rename to "notes_noteid_seq"',
  );
  expect(text).not.toContain("drop sequence");
  expect(text).not.toContain("create sequence");

  const moved = schema({
    tables: [
      table(
        "items",
        { noteId: t.identity().renamedFrom("entryId"), title: t.text() },
        { renamedFrom: "notes" },
      ),
    ],
  });
  const both = sqlOf(
    planMigration({
      before: before.catalog,
      after: moved.catalog,
      renames: schemaDeclarations(moved).renames,
      name: "rename-both",
    }),
  );
  const tableSequence = both.indexOf(
    'alter sequence "public"."notes_entryid_seq" rename to "items_entryid_seq"',
  );
  const columnSequence = both.indexOf(
    'alter sequence "public"."items_entryid_seq" rename to "items_noteid_seq"',
  );
  expect(tableSequence).toBeGreaterThanOrEqual(0);
  expect(columnSequence).toBeGreaterThan(tableSequence);

  const plain = schema({
    tables: [table("notes", { entryId: t.bigint().primaryKey(), title: t.text() })],
  });
  const renamedPlain = schema({
    tables: [
      table("notes", { noteId: t.bigint().primaryKey().renamedFrom("entryId"), title: t.text() }),
    ],
  });
  const plainText = sqlOf(
    planMigration({
      before: plain.catalog,
      after: renamedPlain.catalog,
      renames: schemaDeclarations(renamedPlain).renames,
      name: "rename-plain",
    }),
  );
  expect(plainText).toContain('rename column "entryid" to "noteid"');
  expect(plainText).not.toContain("sequence");
});

test("a declared table rename renames default dependents and leaves a custom name", () => {
  const before = schema({
    tables: [
      table("users", {
        id: t.integer().primaryKey(),
        taskId: t.bigint().nullable().references("tasks"),
      }),
      table(
        "tasks",
        {
          id: t.identity(),
          email: t.text().unique(),
          userId: t.integer().nullable().references("users"),
        },
        { indexes: (columns) => [index(columns.email).unique()] },
      ),
    ],
  });
  const after = schema({
    tables: [
      table("users", {
        id: t.integer().primaryKey(),
        taskId: t.bigint().nullable().references("items"),
      }),
      table(
        "items",
        {
          id: t.identity(),
          userId: t.integer().nullable().references("users"),
          contact: t.text().unique().renamedFrom("email"),
        },
        {
          indexes: (columns) => [index(columns.contact).unique()],
          renamedFrom: "tasks",
        },
      ),
    ],
  });
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    renames: schemaDeclarations(after).renames,
    name: "rename-table",
  });
  const text = plan.steps.map((step) => step.sql).join("\n");
  expect(text).toContain('alter table "public"."tasks" rename to "items"');
  expect(text).toContain('rename constraint "tasks_pkey" to "items_pkey"');
  expect(text).toContain('rename constraint "tasks_email_key" to "items_contact_key"');
  expect(text).toContain('rename constraint "tasks_userId_fkey" to "items_userId_fkey"');
  expect(text).toContain('alter index "public"."tasks_email_idx" rename to "items_contact_idx"');
  const constraintRename = plan.steps.find((step) => step.sql.includes("rename constraint"));
  const indexRename = plan.steps.find(
    (step) => step.action === "ddl" && step.sql.includes("alter index"),
  );
  expect(constraintRename?.lock).toBe("ACCESS EXCLUSIVE");
  expect(indexRename?.lock).toBe("SHARE UPDATE EXCLUSIVE");
  expect(text).toContain('alter sequence "public"."tasks_id_seq" rename to "items_id_seq"');
  expect(text).toContain('rename column "email" to "contact"');
  expect(text).not.toContain("drop table");

  const provenance = { origin: "file" as const, name: "custom" };
  const customBefore = catalog([
    catalogTable({ namespace, name: "tasks", provenance }),
    catalogColumn({
      parent: { namespace, name: "tasks" },
      name: "id",
      dataType: "bigint",
      nullable: false,
      provenance,
    }),
    catalogIndex({
      parent: { namespace, name: "tasks" },
      columns: ["id"],
      name: "tasks_id_custom",
      provenance,
    }),
  ]);
  const customAfter = catalog([
    catalogTable({ namespace, name: "items", provenance }),
    catalogColumn({
      parent: { namespace, name: "items" },
      name: "id",
      dataType: "bigint",
      nullable: false,
      provenance,
    }),
    catalogIndex({
      parent: { namespace, name: "items" },
      columns: ["id"],
      name: "tasks_id_custom",
      provenance,
    }),
  ]);
  const custom = planMigration({
    before: customBefore,
    after: customAfter,
    renames: [{ kind: "table", from: "tasks", to: "items" }],
    name: "custom",
  });
  const customSql = custom.steps.map((step) => step.sql).join("\n");
  expect(customSql).toContain('rename to "items"');
  expect(customSql).not.toContain("tasks_id_custom");
  expect(customSql).not.toContain("items_id_idx");
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
  const labels = before.catalog.objects.find((object) => object.kind === "type");
  expect(
    labels?.kind === "type" && "labels" in labels.definition ? labels.definition.labels : [],
  ).toEqual(["a", "b"]);
  const missing = capture(() =>
    planMigration({ before: before.catalog, after: after.catalog, name: "enum" }),
  );
  expect(missing.code).toBe("OKM1541");
  expect(missing.fix.summary).toContain("--replace tasks.status.a=");

  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    replacements: [parseReplace("tasks.status.a=b")],
    name: "enum",
  });
  const sqlText = plan.steps.map((step) => step.sql).join("\n");
  expect(sqlText).toContain("update ");
  expect(plan.steps.some((step) => step.action === "backfill")).toBe(true);
  expect(sqlText).toContain("create type");
  expect(sqlText).toContain("::text::");
  expect(sqlText).toContain("drop type");
  const expand = plan.steps.findIndex(
    (step) => step.action === "backfill" && step.class === "expand",
  );
  const rename = plan.steps.findIndex((step) => step.sql.includes("rename to"));
  expect(expand).toBeGreaterThanOrEqual(0);
  expect(expand).toBeLessThan(rename);
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

test("a table file stem matches the schema text without case sensitivity", () => {
  expect(unlistedTableFiles('import { tasks } from "./tasks";', ["Tasks.ts"])).toEqual([]);
  expect(unlistedTableFiles('import { tasks } from "./tasks";', ["Tasks.ts", "Extra.ts"])).toEqual([
    "Extra.ts",
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
        `import { enumColumn } from ${JSON.stringify(join(root, "src/dialects/pg/enum.ts"))};`,
        `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        "export const app = schema({",
        '  tables: [table("tasks", { id: identity(), title: text(), status: enumColumn("color", ["red", "blue"]) })],',
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
    expect(types).toContain('"red" | "blue"');
    expect(types).toContain("references(");
    expect(existsSync(join(cwd, ".okm/declarations.json"))).toBe(false);
    expect(types).not.toContain("okmodel/pg/postgresjs");
    const hash = readFileSync(join(cwd, ".okm/catalog.hash"), "utf8").trim();
    const catalogText = readFileSync(join(cwd, ".okm/catalog.json"), "utf8");
    expect(catalogText).toContain('"kind":"type"');
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
    expect(sqlText.toLowerCase()).toContain("create type");
    expect(sqlText.toLowerCase()).toContain("create table");
    expect(existsSync(sqlPath.replace(/\.sql$/, ".declarations.json"))).toBe(false);
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

test("okm build keeps a jsonb type argument", async () => {
  const root = repoRoot();
  const cwd = mkdtempSync(join(tmpdir(), "okm-jsonb-"));
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        "export const app = schema({",
        '  tables: [table("posts", {',
        "    id: t.text().primaryKey(),",
        "    meta: t.jsonb<{ published?: boolean }>(),",
        "  })],",
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
        '  migrations: "./migrations",',
        '  out: "./.okm",',
        "});",
        "",
      ].join("\n"),
    );
    await run(["build"], { cwd, stdout: () => undefined });
    const types = readFileSync(join(cwd, ".okm/types.d.ts"), "utf8");
    expect(types).toContain("readonly meta: jsonb<{ published?: boolean }>;");
    expect(types).toContain("export type jsonb<T> = T;");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function replayStep(sql: string): PlanStep {
  return {
    sql,
    class: "expand",
    action: "ddl",
    lock: "AccessShareLock",
    transactional: true,
  };
}

function sqlOf(plan: MigrationPlan): string {
  return plan.steps
    .map((step) => step.sql)
    .join("\n")
    .toLowerCase();
}

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
