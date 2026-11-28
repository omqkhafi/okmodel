/**
 * `watch` option checks and the notification-queue warning. No database.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { catalogHash } from "../src/contracts/catalog/document.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { emitPull } from "../src/tooling/migrate/pull-emit.js";
import { queueWarning } from "../src/runtime/watch.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";

test("watch accepts true and push false, and refuses feed", () => {
  const plain = table("jobs", { id: t.integer().primaryKey() }, { watch: true });
  const quiet = table("hot", { id: t.integer().primaryKey() }, { watch: { push: false } });
  expect(plain.options?.watch).toBe(true);
  expect(quiet.options?.watch).toEqual({ push: false });
  expect(() =>
    table("later", { id: t.integer().primaryKey() }, { watch: { feed: { keep: 1 } } } as never),
  ).toThrow(OkmError);
  try {
    table("later", { id: t.integer().primaryKey() }, { watch: { feed: { keep: 1 } } } as never);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1061");
  }
  expect(() =>
    table("bad", { id: t.integer().primaryKey() }, { watch: { push: true } } as never),
  ).toThrow(OkmError);
});

test("watch true emits four triggers and push false emits none", () => {
  const watched = schema({
    casing: "snake",
    tables: [table("orders", { id: t.integer().primaryKey() }, { watch: true })],
  });
  const quiet = schema({
    casing: "snake",
    tables: [table("orders", { id: t.integer().primaryKey() }, { watch: { push: false } })],
  });
  const plain = schema({
    casing: "snake",
    tables: [table("orders", { id: t.integer().primaryKey() })],
  });
  const names = watched.catalog.objects
    .filter((object) => object.kind === "trigger")
    .map((object) => object.identity.name)
    .sort();
  expect(names).toEqual([
    "okm_watch_delete",
    "okm_watch_insert",
    "okm_watch_truncate",
    "okm_watch_update",
  ]);
  expect(watched.catalog.objects.filter((object) => object.kind === "function")).toHaveLength(1);
  expect(quiet.catalog.objects.some((object) => object.kind === "trigger")).toBe(false);
  expect(catalogHash(plain.catalog)).toBe(
    catalogHash(
      schema({
        casing: "snake",
        tables: [table("orders", { id: t.integer().primaryKey() })],
      }).catalog,
    ),
  );
  expect(catalogHash(watched.catalog)).not.toBe(catalogHash(plain.catalog));
});

test("truncate trigger wakes without transition tables", () => {
  const tenant = schema({
    casing: "snake",
    tenancy: columnTenancy({ key: "tenantId", type: "text" }),
    tables: [table("orders", { id: t.integer().primaryKey() }, { watch: true })],
  });
  const truncate = tenant.catalog.objects.find(
    (object) => object.kind === "trigger" && object.identity.name === "okm_watch_truncate",
  );
  expect(truncate?.kind).toBe("trigger");
  if (truncate?.kind !== "trigger") return;
  expect(truncate.definition.events).toEqual(["truncate"]);
  expect(truncate.definition.timing).toBe("after");
  expect(truncate.definition.level).toBe("statement");
  expect(truncate.definition.referencing).toBeUndefined();
  const body = tenant.catalog.objects.find((object) => object.kind === "function");
  expect(body?.kind).toBe("function");
  if (body?.kind !== "function") return;
  expect(body.definition.body).toContain("tg_op = 'TRUNCATE'");
});

test("pull writes watch true and skips the generated function", () => {
  const app = schema({
    casing: "snake",
    tables: [table("orders", { id: t.integer().primaryKey(), status: t.text() }, { watch: true })],
  });
  const emission = emitPull(app.catalog, {
    schemaFile: "/tmp/schema.ts",
    tablesDir: "/tmp/tables",
  });
  const text = emission.files.map((file) => file.text).join("\n");
  expect(text).toContain("watch: true");
  expect(text).not.toContain("okm_watch");
  expect(emission.skipped.some((item) => item.label.includes("okm_watch"))).toBe(false);
});

test("queue warning starts at one half", () => {
  expect(queueWarning(undefined)).toBeUndefined();
  expect(queueWarning(0.49)).toBeUndefined();
  expect(queueWarning(0.5)).toContain("OKM2212");
  expect(queueWarning(1)).toContain("OKM2212");
});
