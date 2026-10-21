/**
 * A NOT NULL constraint that is not validated (PostgreSQL 18 `NOT VALID`).
 *
 * The catalog column records it, the planner validates it, and `okm pull`
 * declares the column nullable. A column without the mark stays as it was.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import {
  catalogHash,
  parseCatalog,
  renameColumn,
  renameTable,
  serializeCatalog,
} from "../src/contracts/catalog/document.js";
import { withUnvalidatedNotNull } from "../src/contracts/catalog/not-null.js";
import { column, constraint, table } from "../src/contracts/catalog/object.js";
import type { Catalog, CatalogObject, Namespace } from "../src/contracts/catalog/types.js";
import { unvalidatedNotNullSql } from "../src/dialects/pg/not-null.js";
import { NULLABILITY_SQL } from "../src/tooling/describe/nullability.js";
import { classOf } from "../src/dialects/step-class.js";
import { lintPlan } from "../src/tooling/migrate/lint.js";
import { emitPull, formatPullReport } from "../src/tooling/migrate/pull-emit.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const ns: Namespace = { form: "static", name: "public" };
const provenance = { origin: "file" as const, name: "test" };
const parent = { namespace: ns, name: "items" };

function items(options: { readonly nullable: boolean; readonly unvalidated?: string }): Catalog {
  const objects: CatalogObject[] = [
    table({ namespace: ns, name: "items", provenance }),
    column({ parent, name: "id", dataType: "integer", nullable: false, provenance }),
    options.unvalidated === undefined
      ? column({ parent, name: "a", dataType: "integer", nullable: options.nullable, provenance })
      : withUnvalidatedNotNull(
          column({
            parent,
            name: "a",
            dataType: "integer",
            nullable: options.nullable,
            provenance,
          }),
          options.unvalidated,
        ),
    constraint({
      parent,
      constraintKind: "primaryKey",
      columns: ["id"],
      nameKey: "pkey",
      provenance,
    }),
  ];
  return catalog(objects);
}

test("the column records the unvalidated constraint and a plain column does not", () => {
  const marked = items({ nullable: false, unvalidated: "items_a_nn" });
  const plain = items({ nullable: false });
  const read = (source: Catalog) =>
    source.objects.find((object) => object.kind === "column" && object.identity.name === "a");
  expect(read(marked)?.definition).toEqual({
    dataType: "integer",
    nullable: false,
    unvalidatedNotNull: "items_a_nn",
  });
  expect(read(plain)?.definition).toEqual({ dataType: "integer", nullable: false });
});

test("a nullable column or an empty name takes no mark", () => {
  const nullable = column({ parent, name: "a", dataType: "integer", nullable: true, provenance });
  expect(withUnvalidatedNotNull(nullable, "items_a_nn")).toBe(nullable);
  const required = column({ parent, name: "a", dataType: "integer", nullable: false, provenance });
  expect(withUnvalidatedNotNull(required, "")).toBe(required);
});

test("the mark round-trips through the document and moves the hash only when set", () => {
  const marked = items({ nullable: false, unvalidated: "items_a_nn" });
  const plain = items({ nullable: false });
  expect(serializeCatalog(plain)).not.toContain("unvalidatedNotNull");
  expect(serializeCatalog(marked)).toContain('"unvalidatedNotNull":"items_a_nn"');
  expect(serializeCatalog(parseCatalog(serializeCatalog(marked)))).toBe(serializeCatalog(marked));
  expect(catalogHash(marked)).not.toBe(catalogHash(plain));
  expect(catalogHash(parseCatalog(serializeCatalog(plain)))).toBe(catalogHash(plain));
});

test("a column or table rename keeps the mark", () => {
  const marked = items({ nullable: false, unvalidated: "items_a_nn" });
  const read = (source: Catalog, name: string) =>
    source.objects.find((object) => object.kind === "column" && object.identity.name === name)
      ?.definition;
  const column = renameColumn(marked, { parent, from: "a", to: "b" });
  expect(read(column, "b")).toMatchObject({ unvalidatedNotNull: "items_a_nn" });
  const moved = renameTable(marked, { namespace: ns, from: "items", to: "things" });
  expect(read(moved, "a")).toMatchObject({ unvalidatedNotNull: "items_a_nn" });
});

test("describe and introspection read the constraint through one expression", () => {
  expect(NULLABILITY_SQL).toContain(unvalidatedNotNullSql("a"));
  expect(unvalidatedNotNullSql("a")).toContain("k.contype = 'n'");
  expect(unvalidatedNotNullSql("a")).toContain("k.convalidated = false");
});

test("the schema says NOT NULL: the plan validates the constraint in its own step", () => {
  const plan = planMigration({
    before: items({ nullable: false, unvalidated: "items_a_nn" }),
    after: items({ nullable: false }),
    name: "check",
  });
  expect(plan.steps.map((step) => step.sql)).toEqual([
    'alter table "public"."items" validate constraint "items_a_nn"',
  ]);
  const step = plan.steps[0];
  expect(step?.kind).toBe("validate-constraint");
  expect(step?.lock).toBe("SHARE UPDATE EXCLUSIVE");
  expect(classOf("validate-constraint")).toBe("expand");
});

test("the validate step is OKM1531 with its own reason, because stored NULLs make it fail", () => {
  const before = items({ nullable: false, unvalidated: "items_a_nn" });
  const after = items({ nullable: false });
  const plan = planMigration({ before, after, name: "check" });
  expect(lintPlan(plan, before, after)).toEqual([
    expect.objectContaining({ code: "OKM1531", reason: "validates a NOT NULL constraint" }),
  ]);
});

test("the schema says nullable: the plan drops NOT NULL and names no validate step", () => {
  const plan = planMigration({
    before: items({ nullable: false, unvalidated: "items_a_nn" }),
    after: items({ nullable: true }),
    name: "check",
  });
  expect(plan.steps.map((step) => step.sql)).toEqual([
    'alter table "public"."items" alter column "a" drop not null',
  ]);
});

test("a validated NOT NULL column plans nothing, with or without a mark on both sides", () => {
  const plain = items({ nullable: false });
  expect(planMigration({ before: plain, after: plain, name: "check" }).steps).toEqual([]);
  const marked = items({ nullable: false, unvalidated: "items_a_nn" });
  expect(planMigration({ before: marked, after: marked, name: "check" }).steps).toEqual([]);
});

test("a plain NOT NULL on an existing column keeps the safe rewrite", () => {
  const plan = planMigration({
    before: items({ nullable: true }),
    after: items({ nullable: false }),
    name: "check",
  });
  expect(plan.steps.map((step) => step.kind)).toEqual([
    "add-constraint",
    "validate-constraint",
    "set-not-null",
    "drop-not-null-check",
  ]);
});

test("pull declares an unvalidated NOT NULL column nullable, with a comment and a report line", () => {
  const emitted = emitPull(items({ nullable: false, unvalidated: "items_a_nn" }), {
    schemaFile: "/tmp/okm-nn/schema.ts",
    tablesDir: "/tmp/okm-nn/tables",
  });
  const file = emitted.files.find((item) => item.path.endsWith("items.ts"));
  expect(file?.text).toContain("a: t.integer().nullable(),");
  expect(file?.text).toContain("NOT NULL NOT VALID (items_a_nn)");
  expect(file?.text).toContain("id: t.integer(),");
  expect(emitted.unvalidated).toEqual(["items.a (items_a_nn)"]);
  const report = formatPullReport(
    emitted.counts,
    emitted.skipped,
    emitted.verdicts,
    [],
    "pulled",
    emitted.unvalidated,
  );
  expect(report).toContain("not validated: 1");
  expect(report).toContain("    items.a (items_a_nn)");
});

test("pull of a plain NOT NULL column is unchanged", () => {
  const emitted = emitPull(items({ nullable: false }), {
    schemaFile: "/tmp/okm-nn/schema.ts",
    tablesDir: "/tmp/okm-nn/tables",
  });
  const file = emitted.files.find((item) => item.path.endsWith("items.ts"));
  expect(file?.text).toContain("a: t.integer(),");
  expect(file?.text).not.toContain("NOT VALID");
  expect(emitted.unvalidated).toEqual([]);
  const report = formatPullReport(emitted.counts, emitted.skipped, emitted.verdicts);
  expect(report).not.toContain("not validated");
});
