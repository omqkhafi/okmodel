/**
 * Managed history tables stay out of the author diff.
 *
 * `okm_meta` and `okm_history` exist on a database after push and are absent
 * from the schema. Either direction of that pair used to plan a drop or a create.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { staticNamespace } from "../src/contracts/catalog/identity.js";
import { column, constraint, table } from "../src/contracts/catalog/object.js";
import type { Catalog, CatalogObject, Provenance } from "../src/contracts/catalog/types.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const provenance: Provenance = { origin: "file", name: "drift" };
const namespace = staticNamespace("public");

test("a text default matches the cast Postgres reprints and a different value still changes", () => {
  const author = titled("'x'");
  expect(sqlOf(titled("'x'::text"), author)).toEqual([]);
  expect(sqlOf(author, titled("'x'::text"))).toEqual([]);
  const changed = sqlOf(titled("'y'::text"), author);
  expect(changed.some((statement) => statement.includes("set default 'x'"))).toBe(true);
});

test("a plan keeps okm_meta and okm_history in both directions and still drops a user table", () => {
  const tasks = userTable("tasks");
  const author = catalog(tasks);
  const live = catalog([...tasks, ...historyTables()]);
  expect(sqlOf(live, author)).toEqual([]);
  expect(sqlOf(author, live)).toEqual([]);

  const dropped = sqlOf(live, catalog([]));
  expect(dropped.some((statement) => statement.includes("tasks"))).toBe(true);
  expect(dropped.some((statement) => statement.includes("okm_"))).toBe(false);
});

function sqlOf(before: Catalog, after: Catalog): readonly string[] {
  return planMigration({ before, after, name: "drift" }).steps.map((step) => step.sql);
}

function titled(expression: string): Catalog {
  const parent = { namespace, name: "notes" };
  return catalog([
    table({ namespace, name: "notes", provenance }),
    column({ parent, name: "id", dataType: "integer", nullable: false, provenance }),
    column({
      parent,
      name: "title",
      dataType: "text",
      nullable: false,
      defaultExpression: expression,
      provenance,
    }),
    constraint({ parent, constraintKind: "primaryKey", columns: ["id"], provenance }),
  ]);
}

function userTable(name: string): CatalogObject[] {
  const parent = { namespace, name };
  return [
    table({ namespace, name, provenance }),
    column({ parent, name: "id", dataType: "integer", nullable: false, provenance }),
    constraint({ parent, constraintKind: "primaryKey", columns: ["id"], provenance }),
  ];
}

function historyTables(): CatalogObject[] {
  return [
    ...history("okm_meta", [
      ["id", "text"],
      ["catalog_hash", "text"],
      ["migration_id", "text"],
    ]),
    ...history("okm_history", [
      ["migration_id", "text"],
      ["step_index", "integer"],
      ["class", "text"],
      ["catalog_hash", "text"],
    ]),
  ];
}

function history(name: string, columns: readonly (readonly [string, string])[]): CatalogObject[] {
  const parent = { namespace, name };
  const objects: CatalogObject[] = [table({ namespace, name, provenance })];
  for (const [columnName, dataType] of columns) {
    objects.push(column({ parent, name: columnName, dataType, nullable: false, provenance }));
  }
  const key = name === "okm_history" ? ["migration_id", "step_index"] : ["id"];
  objects.push(constraint({ parent, constraintKind: "primaryKey", columns: key, provenance }));
  return objects;
}
