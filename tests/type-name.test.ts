/**
 * Column type spellings in the plan.
 *
 * The schema stores `timestamptz` and `varchar(20)`. Postgres `format_type`
 * stores `timestamp with time zone` and `character varying(20)`. Those are
 * the same type. A longer varchar, or timestamp against timestamptz, is not.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import type { CatalogObject } from "../src/contracts/catalog/types.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const ALIASES: readonly (readonly [string, string])[] = [
  ["timestamptz", "timestamp with time zone"],
  ["timestamptz(3)", "timestamp(3) with time zone"],
  ["timestamp", "timestamp without time zone"],
  ["time", "time without time zone"],
  ["timetz", "time with time zone"],
  ["varchar(20)", "character varying(20)"],
  ["char(4)", "character(4)"],
  ["int", "integer"],
  ["int4", "integer"],
  ["int8", "bigint"],
  ["int2", "smallint"],
  ["bool", "boolean"],
  ["float8", "double precision"],
  ["float4", "real"],
  ["decimal", "numeric"],
  ["decimal(8,2)", "numeric(8,2)"],
  ["timestamptz[]", "timestamp with time zone[]"],
];

test("alias spellings of one type plan to no steps, in both directions", () => {
  for (const [left, right] of ALIASES) {
    expect(statements(left, right), `${left} -> ${right}`).toEqual([]);
    expect(statements(right, left), `${right} -> ${left}`).toEqual([]);
  }
});

test("an unknown type is compared as written", () => {
  expect(statements("widget", "widget")).toEqual([]);
  expect(statements("citext", "text").join("\n")).toContain("text");
});

test("a nullability change does not also rewrite an alias spelling", () => {
  const before = clock(t.timestamptz());
  const after = schema({
    tables: [table("notes", { id: t.integer().primaryKey(), at: t.timestamptz().nullable() })],
  });
  const sql = planMigration({
    before: renameType(before.catalog.objects, "timestamp with time zone", false),
    after: after.catalog,
    name: "null",
  }).steps.map((step) => step.sql);
  expect(sql.join("\n")).toContain("drop not null");
  expect(sql.join("\n")).not.toContain("set data type");
});

test("a real type change still alters, in both directions", () => {
  const wider = statements("varchar(20)", "varchar(30)");
  expect(wider.join("\n")).toContain("set data type varchar(30)");
  const narrower = statements("varchar(30)", "varchar(20)");
  expect(narrower.join("\n")).toContain("set data type varchar(20)");

  const zoned = planMigration({
    before: clock(t.timestamp()).catalog,
    after: clock(t.timestamptz()).catalog,
    name: "zone",
  }).steps.map((step) => step.sql);
  expect(zoned.join("\n")).toContain("set data type timestamptz");
  const plain = planMigration({
    before: clock(t.timestamptz()).catalog,
    after: clock(t.timestamp()).catalog,
    name: "plain",
  }).steps.map((step) => step.sql);
  expect(plain.join("\n")).toContain("set data type timestamp");
});

function statements(before: string, after: string): string[] {
  return planMigration({
    before: typed(before).catalog,
    after: typed(after).catalog,
    name: "spell",
  }).steps.map((step) => step.sql);
}

function typed(sqlType: string) {
  return schema({
    tables: [
      table("notes", {
        id: t.integer().primaryKey(),
        value: t.custom({
          sqlType,
          encode: (value: string) => value,
          decode: (wire: string) => wire,
        }),
      }),
    ],
  });
}

function clock(column: ReturnType<typeof t.timestamp> | ReturnType<typeof t.timestamptz>) {
  return schema({
    tables: [table("notes", { id: t.integer().primaryKey(), at: column })],
  });
}

function renameType(objects: readonly CatalogObject[], dataType: string, nullable: boolean) {
  return catalog(
    objects.map((object) => {
      if (object.kind !== "column" || object.identity.name !== "at") return object;
      return { ...object, definition: { ...object.definition, dataType, nullable } };
    }),
  );
}
