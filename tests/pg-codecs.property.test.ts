/**
 * Property tests for the codecs whose inputs are large.
 */

import { expect, test } from "bun:test";
import * as fc from "fast-check";

import {
  bigint,
  integer,
  json,
  numeric,
  text,
  timestamptz,
  int4range,
  daterange,
} from "../src/dialects/pg/index.js";

test("bigint strings round-trip", () => {
  fc.assert(
    fc.property(fc.bigInt(), (value) => {
      const text = value.toString();
      expect(bigint().decode(bigint().encode(text))).toBe(text);
    }),
  );
});

test("numeric strings round-trip", () => {
  const literal = fc
    .tuple(fc.boolean(), fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 6 }))
    .map(([negative, whole, fraction]) => {
      const digits = String(whole);
      const tail = fraction === 0 ? "" : `.${String(fraction)}`;
      return `${negative ? "-" : ""}${digits}${tail}`;
    });
  fc.assert(
    fc.property(literal, (value) => {
      expect(numeric().decode(numeric().encode(value))).toBe(value);
    }),
  );
});

test("integers and timestamps round-trip", () => {
  fc.assert(
    fc.property(fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }), (value) => {
      expect(integer().decode(integer().encode(value))).toBe(value);
    }),
  );
  fc.assert(
    fc.property(fc.integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(2100, 0, 1) }), (ms) => {
      const instant = Temporal.Instant.from(new Date(ms).toISOString());
      const column = timestamptz();
      expect(column.decode(column.encode(instant)).toString()).toBe(instant.toString());
    }),
  );
});

test("ranges, arrays, and json round-trip", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      (lower, span) => {
        const value = {
          empty: false as const,
          lower,
          upper: lower + span,
          lowerInclusive: true,
          upperInclusive: false,
        };
        expect(int4range().decode(int4range().encode(value))).toEqual(value);
      },
    ),
  );
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 20_000 }), (day) => {
      const lower = Temporal.PlainDate.from("2020-01-01").add({ days: day });
      const value = {
        empty: false as const,
        lower,
        upper: lower.add({ days: 1 }),
        lowerInclusive: true,
        upperInclusive: false,
      };
      const decoded = daterange().decode(daterange().encode(value));
      if (decoded.empty) {
        throw new Error("expected a bounded range");
      }
      expect(decoded.lower?.toString()).toBe(lower.toString());
      expect(decoded.upper?.toString()).toBe(value.upper.toString());
    }),
  );
  const word = fc.string({ minLength: 0, maxLength: 8 }).filter((value) => !hasControl(value));
  fc.assert(
    fc.property(fc.array(word, { maxLength: 6 }), (values) => {
      const column = text().array();
      expect(column.decode(column.encode(values))).toEqual(values);
    }),
  );
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), (value) => {
      expect(json().decode(json().encode(value))).toEqual(value);
    }),
  );
});

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
