/**
 * Archive columns, partial uniques, and cascade checks. Postgres behavior is
 * `archive-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import type { Catalog, ColumnObject, IndexObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { id, index, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { explainArchive } from "../src/runtime/archive.js";
import { archivable } from "../src/runtime/traits/index.js";
import { app, tenantApp } from "./archive-schema.js";

test("archivable adds the two columns and turns uniques into partial indexes", () => {
  const at = columnOf(app.catalog, "archived_at", "lists");
  const idColumn = columnOf(app.catalog, "archive_id", "lists");
  expect(at?.definition).toMatchObject({ dataType: "timestamptz", nullable: true });
  expect(idColumn?.definition).toMatchObject({ dataType: "uuid", nullable: true });
  expect(at?.provenance).toMatchObject({ origin: "trait", name: "archivable" });
  expect(columnOf(app.catalog, "archived_at", "notes")).toBeUndefined();

  const sql = renderCatalog(app.catalog, "public").join("\n");
  expect(sql).toContain("create unique index");
  expect(sql).toContain('where "archived_at" is null');
  expect(sql).not.toContain('unique ("name")');
  expect(sql).not.toContain('unique ("title")');
  expect(sql).toContain('primary key ("id")');
  const notes = renderCatalog(app.catalog, "public").find(
    (statement) => statement.includes("create table") && statement.includes('"notes"'),
  );
  expect(notes).toContain('"body" text');
  expect(notes).not.toContain("archived_at");

  const named = indexOf(app.catalog, "lists");
  expect(named.some((item) => item.definition.predicate === '"archived_at" is null')).toBe(true);
});

test("a tenant unique keeps the tenant key and the partial predicate", () => {
  const sql = renderCatalog(tenantApp.catalog, "public").join("\n");
  expect(sql).toContain('primary key ("id", "tenant_id")');
  expect(sql).toContain('"tenant_id", "name"');
  expect(sql).toContain('where "archived_at" is null');
  expect(sql).not.toContain('unique ("tenant_id", "name")');
  const nameIndex = tenantApp.catalog.objects.find(
    (object): object is IndexObject =>
      object.kind === "index" &&
      object.identity.parent.name === "orgs" &&
      object.definition.columns.includes("name"),
  );
  expect(nameIndex?.definition.columns).toEqual(["tenant_id", "name"]);
  expect(nameIndex?.definition.predicate).toBe('"archived_at" is null');
  expect(nameIndex?.definition.unique).toBe(true);
});

test("a hand-written unique index is left unchanged", () => {
  const kept = schema({
    casing: "snake",
    tables: [
      table(
        "items",
        { id: id({ default: "none" }), title: text() },
        {
          traits: [archivable()],
          indexes: (columns) => [index(columns.title).unique()],
        },
      ),
    ],
  });
  const indexes = kept.catalog.objects.filter(
    (object): object is IndexObject => object.kind === "index",
  );
  const plain = indexes.find((item) => item.definition.predicate === undefined);
  expect(plain?.definition.unique).toBe(true);
  expect(plain?.definition.columns).toEqual(["title"]);
});

test("cascade names are checked when the schema is built", () => {
  expect(capture(() => archivable({ strategy: "table" })).code).toBe("OKM1061");
  expect(capture(() => archivable({ extra: true } as never)).code).toBe("OKM1060");

  expect(
    capture(() =>
      schema({
        tables: [
          table(
            "items",
            { id: id({ default: "none" }), archivedAt: text() },
            { traits: [archivable()] },
          ),
        ],
      }),
    ).code,
  ).toBe("OKM1012");

  expect(badCascade(["missing"]).code).toBe("OKM1020");
  expect(badCascade(["lists"]).code).toBe("OKM1020");
  expect(badCascade(["tasks", "tasks"]).code).toBe("OKM1020");
  expect(badCascade(["notes"]).message).toContain("not archivable");

  const ambiguous = capture(() =>
    schema({
      casing: "snake",
      tables: [
        table(
          "lists",
          { id: id({ default: "none" }) },
          { traits: [archivable({ cascade: ["tasks"] })] },
        ),
        table(
          "tasks",
          {
            id: id({ default: "none" }),
            listId: uuid().references("lists"),
            otherId: uuid().references("lists"),
          },
          { traits: [archivable()] },
        ),
      ],
    }),
  );
  expect(ambiguous.code).toBe("OKM1021");

  const noKey = capture(() =>
    schema({
      casing: "snake",
      tables: [
        table("parents", { id: id({ default: "none" }) }, { traits: [archivable()] }),
        table("children", { parentId: uuid().references("parents") }, { traits: [archivable()] }),
      ],
    }),
  );
  expect(noKey.code).toBe("OKM1020");
  expect(noKey.message).toContain("primary key");
});

test("archive SQL targets the active set and shares one archive id", () => {
  const planned = explainArchive(
    app,
    "archive",
    "lists",
    { where: { id: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c11" } },
    {},
    {},
    undefined,
  );
  const text = planned.statements[0]?.text ?? "";
  expect(text).toContain('"archived_at" is null');
  expect(text).toContain("= now()");
  expect(text).toContain("$1::uuid");
  expect(text).toContain('"tasks"');
  expect(planned.statements[0]?.params).toHaveLength(2);

  const restored = explainArchive(
    app,
    "restore",
    "tasks",
    { archiveId: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c99" },
    {},
    {},
    undefined,
  );
  const restoreText = restored.statements[0]?.text ?? "";
  expect(restoreText).toContain('"archived_at" is not null');
  expect(restoreText).toContain("= null");
  expect(restoreText).not.toContain("= now()");
});

function badCascade(cascade: readonly string[]): OkmError {
  return capture(() =>
    schema({
      casing: "snake",
      tables: [
        table("lists", { id: id({ default: "none" }) }, { traits: [archivable({ cascade })] }),
        table(
          "tasks",
          { id: id({ default: "none" }), listId: uuid().references("lists") },
          { traits: [archivable()] },
        ),
        table("notes", { id: id({ default: "none" }), listId: uuid().references("lists") }),
      ],
    }),
  );
}

function capture(run: () => unknown): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

function columnOf(source: Catalog, field: string, tableName: string): ColumnObject | undefined {
  return source.objects.find((object): object is ColumnObject => {
    return (
      object.kind === "column" &&
      object.identity.name === field &&
      object.identity.parent.name === tableName
    );
  });
}

function indexOf(source: Catalog, tableName: string): readonly IndexObject[] {
  return source.objects.filter(
    (object): object is IndexObject =>
      object.kind === "index" && object.identity.parent.name === tableName,
  );
}
