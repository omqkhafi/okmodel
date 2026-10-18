/**
 * Catalog placement and the export snapshot, without a database.
 */

import { expect, test } from "bun:test";

import { parseCatalog, serializeCatalog } from "../src/contracts/catalog/document.js";
import { external, schema, t, table, type AnyTable } from "../src/dialects/pg/index.js";
import { fn, trigger } from "../src/dialects/pg/fn/index.js";
import { stampOwnership } from "../src/dialects/pg/owner.js";
import {
  assertSnapshots,
  serializeSnapshot,
  snapshotFromCatalog,
  type CatalogSnapshot,
} from "../src/tooling/migrate/export.js";
import { placeCatalog } from "../src/tooling/migrate/place.js";

const users = table("users", {
  id: t.uuid().primaryKey(),
  email: t.text(),
});

test("a public catalog with no external namespace is the same object", () => {
  const catalog = schema({ tables: [users] }).catalog;
  expect(placeCatalog(catalog, "public", new Map())).toBe(catalog);
});

test("placeCatalog moves a trigger calls namespace and survives serialize (B-47)", () => {
  const tasks = table("tasks", { id: t.integer().primaryKey(), title: t.text() });
  const touch = fn("touch", {
    returns: "trigger",
    language: "plpgsql",
    body: "begin return new; end",
    dependsOn: [tasks],
  });
  const fired = trigger("tasks_touch", {
    on: tasks,
    timing: "before",
    events: ["update"],
    level: "row",
    calls: touch,
    when: "old.title is distinct from new.title",
  });
  const placed = placeCatalog(
    schema({ tables: [tasks], functions: [touch], triggers: [fired] }).catalog,
    "app",
    new Map(),
  );
  const trig = placed.objects.find((object) => object.kind === "trigger");
  expect(trig?.kind).toBe("trigger");
  if (trig?.kind !== "trigger") throw new Error("expected trigger");
  expect(trig.definition.calls.namespace).toEqual({ form: "static", name: "app" });
  const round = parseCatalog(serializeCatalog(placed));
  expect(round.objects.some((object) => object.kind === "trigger")).toBe(true);
});

test("the same source serializes to the same bytes and the same hash", () => {
  const placed = placeCatalog(schema({ tables: [users] }).catalog, "identity", new Map());
  const first = snapshotFromCatalog(placed, "identity", "okm_one");
  const second = snapshotFromCatalog(placed, "identity", "okm_one");
  expect(serializeSnapshot(first)).toBe(serializeSnapshot(second));
  expect(first.catalogHash).toBe(second.catalogHash);
  expect(first.logical).toEqual({ namespace: "identity", name: "identity", format: 1 });
  expect(serializeSnapshot(first)).not.toContain("postgres://");
  expect(serializeSnapshot(first)).not.toContain("function");
});

test("an external mark with no snapshot list is not OKM1841", () => {
  const outside = external(table("outside", { id: t.uuid().primaryKey() }));
  const stamped = stampOwnership(
    schema({ tables: [outside] }).catalog,
    new Map([["outside", "external"]]),
  );
  expect(() => assertSnapshots("/tmp", { schema: "./schema.ts" }, stamped)).not.toThrow();
});

test("a column change moves the catalog hash and leaves the logical identity", () => {
  const before = snapshotOf(users);
  const after = snapshotOf(
    table("users", {
      id: t.uuid().primaryKey(),
      email: t.text(),
      name: t.text(),
    }),
  );
  expect(after.catalogHash).not.toBe(before.catalogHash);
  expect(after.logical).toEqual(before.logical);
});

function snapshotOf(item: AnyTable): CatalogSnapshot {
  const placed = placeCatalog(schema({ tables: [item] }).catalog, "identity", new Map());
  return snapshotFromCatalog(placed, "identity");
}
