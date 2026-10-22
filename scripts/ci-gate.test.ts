/**
 * `gate / check` fails a slice that should have run and did not succeed.
 */

import { expect, test } from "bun:test";

import { gateFailures, parseGateSlices, type GateSlice } from "./ci-gate.js";

const READY: readonly GateSlice[] = [
  { name: "changes", result: "success" },
  { name: "lint", result: "success" },
  { name: "types", result: "success" },
  { name: "build", result: "success" },
  { name: "test", result: "success" },
  { name: "size", result: "success" },
  { name: "pull", result: "success" },
];

function withSuite(result: string): readonly GateSlice[] {
  return [...READY, { name: "suite", result }];
}

test("Postgres 18 must succeed when the path asked for it", () => {
  expect(gateFailures(withSuite("success"), true)).toEqual([]);
  expect(gateFailures(withSuite("skipped"), true).map((slice) => slice.name)).toEqual(["suite"]);
  expect(gateFailures(withSuite("failure"), true).map((slice) => slice.name)).toEqual(["suite"]);
});

test("a pull request that does not touch those paths allows a skipped suite", () => {
  expect(gateFailures(withSuite("skipped"), false)).toEqual([]);
  expect(gateFailures(withSuite("failure"), false).map((slice) => slice.name)).toEqual(["suite"]);
});

test("an always-on slice must be success", () => {
  const slices = withSuite("skipped").map((slice) =>
    slice.name === "test" ? { ...slice, result: "failure" } : slice,
  );
  expect(gateFailures(slices, false).map((slice) => slice.name)).toEqual(["test"]);
});

test("a skipped label job on a fork is allowed", () => {
  expect(gateFailures([...READY, { name: "paths", result: "skipped" }], false)).toEqual([]);
});

test("parseGateSlices reads name=result and ignores flags", () => {
  expect(parseGateSlices(["lint=success", "suite=skipped", "--postgres"])).toEqual([
    { name: "lint", result: "success" },
    { name: "suite", result: "skipped" },
  ]);
  expect(() => parseGateSlices(["lint="])).toThrow(/usage/);
});
