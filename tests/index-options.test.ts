/**
 * Index options and comments that do not need a server.
 *
 * The planner emits a storage replace and a comment. Shape checks refuse a
 * unique gin index and a name past 63 bytes.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { index, schema, sql, table, t } from "../src/dialects/pg/index.js";
import { assertIndexRules } from "../src/tooling/migrate/index-rules.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { unmanagedComments } from "../src/tooling/migrate/drift.js";

test("OKM1903 refuses unique on gin and OKM1122 refuses a long index name", () => {
  const gin = schema({
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey(), title: t.text() },
        { indexes: (columns) => [index(columns.title).unique().using("gin")] },
      ),
    ],
  });
  expect(codeOf(() => assertIndexRules(gin.catalog))).toBe("OKM1903");
  const long = schema({
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey(), title: t.text() },
        { indexes: (columns) => [index(columns.title).name("n".repeat(64))] },
      ),
    ],
  });
  expect(codeOf(() => assertIndexRules(long.catalog))).toBe("OKM1122");
});

test("a storage change is a concurrent replace and a comment is its own step", () => {
  const before = notes(90);
  const after = notes(80);
  const steps = planMigration({ before: before.catalog, after: after.catalog, name: "fill" }).steps;
  const sqlText = steps.map((step) => step.sql).join("\n");
  expect(sqlText).toContain("drop index concurrently if exists");
  expect(sqlText).toContain("create index concurrently");
  expect(sqlText).toContain("fillfactor=80");
  expect(sqlText).toContain("rename to");
  expect(sqlText.toLowerCase().includes("set (")).toBe(false);
  expect(steps.some((step) => step.transactional === false)).toBe(true);
});

test("a comment OKM wrote is removed and a missing snapshot comment is not", () => {
  const declared = commented("Login lookup.");
  const empty = commented(undefined);
  const removed = planMigration({
    before: declared.catalog,
    after: empty.catalog,
    name: "drop-comment",
  }).steps.map((step) => step.sql);
  expect(
    removed.some((step) => step.toLowerCase().startsWith("comment on") && step.includes("null")),
  ).toBe(true);
  const untouched = planMigration({
    before: catalog([]),
    after: empty.catalog,
    name: "create",
  }).steps.map((step) => step.sql);
  expect(untouched.some((step) => step.toLowerCase().includes("is null"))).toBe(false);
  const added = planMigration({
    before: empty.catalog,
    after: declared.catalog,
    name: "add-comment",
  }).steps.map((step) => step.sql);
  expect(added.some((step) => step.includes("Login lookup."))).toBe(true);
});

test("pull writes where, using, and comment instead of a spread", async () => {
  const { emitPull } = await import("../src/tooling/migrate/pull-emit.js");
  const built = schema({
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey(), email: t.text() },
        {
          indexes: (columns) => [
            index(columns.email)
              .where(sql`email = 'a@b.c'`)
              .comment("lookup"),
            index(sql`lower(email)`).name("notes_email_lower"),
          ],
        },
      ),
    ],
  });
  const emitted = emitPull(
    built.catalog,
    { schemaFile: "/tmp/okm-pull/schema.ts", tablesDir: "/tmp/okm-pull/tables" },
    undefined,
    { importExt: "ts" },
  );
  const text = emitted.files.map((file) => file.text).join("\n");
  expect(text).toContain(".where(");
  expect(text).toContain(".comment(");
  expect(text).toContain("sql`");
  expect(text.includes("predicate:")).toBe(false);
  expect(text.includes("expression:")).toBe(false);
});

test("a DBA comment is information and a snapshot comment stays for removal", () => {
  const author = commented(undefined).catalog;
  const live = {
    ...author,
    objects: author.objects.map((object) =>
      object.kind === "table" ? { ...object, comment: "from the dba" } : object,
    ),
  };
  const open = unmanagedComments(live, author, catalog([]));
  expect(open.information.some((line) => line.startsWith("OKM2107"))).toBe(true);
  expect(open.catalog.objects.find((object) => object.kind === "table")?.comment).toBeUndefined();
  const owned = unmanagedComments(live, author, live);
  expect(owned.catalog.objects.find((object) => object.kind === "table")?.comment).toBe(
    "from the dba",
  );
});

function notes(fillfactor: number) {
  return schema({
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey(), email: t.text() },
        {
          indexes: (columns) => [index(columns.email).with({ fillfactor })],
        },
      ),
    ],
  });
}

function commented(text: string | undefined) {
  return schema({
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey(), email: t.text() },
        {
          indexes: (columns) => {
            const call = index(columns.email);
            return text === undefined ? [call] : [call.comment(text)];
          },
        },
      ),
    ],
  });
}

function codeOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof OkmError ? error.code : undefined;
  }
}
