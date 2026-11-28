/**
 * Fleet scheduling, limits, and redaction. No database.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { parseCli } from "../src/tooling/cli/parse.js";
import {
  allowedFailures,
  assertContractGate,
  assertFleetHead,
  estimateFleet,
  failuresStop,
  fleetExit,
  parseMaxFailures,
  planStages,
  redactSecrets,
  resolveFleetTargets,
  scheduleTargets,
  type FleetTarget,
  type SizedTarget,
} from "../src/tooling/migrate/fleet-config.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";

const files = [
  { id: "0001_expand", catalogHash: "a", steps: [{ class: "expand" }] },
  { id: "0002_contract", catalogHash: "b", steps: [{ class: "contract" }] },
] as unknown as StoredMigration[];

function sized(name: string, bytes: number, actionable: boolean): SizedTarget {
  return { name, url: `postgres://okm:okm@${name}.example:5432/db`, bytes, actionable };
}

test("maxFailures accepts 0, a count, a percent, and all", () => {
  expect(parseMaxFailures(undefined)).toBe(0);
  expect(parseMaxFailures(0)).toBe(0);
  expect(parseMaxFailures("3")).toBe(3);
  expect(parseMaxFailures("2%")).toBe("2%");
  expect(parseMaxFailures("all")).toBe("all");
  expect(() => parseMaxFailures("nope")).toThrow(OkmError);
});

test("a percent is of started targets and unreachable is not a failure", () => {
  expect(allowedFailures(0, 10)).toBe(0);
  expect(allowedFailures(3, 10)).toBe(3);
  expect(allowedFailures("2%", 50)).toBe(1);
  expect(allowedFailures("all", 4)).toBe("all");
  expect(failuresStop(0, 1, 1)).toBe(true);
  expect(failuresStop(1, 2, 1)).toBe(false);
  expect(failuresStop("50%", 1, 1)).toBe(true);
  expect(failuresStop("all", 4, 4)).toBe(false);
});

test("the canary is the smallest actionable database, then groups, then rest", () => {
  const targets = [
    sized("big", 500, true),
    sized("small", 10, true),
    sized("done", 1, false),
    sized("eu", 40, true),
  ];
  const stages = planStages(
    targets,
    1,
    [{ name: "eu", match: (target) => target.name === "eu", parallel: 8 }],
    4,
  );
  expect(stages.map((stage) => stage.name)).toEqual(["canary", "eu", "rest"]);
  expect(stages[0]?.targets.map((target) => target.name)).toEqual(["small"]);
  expect(stages[1]?.targets.map((target) => target.name)).toEqual(["eu"]);
  expect(stages[1]?.parallel).toBe(8);
  expect(stages[2]?.targets.map((target) => target.name).sort()).toEqual(["big", "done"]);
  expect(() => planStages(targets, 1, [{ name: "rest", match: () => true }], 4)).toThrow(OkmError);
});

test("perHost lets another host start while one host is full", async () => {
  const items = ["a", "a", "b", "b"];
  let activeA = 0;
  let activeB = 0;
  let peakA = 0;
  let peakB = 0;
  let both = false;
  await scheduleTargets(
    items,
    { parallel: 4, perHost: 1 },
    (host) => host,
    () => false,
    async (host) => {
      if (host === "a") {
        activeA += 1;
        peakA = Math.max(peakA, activeA);
      } else {
        activeB += 1;
        peakB = Math.max(peakB, activeB);
      }
      if (activeA > 0 && activeB > 0) both = true;
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (host === "a") activeA -= 1;
      else activeB -= 1;
    },
  );
  expect(peakA).toBe(1);
  expect(peakB).toBe(1);
  expect(both).toBe(true);
});

test("stop finishes in-flight work and starts nothing new", async () => {
  const started: number[] = [];
  let stop = false;
  await scheduleTargets(
    [1, 2, 3],
    { parallel: 1, perHost: 1 },
    () => "h",
    () => stop,
    async (item) => {
      started.push(item);
      stop = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  );
  expect(started).toEqual([1]);
});

test("redactSecrets removes urls and long passwords", () => {
  const url = "postgres://okm:s3cret-token@db.example:5432/acme";
  const text = redactSecrets(`failed ${url} password s3cret-token host db.example`, [url]);
  expect(text).not.toContain("postgres://");
  expect(text).not.toContain("s3cret-token");
  expect(text).not.toContain("db.example");
  expect(redactSecrets("user okm is local", ["postgres://okm:okm@127.0.0.1:5432/okm"])).toContain(
    "okm",
  );
});

test("a contract step waits until every target has the expand", () => {
  expect(() =>
    assertContractGate(
      files,
      [{ name: "acme", state: "behind", pending: ["0001_expand:0"] }],
      false,
    ),
  ).toThrow(OkmError);
  expect(() =>
    assertContractGate(files, [{ name: "acme", state: "unreachable", pending: [] }], false),
  ).toThrow(OkmError);
  expect(() =>
    assertContractGate(files, [{ name: "acme", state: "current", pending: [] }], false),
  ).not.toThrow();
  expect(() =>
    assertContractGate(
      files,
      [{ name: "acme", state: "behind", pending: ["0001_expand:0"] }],
      true,
    ),
  ).not.toThrow();
});

test("a frozen plan refuses a moved head", () => {
  expect(() =>
    assertFleetHead(
      "acme",
      { migrationId: "0001_init", catalogHash: "a" },
      { migrationId: "0002_next", catalogHash: "b" },
    ),
  ).toThrow(OkmError);
  expect(() =>
    assertFleetHead(
      "acme",
      { migrationId: "0001_init", catalogHash: "a" },
      { migrationId: "0001_init", catalogHash: "a" },
    ),
  ).not.toThrow();
});

test("a blocking step dominates the estimate", () => {
  const estimate = estimateFleet(
    [{ name: "acme", steps: [{ weight: "blocking", rows: 2_000_000 }] }],
    4,
  );
  expect(estimate.longestName).toBe("acme");
  expect(estimate.longestMs).toBeGreaterThan(0);
  expect(estimate.totalMs).toBeGreaterThan(0);
});

test("fleet exit follows the contract", () => {
  expect(fleetExit({ guarded: true, failures: 0, unreachable: 0 })).toBe(4);
  expect(fleetExit({ guarded: false, failures: 1, unreachable: 1 })).toBe(1);
  expect(fleetExit({ guarded: false, failures: 0, unreachable: 2 })).toBe(5);
  expect(fleetExit({ guarded: false, failures: 0, unreachable: 0 })).toBe(0);
});

test("an env list is names and urls, and a bad name is refused", async () => {
  const targets = await resolveFleetTargets(
    { env: "OKM_FLEET_TEST_TARGETS" },
    { OKM_FLEET_TEST_TARGETS: "acme postgres://okm:okm@127.0.0.1:5432/acme\n# note\n" },
  );
  expect(targets.map((target: FleetTarget) => target.name)).toEqual(["acme"]);
  let refused = false;
  try {
    await resolveFleetTargets({ env: "OKM_FLEET_TEST_TARGETS" }, { OKM_FLEET_TEST_TARGETS: "" });
  } catch (error) {
    refused = error instanceof OkmError;
  }
  expect(refused).toBe(true);
});

test("--fleet rejects --target and fleet flags without --fleet", () => {
  expect(() => parseCli(["migrate", "status", "--fleet", "--target", "acme"])).toThrow(OkmError);
  expect(() => parseCli(["migrate", "apply", "--max-failures", "1"])).toThrow(OkmError);
  const parsed = parseCli(["migrate", "plan", "--fleet", "--out", "fleet.plan.json"]);
  expect(parsed.fleet).toBe(true);
  expect(parsed.out).toBe("fleet.plan.json");
  expect(parsed.operands).toEqual([]);
});
