/**
 * JSON cannot mint an operator. Plain objects are OKM1121.
 */

import { expect, test } from "bun:test";

import { SafetyError } from "./errors.js";
import {
  between,
  has,
  inList,
  isTaggedOperator,
  lt,
  or,
  readFilterInput,
  startsWith,
} from "./operators.js";

test("helpers stamp an operator and JSON cannot", () => {
  const tagged = lt(1);
  expect(isTaggedOperator(tagged)).toBe(true);
  expect(readFilterInput(tagged)).toEqual({ kind: "op", op: "lt", value: 1 });
  const parsed: unknown = JSON.parse(JSON.stringify(tagged));
  expect(isTaggedOperator(parsed)).toBe(false);
  expect(() => readFilterInput(parsed)).toThrow(SafetyError);
  try {
    readFilterInput(parsed);
  } catch (error) {
    expect(error).toBeInstanceOf(SafetyError);
    expect((error as SafetyError).code).toBe("OKM1121");
  }
});

test("scalars and null are equality, objects and arrays are rejected", () => {
  expect(readFilterInput(undefined)).toEqual({ kind: "skip" });
  expect(readFilterInput(null)).toEqual({ kind: "null" });
  expect(readFilterInput("draft")).toEqual({ kind: "eq", value: "draft" });
  expect(readFilterInput(false)).toEqual({ kind: "eq", value: false });
  expect(() => readFilterInput({ lt: 1 })).toThrow(/OKM1121/);
  expect(() => readFilterInput([1, 2])).toThrow(/OKM1121/);
  expect(() => readFilterInput({ op: "lt", value: 1 })).toThrow(/OKM1121/);
});

test("relation and list operators stay tagged", () => {
  expect(isTaggedOperator(has({ name: startsWith("Work") }))).toBe(true);
  expect(isTaggedOperator(inList(["draft", "active"]))).toBe(true);
  expect(isTaggedOperator(between(1, 3))).toBe(true);
  expect(isTaggedOperator(or(lt(1), lt(2)))).toBe(true);
  const spread = { ...lt(1) };
  expect(isTaggedOperator(spread)).toBe(true);
});
