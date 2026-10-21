/**
 * Every planner kind has an operation class.
 */

import { expect, test } from "bun:test";

import {
  OPERATION_CLASS,
  STEP_KINDS,
  operationClassOf,
  strictestOperation,
} from "../src/tooling/migrate/classify.js";

test("every step kind has one operation class", () => {
  expect(Object.keys(OPERATION_CLASS).sort()).toEqual([...STEP_KINDS].sort());
  for (const kind of STEP_KINDS) {
    expect(operationClassOf(kind)).toBe(OPERATION_CLASS[kind]);
  }
});

test("the plan class is the maximum, and an empty plan is additive", () => {
  expect(strictestOperation([])).toBe("additive");
  expect(strictestOperation(["additive", "widening", "data"])).toBe("data");
  expect(strictestOperation(["widening", "destructive", "additive"])).toBe("destructive");
});
