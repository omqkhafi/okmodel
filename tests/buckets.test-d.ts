/**
 * `bucket()` result keys, and a plain `groupBy` array that stays a field pick.
 */

import { expectTypeOf } from "expect-type";

import {
  bucket,
  date,
  integer,
  schema,
  table,
  text,
  timestamptz,
  uuid,
} from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";

const orders = table("orders", {
  id: uuid().primaryKey(),
  status: text(),
  total: integer(),
  createdAt: timestamptz(),
  at: timestamptz().nullable(),
  openedOn: date(),
});

const app = schema({ tables: [orders] });
declare const db: Connected<typeof app>;

const plain = db.orders.aggregate({ groupBy: ["status"], count: true, limit: 1 });
type Plain = Awaited<typeof plain>[number];
expectTypeOf<keyof Plain>().toEqualTypeOf<"status" | "count">();
expectTypeOf<Plain["status"]>().toEqualTypeOf<string>();
expectTypeOf<Plain["count"]>().toEqualTypeOf<number>();

const day = db.orders.aggregate({
  groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
  sum: ["total"],
  orderBy: { day: "desc" },
  limit: 30,
});
expectTypeOf<Awaited<typeof day>[number]["day"]>().toEqualTypeOf<Temporal.PlainDate>();
expectTypeOf<Awaited<typeof day>[number]["sum"]["total"]>().toEqualTypeOf<number | null>();

const clock = db.orders.aggregate({
  groupBy: [
    bucket("createdAt", "second", { tz: "UTC", as: "second" }),
    bucket("createdAt", "minute", { tz: "UTC", as: "minute" }),
    bucket("createdAt", "hour", { tz: "UTC", as: "hour" }),
  ],
  limit: 1,
});
type Clock = Awaited<typeof clock>[number];
expectTypeOf<Clock["second"]>().toEqualTypeOf<Temporal.Instant>();
expectTypeOf<Clock["minute"]>().toEqualTypeOf<Temporal.Instant>();
expectTypeOf<Clock["hour"]>().toEqualTypeOf<Temporal.Instant>();

const calendar = db.orders.aggregate({
  groupBy: [
    bucket("createdAt", "week", { tz: "UTC", as: "week", weekStart: "sunday" }),
    bucket("createdAt", "month", { tz: "UTC", as: "month" }),
    bucket("createdAt", "quarter", { tz: "UTC", as: "quarter" }),
    bucket("createdAt", "year", { tz: "UTC", as: "year" }),
  ],
  limit: 1,
});
type Calendar = Awaited<typeof calendar>[number];
expectTypeOf<Calendar["week"]>().toEqualTypeOf<Temporal.PlainDate>();
expectTypeOf<Calendar["month"]>().toEqualTypeOf<Temporal.PlainDate>();
expectTypeOf<Calendar["quarter"]>().toEqualTypeOf<Temporal.PlainDate>();
expectTypeOf<Calendar["year"]>().toEqualTypeOf<Temporal.PlainDate>();

const nullable = db.orders.aggregate({
  groupBy: [bucket("at", "hour", { tz: "UTC", as: "hour" })],
  limit: 1,
});
expectTypeOf<Awaited<typeof nullable>[number]["hour"]>().toEqualTypeOf<Temporal.Instant | null>();

const dated = db.orders.aggregate({
  groupBy: [bucket("openedOn", "month", { as: "month" }), "status"],
  count: true,
  limit: 1,
});
type Dated = Awaited<typeof dated>[number];
expectTypeOf<Dated["month"]>().toEqualTypeOf<Temporal.PlainDate>();
expectTypeOf<Dated["status"]>().toEqualTypeOf<string>();
expectTypeOf<keyof Dated>().toEqualTypeOf<"month" | "status" | "count">();

// @ts-expect-error a plain object is not a bucket
void db.orders.aggregate({ groupBy: [{ as: "day" }], limit: 1 });
// @ts-expect-error an unknown field
void db.orders.aggregate({ groupBy: ["nope"], limit: 1 });
// @ts-expect-error fortnight is not a unit
bucket("createdAt", "fortnight", { tz: "UTC", as: "day" });
