/**
 * Row types of date and time columns per mode (D321).
 *
 * No mode follows `schema({ defaults: { time } })`. The default is `iso`, a
 * string. `{ mode }` on a column wins over the schema default.
 */

import { expectTypeOf } from "expect-type";

import type { Insert, Row } from "../src/contracts/rows.js";
import {
  bucket,
  date,
  eq,
  interval,
  schema,
  table,
  time,
  timestamp,
  timestamptz,
  timetz,
  uuid,
  type TimeText,
  type TimeWithOffset,
} from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";
import { timestamps } from "../src/runtime/traits/index.js";

const events = table(
  "events",
  {
    id: uuid().primaryKey(),
    at: timestamptz(),
    at3: timestamptz(3).nullable(),
    local: timestamp({ precision: 6 }),
    day: date(),
    clock: time(),
    clockTz: timetz(),
    span: interval("day to second"),
    pinned: timestamptz({ mode: "temporal" }),
    text: timestamptz({ mode: "iso" }),
    many: date().array(),
  },
  { traits: [timestamps()] },
);

const iso = schema({ tables: [events] });
const explicit = schema({ tables: [events], defaults: { time: "iso" } });
const dated = schema({ tables: [events], defaults: { time: "date" } });
const temporal = schema({ tables: [events], defaults: { time: "temporal" } });

type IsoRow = Row<"events", typeof iso>;
expectTypeOf<IsoRow["at"]>().toEqualTypeOf<TimeText<"timestamptz">>();
expectTypeOf<IsoRow["at"]>().toExtend<string>();
expectTypeOf<IsoRow["at3"]>().toEqualTypeOf<TimeText<"timestamptz"> | null>();
expectTypeOf<IsoRow["createdAt"]>().toExtend<string>();
expectTypeOf<IsoRow["pinned"]>().toEqualTypeOf<Temporal.Instant>();
expectTypeOf<IsoRow["text"]>().toEqualTypeOf<string>();
expectTypeOf<Row<"events", typeof explicit>>().toEqualTypeOf<IsoRow>();

type DateRow = Row<"events", typeof dated>;
expectTypeOf<DateRow["at"]>().toEqualTypeOf<Date>();
expectTypeOf<DateRow["at3"]>().toEqualTypeOf<Date | null>();
expectTypeOf<DateRow["local"]>().toEqualTypeOf<Date>();
expectTypeOf<DateRow["day"]>().toEqualTypeOf<Date>();
expectTypeOf<DateRow["clock"]>().toEqualTypeOf<string>();
expectTypeOf<DateRow["clockTz"]>().toEqualTypeOf<string>();
expectTypeOf<DateRow["span"]>().toEqualTypeOf<string>();
expectTypeOf<DateRow["createdAt"]>().toEqualTypeOf<Date>();
expectTypeOf<DateRow["pinned"]>().toEqualTypeOf<Temporal.Instant>();
expectTypeOf<DateRow["text"]>().toEqualTypeOf<string>();
expectTypeOf<DateRow["many"]>().toEqualTypeOf<readonly Date[]>();

type TemporalRow = Row<"events", typeof temporal>;
expectTypeOf<TemporalRow["at"]>().toEqualTypeOf<Temporal.Instant>();
expectTypeOf<TemporalRow["local"]>().toEqualTypeOf<Temporal.PlainDateTime>();
expectTypeOf<TemporalRow["day"]>().toEqualTypeOf<Temporal.PlainDate>();
expectTypeOf<TemporalRow["clock"]>().toEqualTypeOf<Temporal.PlainTime>();
expectTypeOf<TemporalRow["clockTz"]>().toEqualTypeOf<TimeWithOffset>();
expectTypeOf<TemporalRow["span"]>().toEqualTypeOf<Temporal.Duration>();
expectTypeOf<TemporalRow["text"]>().toEqualTypeOf<string>();

// Insert follows the mode too.
expectTypeOf<Insert<"events", typeof dated>["at"]>().toEqualTypeOf<Date>();
expectTypeOf<Insert<"events", typeof iso>["at"]>().toExtend<string>();

declare const isoDb: Connected<typeof iso>;
declare const dateDb: Connected<typeof dated>;
declare const temporalDb: Connected<typeof temporal>;

void isoDb.events.find({ where: { at: eq("2026-11-03T09:00:00Z") }, limit: 1 });
void dateDb.events.find({ where: { at: eq(new Date()) }, limit: 1 });
// @ts-expect-error a Date is not an iso operand
void isoDb.events.find({ where: { at: eq(new Date()) }, limit: 1 });
// @ts-expect-error a string is not a date-mode operand
void dateDb.events.find({ where: { at: eq("2026-11-03T09:00:00Z") }, limit: 1 });
// @ts-expect-error a string is not a temporal operand
void temporalDb.events.find({ where: { day: eq("2026-11-03") }, limit: 1 });

// @ts-expect-error mode must be iso, date, or temporal
timestamptz({ mode: "luxon" });
// @ts-expect-error date takes no precision
date({ precision: 3 });

// Bucket keys follow the column's mode.
const isoGroups = isoDb.events.aggregate({
  groupBy: [bucket("at", "day", { tz: "UTC", as: "day" })],
  count: true,
  limit: 10,
});
expectTypeOf<Awaited<typeof isoGroups>[number]["day"]>().toEqualTypeOf<string>();
const dateGroups = dateDb.events.aggregate({
  groupBy: [bucket("at", "hour", { tz: "UTC", as: "hour" })],
  count: true,
  limit: 10,
});
expectTypeOf<Awaited<typeof dateGroups>[number]["hour"]>().toEqualTypeOf<Date>();

// sum and avg leave out iso time text.
// @ts-expect-error a timestamp is not summed
void isoDb.events.aggregate({ sum: ["at"] });
