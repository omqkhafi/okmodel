/**
 * `gate / check` fails a slice that should have run and did not succeed.
 */

import { expect, test } from "bun:test";

import { gateFailures, parseGateSlices, type GateSlice } from "./ci-gate.js";

const ALWAYS: readonly GateSlice[] = [
  { name: "lint", result: "success", postgres: false },
  { name: "types", result: "success", postgres: false },
  { name: "test", result: "success", postgres: false },
  { name: "runtimes", result: "success", postgres: false },
  { name: "temporal", result: "success", postgres: false },
  { name: "package", result: "success", postgres: false },
];

function withPostgres(suite: string, tarball: string): readonly GateSlice[] {
  return [
    ...ALWAYS,
    { name: "suite", result: suite, postgres: true },
    { name: "tarball", result: tarball, postgres: true },
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
  expect(parseGateSlices(["lint=success", "suite=skipped", "tarball=success"])).toEqual([
    { name: "lint", result: "success", postgres: false },
    { name: "suite", result: "skipped", postgres: true },
    { name: "tarball", result: "success", postgres: true },
  ]);
  expect(() => parseGateSlices(["lint"])).toThrow(/usage/);
});
