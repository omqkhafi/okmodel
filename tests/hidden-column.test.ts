/**
 * `hidden({ filterable: true })` stays out of the catalog.
 *
 * The hashed catalog does not store `hidden`. Adding `filterable` must leave
 * `catalogHash` and the generated plan unchanged.
 */

import { expect, test } from "bun:test";

import { catalogHash, serializeCatalog } from "../src/contracts/catalog/document.js";
import { schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const plain = table("notes", {
  id: uuid().primaryKey(),
  title: text(),
  secret: text().hidden(),
});

const filterable = table("notes", {
  id: uuid().primaryKey(),
  title: text(),
  secret: text().hidden({ filterable: true }),
});

test("filterable does not change the catalog hash or the generated plan", () => {
  const before = schema({ tables: [plain] });
  const after = schema({ tables: [filterable] });
  expect(catalogHash(after.catalog)).toBe(catalogHash(before.catalog));
  expect(serializeCatalog(after.catalog)).toBe(serializeCatalog(before.catalog));
  const base = schema({ tables: [table("notes", { id: uuid().primaryKey(), title: text() })] });
  const left = planMigration({ before: base.catalog, after: before.catalog, name: "secret" });
  const right = planMigration({ before: base.catalog, after: after.catalog, name: "secret" });
  expect(right.steps.map((step) => step.sql)).toEqual(left.steps.map((step) => step.sql));
});
