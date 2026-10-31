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
  expect(
    gateFailures(withSuite("success"), { postgres: true, lifecycle: false, site: false }),
  ).toEqual([]);
  expect(
    gateFailures(withSuite("skipped"), { postgres: true, lifecycle: false, site: false }).map(
      (slice) => slice.name,
    ),
  ).toEqual(["suite"]);
  expect(
    gateFailures(withSuite("failure"), { postgres: true, lifecycle: false, site: false }).map(
      (slice) => slice.name,
    ),
  ).toEqual(["suite"]);
});

test("a pull request that does not touch those paths allows a skipped suite", () => {
  expect(
    gateFailures(withSuite("skipped"), { postgres: false, lifecycle: false, site: false }),
  ).toEqual([]);
  expect(
    gateFailures(withSuite("failure"), { postgres: false, lifecycle: false, site: false }).map(
      (slice) => slice.name,
    ),
  ).toEqual(["suite"]);
});

test("lifecycle must succeed when the path asked for it", () => {
  const slices = [
    ...READY,
    { name: "suite", result: "skipped" },
    { name: "lifecycle", result: "success" },
  ];
  expect(gateFailures(slices, { postgres: false, lifecycle: true, site: false })).toEqual([]);
  expect(
    gateFailures(
      [...READY, { name: "suite", result: "skipped" }, { name: "lifecycle", result: "skipped" }],
      { postgres: false, lifecycle: true, site: false },
    ).map((slice) => slice.name),
  ).toEqual(["lifecycle"]);
});

test("composition must succeed when the path asked for it", () => {
  expect(
    gateFailures(
      [...READY, { name: "suite", result: "skipped" }, { name: "composition", result: "success" }],
      { postgres: false, lifecycle: false, site: false, composition: true },
    ),
  ).toEqual([]);
  expect(
    gateFailures(
      [...READY, { name: "suite", result: "skipped" }, { name: "composition", result: "skipped" }],
      { postgres: false, lifecycle: false, site: false, composition: true },
    ).map((slice) => slice.name),
  ).toEqual(["composition"]);
});

test("a pull request that does not touch composition paths allows a skipped composition job", () => {
  expect(
    gateFailures(
      [...READY, { name: "suite", result: "skipped" }, { name: "composition", result: "skipped" }],
      { postgres: false, lifecycle: false, site: false },
    ),
  ).toEqual([]);
});

test("a pull request that does not touch lifecycle paths allows a skipped lifecycle job", () => {
  expect(
    gateFailures(
      [...READY, { name: "suite", result: "skipped" }, { name: "lifecycle", result: "skipped" }],
      { postgres: false, lifecycle: false, site: false },
    ),
  ).toEqual([]);
});

test("an always-on slice must be success", () => {
  const slices = withSuite("skipped").map((slice) =>
    slice.name === "test" ? { ...slice, result: "failure" } : slice,
  );
  expect(
    gateFailures(slices, { postgres: false, lifecycle: false, site: false }).map(
      (slice) => slice.name,
    ),
  ).toEqual(["test"]);
});

test("a skipped label job on a fork is allowed", () => {
  expect(
    gateFailures([...READY, { name: "paths", result: "skipped" }], {
      postgres: false,
      lifecycle: false,
      site: false,
    }),
  ).toEqual([]);
});

test("boolean postgres request still works for older callers", () => {
  expect(gateFailures(withSuite("skipped"), false)).toEqual([]);
  expect(gateFailures(withSuite("skipped"), true).map((slice) => slice.name)).toEqual(["suite"]);
});

test("site tests must succeed when tooling or dialects changed", () => {
  const skipped = [...READY, { name: "site", result: "skipped" }];
  expect(
    gateFailures(skipped, { postgres: false, lifecycle: false, site: true }).map(
      (slice) => slice.name,
    ),
  ).toEqual(["site"]);
  expect(
    gateFailures([...READY, { name: "site", result: "failure" }], {
      postgres: false,
      lifecycle: false,
      site: true,
    }).map((slice) => slice.name),
  ).toEqual(["site"]);
  expect(
    gateFailures([...READY, { name: "site", result: "success" }], {
      postgres: false,
      lifecycle: false,
      site: true,
    }),
  ).toEqual([]);
});

test("a pull request that does not touch tooling or dialects allows a skipped site job", () => {
  expect(
    gateFailures([...READY, { name: "site", result: "skipped" }], {
      postgres: false,
      lifecycle: false,
      site: false,
    }),
  ).toEqual([]);
});

test("the pack contract must succeed when src, scripts, or package.json changed", () => {
  const skipped = [...READY, { name: "pack", result: "skipped" }];
  expect(
    gateFailures(skipped, { postgres: false, lifecycle: false, site: false, pack: true }).map(
      (slice) => slice.name,
    ),
  ).toEqual(["pack"]);
  expect(
    gateFailures([...READY, { name: "pack", result: "failure" }], {
      postgres: false,
      lifecycle: false,
      site: false,
      pack: true,
    }).map((slice) => slice.name),
  ).toEqual(["pack"]);
  expect(
    gateFailures([...READY, { name: "pack", result: "success" }], {
      postgres: false,
      lifecycle: false,
      site: false,
      pack: true,
    }),
  ).toEqual([]);
});

test("a pull request that does not touch those paths allows a skipped pack job", () => {
  expect(
    gateFailures([...READY, { name: "pack", result: "skipped" }], {
      postgres: false,
      lifecycle: false,
      site: false,
    }),
  ).toEqual([]);
  expect(
    gateFailures([...READY, { name: "pack", result: "failure" }], {
      postgres: false,
      lifecycle: false,
      site: false,
    }).map((slice) => slice.name),
  ).toEqual(["pack"]);
});

test("examples may skip unless requested", () => {
  const skipped = [...READY, { name: "examples", result: "skipped" }];
  expect(
    gateFailures(skipped, {
      postgres: false,
      lifecycle: false,
      site: false,
      examples: true,
    }).map((slice) => slice.name),
  ).toEqual(["examples"]);
  expect(
    gateFailures([...READY, { name: "examples", result: "success" }], {
      postgres: false,
      lifecycle: false,
      site: false,
      examples: true,
    }),
  ).toEqual([]);
  expect(
    gateFailures([...READY, { name: "examples", result: "skipped" }], {
      postgres: false,
      lifecycle: false,
      site: false,
      examples: false,
    }),
  ).toEqual([]);
});

test("parseGateSlices reads name=result and ignores flags", () => {
  expect(parseGateSlices(["lint=success", "suite=skipped", "--postgres"])).toEqual([
    { name: "lint", result: "success" },
    { name: "suite", result: "skipped" },
  ]);
  expect(() => parseGateSlices(["lint="])).toThrow(/usage/);
});
