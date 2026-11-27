/**
 * Composite type planning: create order, field order, and the generated check.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { col, field } from "../src/dialects/pg/expr/index.js";
import { printIndexText } from "../src/dialects/pg/index-print.js";
import { schemaDeclarations } from "../src/dialects/pg/declarations.js";
import { emitPull } from "../src/tooling/migrate/pull-emit.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const address = t.composite("address", {
  street: t.text(),
  city: t.text(),
  zip: t.text().nullable(),
});

function people() {
  return schema({
    tables: [
      table("people", {
        id: t.identity(),
        home: address,
        work: address.nullable(),
      }),
    ],
  });
}

test("a composite is created before the table and the plan round-trips to itself", () => {
  const app = people();
  const plan = planMigration({
    before: schema({ tables: [] }).catalog,
    after: app.catalog,
    name: "create",
  });
  const sql = plan.steps.map((step) => step.sql);
  const createType = sql.findIndex((statement) => statement.startsWith("create type"));
  const createTable = sql.findIndex((statement) => statement.startsWith("create table"));
  expect(createType).toBeGreaterThanOrEqual(0);
  expect(createTable).toBeGreaterThan(createType);
  expect(sql[createType]).toContain("street");
  expect(sql.some((statement) => statement.toLowerCase().includes("is not null"))).toBe(true);
  const again = planMigration({ before: app.catalog, after: app.catalog, name: "same" });
  expect(again.steps).toEqual([]);
});

test("field order alone is not a migration", () => {
  const flipped = schema({
    tables: [
      table("people", {
        id: t.identity(),
        home: t.composite("address", {
          zip: t.text().nullable(),
          city: t.text(),
          street: t.text(),
        }),
        work: t
          .composite("address", {
            zip: t.text().nullable(),
            city: t.text(),
            street: t.text(),
          })
          .nullable(),
      }),
    ],
  });
  const plan = planMigration({
    before: people().catalog,
    after: flipped.catalog,
    name: "order",
  });
  expect(plan.steps.map((step) => step.sql)).toEqual([]);
});

test("adding a nullable field is alter type add attribute", () => {
  const next = schema({
    tables: [
      table("people", {
        id: t.identity(),
        home: t.composite("address", {
          street: t.text(),
          city: t.text(),
          zip: t.text().nullable(),
          note: t.text().nullable(),
        }),
        work: address.nullable(),
      }),
    ],
  });
  const plan = planMigration({ before: people().catalog, after: next.catalog, name: "add" });
  const sql = plan.steps.map((step) => step.sql.toLowerCase());
  expect(sql.some((statement) => statement.includes("add attribute"))).toBe(true);
  expect(sql.some((statement) => statement.startsWith("update"))).toBe(false);
});

test("a new non-null field without a fill is OKM1915", () => {
  const next = schema({
    tables: [
      table("people", {
        id: t.identity(),
        home: t.composite("address", {
          street: t.text(),
          city: t.text(),
          zip: t.text().nullable(),
          note: t.text(),
        }),
      }),
    ],
  });
  expect(() =>
    planMigration({ before: people().catalog, after: next.catalog, name: "fill" }),
  ).toThrow(OkmError);
});

test("renamedFrom on a field is rename attribute", () => {
  const next = schema({
    tables: [
      table("people", {
        id: t.identity(),
        home: t.composite("address", {
          street: t.text(),
          town: t.text().renamedFrom("city"),
          zip: t.text().nullable(),
        }),
        work: t
          .composite("address", {
            street: t.text(),
            town: t.text().renamedFrom("city"),
            zip: t.text().nullable(),
          })
          .nullable(),
      }),
    ],
  });
  const plan = planMigration({
    before: people().catalog,
    after: next.catalog,
    renames: schemaDeclarations(next).renames,
    name: "rename",
  });
  const sql = plan.steps.map((step) => step.sql.toLowerCase());
  expect(sql[0]).toBe('alter type "public"."address" rename attribute "city" to "town"');
  expect(sql.some((statement) => statement.includes("drop constraint"))).toBe(true);
});

test("field() prints a composite field", () => {
  expect(printIndexText(field(col("home"), "city"), (name) => name)).toBe('("home")."city"');
});

test("composite grants plan usage on the type", () => {
  const app = schema({
    tables: [
      table("people", {
        id: t.identity(),
        home: t.composite(
          "address",
          { street: t.text(), city: t.text() },
          { grants: { app: "read" } },
        ),
      }),
    ],
  });
  const after = attachRoles(app.catalog, {
    migration: { name: "okm_migrate" },
    app: { name: "okm_app" },
  });
  const sql = planMigration({ before: catalog([]), after, name: "grants" }).steps.map(
    (step) => step.sql,
  );
  expect(sql.some((statement) => statement.toLowerCase().includes("grant usage on type"))).toBe(
    true,
  );
});

test("pull writes t.composite and omits the generated check", () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-composite-"));
  const emitted = emitPull(people().catalog, {
    schemaFile: join(dir, "schema.ts"),
    tablesDir: join(dir, "tables"),
  });
  const text = emitted.files.map((file) => file.text).join("\n");
  expect(text).toContain('t.composite("address"');
  expect(text).not.toContain("cf_home");
});

test("a composite cannot contain itself", () => {
  expect(() =>
    t.composite("node", {
      name: t.text(),
      next: t.composite("node", { name: t.text() }),
    }),
  ).toThrow("42P16");
});
