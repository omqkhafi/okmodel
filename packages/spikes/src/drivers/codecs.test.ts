import { expect, test } from "bun:test";

import { decodeBoolean, decodeTextArray, decodeTimestamp, inlineParams } from "./sql.js";

test("wire codecs decode booleans, arrays, and timestamps", () => {
  expect(decodeBoolean("t")).toBe(true);
  expect(decodeBoolean("f")).toBe(false);
  expect(decodeTextArray("{}")).toEqual([]);
  expect(decodeTextArray("{alpha,beta}")).toEqual(["alpha", "beta"]);
  expect(decodeTextArray("{NULL,a}")).toEqual([null, "a"]);
  expect(decodeTextArray('{"a,b","c\\"d"}')).toEqual(["a,b", 'c"d']);
  expect(decodeTimestamp("2020-01-02 03:04:05.123456+00")).toBe(
    Date.parse("2020-01-02T03:04:05.123Z"),
  );
});

test("simple-protocol parameters are quoted literals", () => {
  expect(inlineParams("select $1, $2, $10", ["a", null, "b"])).toBe("select 'a', NULL, $10");
  expect(inlineParams("select $1", ["o'brien"])).toBe("select 'o''brien'");
});
