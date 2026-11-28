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

test("watch accepts true, push false, and a feed duration", () => {
  const plain = table("jobs", { id: t.integer().primaryKey() }, { watch: true });
  const quiet = table("hot", { id: t.integer().primaryKey() }, { watch: { push: false } });
  const fed = table(
    "products",
    { id: t.integer().primaryKey() },
    { watch: { feed: { keep: "7d" } } },
  );
  expect(plain.options?.watch).toBe(true);
  expect(quiet.options?.watch).toEqual({ push: false });
  expect(fed.options?.watch).toEqual({ feed: { keep: "7d" } });
  expect(() =>
    table("bad", { id: t.integer().primaryKey() }, { watch: { push: true } } as never),
  ).toThrow(OkmError);
  expect(() =>
    table("bad", { id: t.integer().primaryKey() }, { watch: { feed: { keep: "soon" } } }),
  ).toThrow(OkmError);
  expect(() =>
    table("bad", { id: t.integer().primaryKey() }, { watch: { feed: { retain: "7d" } } } as never),
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
  const wake = watched.catalog.objects.find((object) => object.kind === "function");
  expect(wake?.kind).toBe("function");
  if (wake?.kind === "function") expect(wake.definition.body).not.toContain("okm_changes");
});

test("feed installs okm_changes and one insert per event", () => {
  const fed = schema({
    casing: "snake",
    tables: [
      table("products", { id: t.integer().primaryKey() }, { watch: { feed: { keep: "7d" } } }),
    ],
  });
  const names = fed.catalog.objects
    .filter((object) => object.kind === "table")
    .map((object) => object.identity.name)
    .sort();
  expect(names).toEqual(["okm_changes", "okm_cursors", "okm_feed_floor", "products"]);
  const body = fed.catalog.objects.find((object) => object.kind === "function");
  expect(body?.kind).toBe("function");
  if (body?.kind !== "function") return;
  expect(body.definition.body.match(/insert into okm_changes/g)).toHaveLength(4);
  expect(body.comment).toBe("okm-feed 7d");
  expect(body.definition.body).toContain("pg_notify");
  const quiet = schema({
    casing: "snake",
    tables: [
      table(
        "products",
        { id: t.integer().primaryKey() },
        { watch: { push: false, feed: { keep: "7d" } } },
      ),
    ],
  });
  const quietBody = quiet.catalog.objects.find((object) => object.kind === "function");
  expect(quietBody?.kind).toBe("function");
  if (quietBody?.kind === "function") expect(quietBody.definition.body).not.toContain("pg_notify");
  expect(
    () =>
      schema({
        tables: [table("open", { id: t.integer() }, { watch: { feed: { keep: "1d" } } })],
      }).catalog,
  ).toThrow(OkmError);
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

test("pull writes the feed option and skips the managed tables", () => {
  const app = schema({
    casing: "snake",
    tables: [
      table(
        "products",
        { id: t.integer().primaryKey() },
        { watch: { push: false, feed: { keep: "7d" } } },
      ),
    ],
  });
  const emission = emitPull(app.catalog, {
    schemaFile: "/tmp/schema.ts",
    tablesDir: "/tmp/tables",
  });
  const text = emission.files.map((file) => file.text).join("\n");
  expect(text).toContain('watch: { push: false, feed: { keep: "7d" } }');
  expect(text).not.toContain("okm_changes");
  expect(text).not.toContain("okm_watch");
});

test("queue warning starts at one half", () => {
  expect(queueWarning(undefined)).toBeUndefined();
  expect(queueWarning(0.49)).toBeUndefined();
  expect(queueWarning(0.5)).toContain("OKM2212");
  expect(queueWarning(1)).toContain("OKM2212");
});
