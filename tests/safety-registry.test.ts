/**
 * The safety registry: rules register, violations sort, and a read runs them.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import { safetyInstalled } from "../src/runtime/safety-hook.js";
import {
  SafetyError,
  registerRule,
  verify,
  type SafetyRule,
  type SafetyViolation,
} from "../src/runtime/safety/index.js";

const users = table("users", { id: t.identity() });
const app = schema({ tables: [users] });

test("registered rules report every violation in stable order", () => {
  expect(safetyInstalled()).toBe(false);
  const stops = [rule("zeta"), rule("alpha")].map((item) => registerRule(item));
  expect(safetyInstalled()).toBe(true);
  let caught: unknown;
  try {
    verify({ contributions: [] });
    expect.unreachable();
  } catch (error) {
    caught = error;
  } finally {
    for (const stop of stops) stop();
  }
  expect(caught).toBeInstanceOf(SafetyError);
  if (!(caught instanceof SafetyError)) return;
  expect(caught.code).toBe("OKM1190");
  expect(caught.rule).toBe("alpha");
  expect(caught.contribution).toBe("example");
  expect(caught.violations.map((item) => item.rule)).toEqual(["alpha", "zeta"]);
  expect(caught.message).toContain("safety-registry.test.ts:");
  expect(caught.violations[0]?.source).toMatch(/safety-registry\.test\.ts:\d+/);
  expect(safetyInstalled()).toBe(false);
});

test("a blank escape hatch is a violation and a reason is not", () => {
  const stop = registerRule({
    name: "open",
    contribution: "example",
    source: "registry.ts:1",
    check(input) {
      if (input.hatches?.some((hatch) => hatch.name === "all") === true) return [];
      return [{ rule: "open", contribution: "example", detail: "closed" }];
    },
  });
  try {
    expect(() => verify({ contributions: [], hatches: [{ name: "all", reason: " " }] })).toThrow(
      SafetyError,
    );
    verify({ contributions: [], hatches: [{ name: "all", reason: "export" }] });
  } finally {
    stop();
  }
});

test("a registered rule runs before a read is planned", () => {
  const stop = registerRule({
    name: "blocked",
    contribution: "example",
    source: "registry.ts:2",
    check() {
      return [{ rule: "blocked", contribution: "example", detail: "blocked" }];
    },
  });
  const db = createClient(app, fakePool(), { ownsPool: false });
  try {
    expect(() => db.users.find({ limit: 1 }).inspect()).toThrow(SafetyError);
  } finally {
    stop();
  }
  const inspected = db.users.find({ limit: 1 }).inspect();
  expect(inspected).not.toBeInstanceOf(Promise);
});

function rule(name: string): SafetyRule {
  return {
    name,
    contribution: "example",
    check(): readonly SafetyViolation[] {
      return [{ rule: name, contribution: "example", detail: name }];
    },
  };
}

function fakePool(): DriverPool {
  return {
    capabilities: {
      transactions: "none",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "none",
      describe: false,
    },
    execute() {
      return Promise.resolve({
        rows: [["170000", "PostgreSQL 17", null]],
        count: 1,
        notices: [],
      });
    },
    batch() {
      return Promise.resolve([]);
    },
    stats() {
      return { size: 0, idle: 0, inflight: 0, waiting: 0 };
    },
    close() {
      return Promise.resolve();
    },
  };
}
