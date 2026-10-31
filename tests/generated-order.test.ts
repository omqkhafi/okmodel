/**
 * A generated column is ordered after the plain columns of its table.
 *
 * The edge exists only while ordering. The stored dependencies and the
 * catalog hash stay as they were.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import { catalogHash, creationOrder } from "../src/contracts/catalog/document.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { identity, schema, table, text, tsvector } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { testing } from "../src/tooling/testing/index.js";

/** Hash of this docs schema on main, before the ordering edge existed. */
const GOLDEN = "deb4849d38a380823d94dc9ee8b0a8a5123993911df4edc0f87784520615d611";

const searchFromTitle = table("docs", {
  id: identity(),
  title: text(),
  search: tsvector().generated("to_tsvector('english', title)"),
});

const searchFromBody = table("docs", {
  id: identity(),
  title: text(),
  body: text(),
  search: tsvector().generated("to_tsvector('english', body)"),
});

const zsearchFromTitle = table("docs", {
  id: identity(),
  title: text(),
  zsearch: tsvector().generated("to_tsvector('english', title)"),
});

const people = table("people", {
  id: identity(),
  first_name: text(),
  last_name: text(),
  full_name: text().generated("first_name || ' ' || last_name"),
});

function names(source: Catalog): readonly string[] {
  return creationOrder(source)
    .filter((object) => object.kind === "column")
    .map((object) => object.identity.name);
}

function createTable(source: Catalog): string {
  const sql = renderCatalog(source, "public").find((statement) =>
    statement.startsWith("create table"),
  );
  if (sql === undefined) throw new Error("missing create table");
  return sql;
}

test("a generated column follows every plain column of its table", () => {
  // `id` is an identity column, so it follows the sequence and the plain
  // columns that depend only on the table. The generated column follows both.
  expect(names(schema({ tables: [searchFromTitle] }).catalog)).toEqual(["title", "id", "search"]);
  expect(names(schema({ tables: [searchFromBody] }).catalog)).toEqual([
    "body",
    "title",
    "id",
    "search",
  ]);
  expect(names(schema({ tables: [zsearchFromTitle] }).catalog)).toEqual(["title", "id", "zsearch"]);
  expect(names(schema({ tables: [people] }).catalog)).toEqual([
    "first_name",
    "last_name",
    "id",
    "full_name",
  ]);
});

test("create table lists generated columns after the plain ones", () => {
  const sql = createTable(schema({ tables: [searchFromTitle] }).catalog);
  expect(sql.indexOf('"title"')).toBeLessThan(sql.indexOf('"search"'));
  const peopleSql = createTable(schema({ tables: [people] }).catalog);
  expect(peopleSql.indexOf('"first_name"')).toBeLessThan(peopleSql.indexOf('"full_name"'));
  expect(peopleSql.indexOf('"last_name"')).toBeLessThan(peopleSql.indexOf('"full_name"'));
});

test("adding both columns is source-first and dropping them is generated-first", () => {
  const before = schema({ tables: [table("docs", { id: identity() })] }).catalog;
  const after = schema({ tables: [searchFromTitle] }).catalog;
  const add = planMigration({ before, after, name: "add" })
    .steps.map((step) => step.sql)
    .join("\n");
  const drop = planMigration({ before: after, after: before, name: "drop" })
    .steps.map((step) => step.sql)
    .join("\n");
  expect(add.indexOf('add column "title"')).toBeLessThan(add.indexOf('add column "search"'));
  expect(drop.indexOf('drop column "search"')).toBeLessThan(drop.indexOf('drop column "title"'));
});

test("the ordering edge is not stored and the catalog hash stays", () => {
  const built = schema({ tables: [searchFromTitle] }).catalog;
  const search = built.objects.find(
    (object) => object.kind === "column" && object.identity.name === "search",
  );
  expect(search?.kind === "column" ? search.dependencies : []).toEqual([
    {
      target: {
        kind: "table",
        namespace: { form: "static", name: "public" },
        name: "docs",
      },
    },
  ]);
  expect(catalogHash(built)).toBe(GOLDEN);
});

test("testing() closes a generated search column", async () => {
  const harness = await testing(schema({ tables: [searchFromTitle] }), { driver: open() });
  await harness.close();
}, 30_000);
