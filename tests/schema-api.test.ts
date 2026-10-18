/**
 * `describe` / `buildCatalog` round trip, without a database.
 */

import { expect, test } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import { citext } from "../src/dialects/pg/ext/citext.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { pgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import { external, schema, t, table } from "../src/dialects/pg/index.js";
import { stampOwnership } from "../src/dialects/pg/owner.js";
import { buildCatalog, describe } from "../src/tooling/migrate/index.js";
import { placeCatalog } from "../src/tooling/migrate/place.js";
import { app as archivable } from "../scripts/app-archivable.js";
import { app as startup } from "../scripts/app-startup.js";
import { app as validate } from "../scripts/app-validate.js";
import { loadSchemaApiExample } from "./schema-api-docs.js";

const apps = [
  ["startup", startup],
  ["archivable", archivable],
  ["validate", validate],
] as const;

for (const [name, app] of apps) {
  test(`${name} round-trips through JSON to the same catalog hash`, () => {
    const description = describe(app);
    expect(description.logical).toEqual({ format: 1, name: "public", namespace: "public" });
    expect(description.minPostgres).toBe(15);
    expect(description.extensions).toEqual([]);
    assertPlainJson(description);
    const catalog = buildCatalog(JSON.parse(JSON.stringify(description)));
    expect(catalogHash(catalog)).toBe(catalogHash(app.catalog));
  });
}

test("describe() reports minPostgres 18 for uuidv7()", () => {
  const app = schema({
    tables: [table("users", { id: t.id({ default: "uuidv7" }), name: t.text() })],
  });
  const description = describe(app);
  expect(description.minPostgres).toBe(18);
  expect(description.extensions).toEqual([]);
});

test("describe() reports a declared minPostgres floor", () => {
  const app = schema({
    minPostgres: 17,
    tables: [table("users", { id: t.id(), name: t.text() })],
  });
  expect(describe(app).minPostgres).toBe(17);
});

test("describe() lists pg_trgm from an index and the declaration", () => {
  const trgm = pgTrgm();
  const app = schema({
    tables: [
      table("docs", { id: t.id(), body: t.text() }, { indexes: (c) => [trgm.gin(c.body.name)] }),
    ],
    extensions: [trgm],
  });
  expect(describe(app).extensions).toEqual([
    {
      name: "pg_trgm",
      reason: "extension(pg_trgm); index docs.docs_body_idx uses pg_trgm",
    },
  ]);
});

test("describe() lists citext from a column and the declaration", () => {
  const app = schema({
    tables: [table("people", { email: t.citext() })],
    extensions: [citext()],
  });
  expect(describe(app).extensions).toEqual([
    { name: "citext", reason: "column people.email; extension(citext)" },
  ]);
});

test("describe() lists a bare extension() declaration such as vector", () => {
  const app = schema({
    tables: [table("users", { id: t.id() })],
    extensions: [extension("vector")],
  });
  expect(describe(app).minPostgres).toBe(15);
  expect(describe(app).extensions).toEqual([{ name: "vector", reason: "extension(vector)" }]);
});

test("placement changes the catalog hash and not the logical identity", () => {
  const users = external(
    table("users", {
      id: t.uuid().primaryKey(),
      email: t.text(),
    }),
  );
  const accounts = external(
    table("accounts", {
      id: t.uuid().primaryKey(),
      name: t.text(),
    }),
  );
  const invoices = table("invoices", {
    id: t.uuid().primaryKey(),
    userId: t.uuid().references("users"),
    accountId: t.uuid().references("accounts"),
  });
  const built = schema({ tables: [users, accounts, invoices] });
  const stamped = stampOwnership(
    built.catalog,
    new Map([
      ["users", "external"],
      ["accounts", "external"],
    ]),
  );
  const placed = placeCatalog(
    stamped,
    "billing",
    new Map([
      ["users", "identity"],
      ["accounts", "directory"],
    ]),
  );
  const source = describe(built);
  const physical = describe({ catalog: placed });
  expect(physical.logical).toEqual(source.logical);
  expect(catalogHash(placed)).not.toBe(catalogHash(built.catalog));
  const text = JSON.stringify(physical);
  expect(text).toContain("identity");
  expect(text).toContain("directory");
  expect(text).toContain("billing");
  const catalog = buildCatalog(JSON.parse(text));
  expect(catalogHash(catalog)).toBe(catalogHash(placed));
});

test("describe() refuses a value that has no catalog", () => {
  expect(() => describe({} as { catalog: never })).toThrow(/schema\(\)/);
});

test("the handbook example round-trips", async () => {
  const example = await loadSchemaApiExample();
  expect(example.description.logical).toEqual({ format: 1, name: "public", namespace: "public" });
  expect(catalogHash(example.catalog)).toBe(catalogHash(example.app.catalog));
});

/**
 * The description is JSON: no functions, and object keys are sorted.
 *
 * @param value - Value `describe` returned
 */
function assertPlainJson(value: unknown): void {
  const seen = new Set<object>();
  walk(value, seen);
}

/**
 * @param value - One JSON node
 * @param seen - Objects already visited
 */
function walk(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    expect(Number.isSafeInteger(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, seen);
    return;
  }
  if (typeof value === "object") {
    expect(seen.has(value)).toBe(false);
    seen.add(value);
    const keys = Object.keys(value);
    expect(keys).toEqual([...keys].sort());
    for (const key of keys) walk((value as Record<string, unknown>)[key], seen);
    return;
  }
  throw new Error(`description holds a ${typeof value}`);
}
