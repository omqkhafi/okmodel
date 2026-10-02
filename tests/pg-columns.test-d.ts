/**
 * Row, insert, and update types for column builders and modifiers.
 */

import { expectTypeOf } from "expect-type";

import {
  t,
  type ColumnInsertOf,
  type ColumnRowOf,
  type ColumnUpdateOf,
  type Line,
  type Point,
  type Range,
  type TimeWithOffset,
} from "../src/dialects/pg/index.js";

const key = t.id();
expectTypeOf<ColumnRowOf<typeof key>>().toEqualTypeOf<string>();
expectTypeOf<ColumnInsertOf<typeof key>>().toEqualTypeOf<never>();
expectTypeOf<ColumnUpdateOf<typeof key>>().toEqualTypeOf<never>();

const serial = t.identity();
expectTypeOf<ColumnRowOf<typeof serial>>().toEqualTypeOf<string>();
expectTypeOf<ColumnInsertOf<typeof serial>>().toEqualTypeOf<never>();
const serialNumber = t.identity({ as: "number" });
expectTypeOf<ColumnRowOf<typeof serialNumber>>().toEqualTypeOf<number>();

expectTypeOf<ColumnRowOf<ReturnType<typeof t.uuid>>>().toEqualTypeOf<string>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.smallint>>>().toEqualTypeOf<number>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.integer>>>().toEqualTypeOf<number>();

const big = t.bigint();
expectTypeOf<ColumnRowOf<typeof big>>().toEqualTypeOf<string>();
const bigNumber = t.bigint({ as: "number" });
expectTypeOf<ColumnRowOf<typeof bigNumber>>().toEqualTypeOf<number>();
const bigNative = t.bigint({ as: "bigint" });
expectTypeOf<ColumnRowOf<typeof bigNative>>().toEqualTypeOf<bigint>();

const numeric = t.numeric();
expectTypeOf<ColumnRowOf<typeof numeric>>().toEqualTypeOf<string>();
const exact = t.numeric(10, 2, { as: "number" });
expectTypeOf<ColumnRowOf<typeof exact>>().toEqualTypeOf<number>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.real>>>().toEqualTypeOf<number>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.double>>>().toEqualTypeOf<number>();

const title = t.text();
expectTypeOf<ColumnRowOf<typeof title>>().toEqualTypeOf<string>();
expectTypeOf<ColumnInsertOf<typeof title>>().toEqualTypeOf<string>();
expectTypeOf<ColumnUpdateOf<typeof title>>().toEqualTypeOf<string | undefined>();

const notes = t.text().nullable();
expectTypeOf<ColumnRowOf<typeof notes>>().toEqualTypeOf<string | null>();
expectTypeOf<ColumnInsertOf<typeof notes>>().toEqualTypeOf<string | null | undefined>();
expectTypeOf<ColumnUpdateOf<typeof notes>>().toEqualTypeOf<string | null | undefined>();

const position = t.integer().default(0);
expectTypeOf<ColumnInsertOf<typeof position>>().toEqualTypeOf<number | undefined>();
expectTypeOf<ColumnRowOf<typeof position>>().toEqualTypeOf<number>();

const sqlDefault = t.text().defaultSql("now()");
expectTypeOf<ColumnInsertOf<typeof sqlDefault>>().toEqualTypeOf<string | undefined>();

const status = t.varchar(20).picklist(["draft", "active"]);
expectTypeOf<ColumnRowOf<typeof status>>().toEqualTypeOf<"draft" | "active">();

const unchecked = t.char(1).picklist(["a", "b"], { check: false });
expectTypeOf<ColumnRowOf<typeof unchecked>>().toEqualTypeOf<"a" | "b">();

expectTypeOf<ColumnRowOf<ReturnType<typeof t.citext>>>().toEqualTypeOf<string>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.boolean>>>().toEqualTypeOf<boolean>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.bytea>>>().toEqualTypeOf<Uint8Array>();

const payload = t.json<{ readonly id: number }>();
expectTypeOf<ColumnRowOf<typeof payload>>().toEqualTypeOf<{ readonly id: number }>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.jsonb>>>().toEqualTypeOf<unknown>();

expectTypeOf<ColumnRowOf<ReturnType<typeof t.timestamptz>>>().toEqualTypeOf<Temporal.Instant>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.timestamp>>>().toEqualTypeOf<Temporal.PlainDateTime>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.date>>>().toEqualTypeOf<Temporal.PlainDate>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.time>>>().toEqualTypeOf<Temporal.PlainTime>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.timetz>>>().toEqualTypeOf<TimeWithOffset>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.interval>>>().toEqualTypeOf<Temporal.Duration>();

expectTypeOf<ColumnRowOf<ReturnType<typeof t.tstzrange>>>().toEqualTypeOf<
  Range<Temporal.Instant>
>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.daterange>>>().toEqualTypeOf<
  Range<Temporal.PlainDate>
>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.int4range>>>().toEqualTypeOf<Range<number>>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.int8range>>>().toEqualTypeOf<Range<string>>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.numrange>>>().toEqualTypeOf<Range<string>>();

expectTypeOf<ColumnRowOf<ReturnType<typeof t.inet>>>().toEqualTypeOf<string>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.cidr>>>().toEqualTypeOf<string>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.macaddr>>>().toEqualTypeOf<string>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.macaddr8>>>().toEqualTypeOf<string>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.point>>>().toEqualTypeOf<Point>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.line>>>().toEqualTypeOf<Line>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.tsvector>>>().toEqualTypeOf<string>();
expectTypeOf<ColumnRowOf<ReturnType<typeof t.ltree>>>().toEqualTypeOf<string>();

const color = t.enum("color", ["red", "blue"]);
expectTypeOf<ColumnRowOf<typeof color>>().toEqualTypeOf<"red" | "blue">();
const email = t.domain("email", t.text(), "VALUE LIKE '%@%'");
expectTypeOf<ColumnRowOf<typeof email>>().toEqualTypeOf<string>();

const tags = t.text().array();
expectTypeOf<ColumnRowOf<typeof tags>>().toEqualTypeOf<readonly string[]>();
const grid = t.integer().array({ dims: 2 });
expectTypeOf<ColumnRowOf<typeof grid>>().toEqualTypeOf<readonly (readonly number[])[]>();

const generated = t.integer().generated("1");
expectTypeOf<ColumnInsertOf<typeof generated>>().toEqualTypeOf<never>();
expectTypeOf<ColumnRowOf<typeof generated>>().toEqualTypeOf<number>();

const guarded = t.text().guarded();
expectTypeOf<ColumnInsertOf<typeof guarded>>().toEqualTypeOf<never>();
expectTypeOf<ColumnUpdateOf<typeof guarded>>().toEqualTypeOf<never>();
expectTypeOf<ColumnRowOf<typeof guarded>>().toEqualTypeOf<string>();

const hidden = t.text().hidden();
expectTypeOf<ColumnRowOf<typeof hidden>>().toEqualTypeOf<never>();
expectTypeOf<ColumnInsertOf<typeof hidden>>().toEqualTypeOf<string>();

const renamed = t.text().renamedFrom("old").sqlName("new_name").comment("note").unique();
expectTypeOf<ColumnRowOf<typeof renamed>>().toEqualTypeOf<string>();

const widget = t.custom<boolean>({
  sqlType: "bit",
  encode: (value) => (value ? "1" : "0"),
  decode: (wire) => wire === "1",
});
expectTypeOf<ColumnRowOf<typeof widget>>().toEqualTypeOf<boolean>();
