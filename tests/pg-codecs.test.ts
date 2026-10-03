/**
 * Codec round trips.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { json } from "../src/dialects/pg/json.js";

import {
  bigint,
  boolean,
  bytea,
  char,
  cidr,
  citext,
  date,
  daterange,
  double,
  enum as enumColumn,
  inet,
  int4range,
  int8range,
  integer,
  interval,
  jsonb,
  jsonReplacer,
  line,
  ltree,
  macaddr,
  macaddr8,
  numeric,
  numrange,
  point,
  real,
  smallint,
  text,
  time,
  timestamp,
  timestamptz,
  timetz,
  tsvector,
  tstzrange,
  uuid,
  varchar,
  type ColumnBuilder,
  type ColumnFlags,
  type Range,
} from "../src/dialects/pg/index.js";

test("scalar codecs round-trip", () => {
  round(smallint(), 12);
  round(smallint(), -32_768);
  round(integer(), 2_147_483_647);
  round(bigint(), "-9007199254740993");
  round(bigint({ as: "number" }), 42);
  round(bigint({ as: "bigint" }), 42n);
  round(numeric(), "10.50");
  round(numeric(10, 2), "3.14");
  round(numeric(8, 0, { as: "number" }), 8);
  round(real(), 1.5);
  expect(double().encode(-0)).toBe("0");
  expect(double().decode("-0")).toBe(0);
  round(text(), "hello");
  round(varchar(4), "ab");
  round(char(2), "xy");
  round(citext(), "AbC");
  round(boolean(), true);
  round(boolean(), false);
  expect(boolean().decode("t")).toBe(true);
  round(bytea(), new Uint8Array([0, 255, 16]));
  round(json<{ readonly n: number }>(), { n: 1 });
  round(jsonb(), ["a", null]);
  round(uuid(), "01890c40-7e8a-7c3e-8c3e-9c6d5c2a1b00");
  round(timestamptz(), Temporal.Instant.from("2020-01-02T03:04:05.123456789Z"));
  round(timestamptz(0), Temporal.Instant.from("2020-01-02T03:04:05Z"));
  round(timestamp(), Temporal.PlainDateTime.from("2020-01-02T03:04:05.1"));
  round(date(), Temporal.PlainDate.from("2020-01-02"));
  round(time(0), Temporal.PlainTime.from("03:04:05"));
  round(timetz(), {
    time: Temporal.PlainTime.from("03:04:05"),
    offset: "+00:00",
  });
  round(interval(), Temporal.Duration.from("P1DT2H"));
  round(interval("day to second"), Temporal.Duration.from("PT2H"));
  round(tsvector(), "cat:1 fat:2");
  round(ltree(), "Top.Science.Astronomy");
  round(enumColumn("color", ["red", "blue"]), "red");
  round(inet(), "192.0.2.1");
  round(inet(), "2001:db8::1");
  round(cidr(), "192.0.2.0/24");
  round(macaddr(), "08:00:2b:01:02:03");
  round(macaddr8(), "08:00:2b:01:02:03:04:05");
  round(point(), { x: 1, y: -2.5 });
  round(line(), { a: 1, b: 0, c: -1 });
});

test("ranges, arrays, and json bigint round-trip", () => {
  const span: Range<number> = {
    empty: false,
    lower: 1,
    upper: 10,
    lowerInclusive: true,
    upperInclusive: false,
  };
  round(int4range(), span);
  round(int4range(), { empty: true });
  round(int8range(), {
    empty: false,
    lower: "1",
    upper: null,
    lowerInclusive: false,
    upperInclusive: false,
  });
  round(numrange(), {
    empty: false,
    lower: "1.5",
    upper: "2",
    lowerInclusive: true,
    upperInclusive: true,
  });
  round(daterange(), {
    empty: false,
    lower: Temporal.PlainDate.from("2020-01-01"),
    upper: Temporal.PlainDate.from("2020-01-03"),
    lowerInclusive: true,
    upperInclusive: false,
  });
  round(tstzrange(), {
    empty: false,
    lower: Temporal.Instant.from("2020-01-01T00:00:00Z"),
    upper: null,
    lowerInclusive: true,
    upperInclusive: false,
  });
  const tags = text().array();
  round(tags, ["a", 'say "hi"', "comma, here"]);
  round(integer().array({ dims: 2 }), [
    [1, 2],
    [3, 4],
  ]);
  expect(JSON.stringify({ n: 1n }, jsonReplacer)).toBe('{"n":"1"}');
});

test("OKM1210 rejects a value a codec cannot accept", () => {
  expect(codeOf(() => smallint().encode(40_000))).toBe("OKM1210");
  expect(codeOf(() => bigint({ as: "number" }).decode("9007199254740993"))).toBe("OKM1210");
  expect(codeOf(() => varchar(2).encode("abcd"))).toBe("OKM1210");
  expect(codeOf(() => numeric().encode("1.2.3"))).toBe("OKM1210");
  expect(codeOf(() => numeric().decode("nope"))).toBe("OKM1210");
  expect(codeOf(() => timestamptz().decode("not-a-time"))).toBe("OKM1210");
  expect(codeOf(() => point().decode("nope"))).toBe("OKM1210");
  expect(codeOf(() => boolean().decode("yes"))).toBe("OKM1210");
  expect(codeOf(() => ltree().encode("bad label"))).toBe("OKM1210");
  const listed = text().picklist(["a", "b"]);
  expect(codeOf(() => listed.encode("c" as "a"))).toBe("OKM1210");
});

test("a missing Temporal global says the app must supply it", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Temporal");
  Object.defineProperty(globalThis, "Temporal", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    let error: unknown;
    try {
      timestamptz().decode("2020-01-01T00:00:00Z");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1210");
      expect(error.message).toContain("globalThis.Temporal");
      expect(error.message).toContain("polyfill");
    }
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Temporal");
    } else {
      Object.defineProperty(globalThis, "Temporal", descriptor);
    }
  }
});

function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error.code;
    throw error;
  }
  throw new Error("expected OkmError");
}

function round<TValue, TFlags extends ColumnFlags>(
  column: ColumnBuilder<TValue, TFlags>,
  value: TValue,
): void {
  const decoded = column.decode(column.encode(value));
  if (value instanceof Uint8Array && decoded instanceof Uint8Array) {
    expect([...decoded]).toEqual([...value]);
    return;
  }
  if (isTemporal(value) && isTemporal(decoded)) {
    expect(decoded.toString()).toBe(value.toString());
    return;
  }
  if (isTimeZone(value) && isTimeZone(decoded)) {
    expect(decoded.offset).toBe(value.offset);
    expect(decoded.time.toString()).toBe(value.time.toString());
    return;
  }
  if (isBoundRange(value) && isBoundRange(decoded)) {
    expect(temporalText(decoded.lower)).toBe(temporalText(value.lower));
    expect(temporalText(decoded.upper)).toBe(temporalText(value.upper));
    expect(decoded.lowerInclusive).toBe(value.lowerInclusive);
    expect(decoded.upperInclusive).toBe(value.upperInclusive);
    return;
  }
  expect(decoded).toEqual(value);
}

function isTemporal(value: unknown): value is { toString(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value).startsWith("[object Temporal.")
  );
}

function isTimeZone(
  value: unknown,
): value is { readonly time: Temporal.PlainTime; readonly offset: string } {
  return typeof value === "object" && value !== null && "offset" in value && "time" in value;
}

function isBoundRange(value: unknown): value is {
  readonly empty: false;
  readonly lower: unknown;
  readonly upper: unknown;
  readonly lowerInclusive: boolean;
  readonly upperInclusive: boolean;
} {
  return typeof value === "object" && value !== null && "lowerInclusive" in value;
}

function temporalText(value: unknown): unknown {
  if (isTemporal(value)) {
    return value.toString();
  }
  return value;
}
