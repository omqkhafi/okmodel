/**
 * `gate / check` fails a slice that should have run and did not succeed.
 */

import { expect, test } from "bun:test";

import { gateFailures, parseGateSlices, type GateSlice } from "./ci-gate.js";

const ALWAYS: readonly GateSlice[] = [
  { name: "lint", result: "success", postgres: false, filtered: false, full: false },
  { name: "types", result: "success", postgres: false, filtered: false, full: false },
  { name: "test", result: "success", postgres: false, filtered: true, full: false },
  { name: "test-dist", result: "success", postgres: false, filtered: true, full: false },
  { name: "runtimes", result: "success", postgres: false, filtered: true, full: true },
  { name: "temporal", result: "success", postgres: false, filtered: true, full: true },
  { name: "package", result: "success", postgres: false, filtered: false, full: true },
  {
    name: "drivers-conformance",
    result: "success",
    postgres: false,
    filtered: true,
    full: true,
  },
];

function withPostgres(suite: string, tarball: string): readonly GateSlice[] {
  return [
    ...ALWAYS,
    { name: "suite", result: suite, postgres: true, filtered: true, full: true },
    { name: "tarball", result: tarball, postgres: true, filtered: true, full: false },
  ];
}

test("a labelled pull request accepts only success for the Postgres slices", () => {
  expect(gateFailures(withPostgres("success", "success"), true)).toEqual([]);
  expect(gateFailures(withPostgres("skipped", "success"), true).map((slice) => slice.name)).toEqual(
    ["suite"],
  );
  expect(
    gateFailures(withPostgres("failure", "cancelled"), true).map((slice) => slice.name),
  ).toEqual(["suite", "tarball"]);
});

test("without the label a skipped Postgres slice passes and a failure does not", () => {
  expect(gateFailures(withPostgres("skipped", "skipped"), false)).toEqual([]);
  expect(gateFailures(withPostgres("success", "skipped"), false)).toEqual([]);
  expect(
    gateFailures(withPostgres("failure", "skipped"), false).map((slice) => slice.name),
  ).toEqual(["suite"]);
});

test("an always-on slice must be success even when Postgres is off", () => {
  const slices = withPostgres("skipped", "skipped").map((slice) =>
    slice.name === "test" ? { ...slice, result: "failure" } : slice,
  );
  expect(gateFailures(slices, false).map((slice) => slice.name)).toEqual(["test"]);
});

test("parseGateSlices marks suite and tarball as Postgres slices", () => {
  expect(
    parseGateSlices(["lint=success", "suite=skipped", "tarball=success", "--runtime"]),
  ).toEqual([
    { name: "lint", result: "success", postgres: false, filtered: false, full: false },
    { name: "suite", result: "skipped", postgres: true, filtered: true, full: true },
    { name: "tarball", result: "success", postgres: true, filtered: true, full: false },
  ]);
  expect(() => parseGateSlices(["lint="])).toThrow(/usage/);
});

test("a docs-only filter allows a skipped runtime slice and a labelled Postgres skip", () => {
  const skipped = withPostgres("skipped", "skipped").map((slice) =>
    slice.name === "test" || slice.name === "test-dist" ? { ...slice, result: "skipped" } : slice,
  );
  expect(gateFailures(skipped, true, false)).toEqual([]);
  expect(gateFailures(skipped, true, true).map((slice) => slice.name)).toEqual([
    "test",
    "test-dist",
    "suite",
    "tarball",
  ]);
});

test("the fast tier allows a skipped full slice and the full tier does not", () => {
  const slices = withPostgres("skipped", "skipped").map((slice) =>
    slice.full ? { ...slice, result: "skipped" } : slice,
  );
  expect(gateFailures(slices, false, true, false)).toEqual([]);
  expect(gateFailures(slices, false, true, true).map((slice) => slice.name)).toEqual([
    "runtimes",
    "temporal",
    "package",
    "drivers-conformance",
    "suite",
  ]);
});

test("the full tier still allows a skipped tarball without the Postgres label", () => {
  expect(gateFailures(withPostgres("success", "skipped"), false, true, true)).toEqual([]);
});

test("a filtered slice that failed still fails when the filter says it is irrelevant", () => {
  const slices = withPostgres("skipped", "skipped").map((slice) =>
    slice.name === "test" ? { ...slice, result: "failure" } : slice,
  );
  expect(gateFailures(slices, false, false).map((slice) => slice.name)).toEqual(["test"]);
});
