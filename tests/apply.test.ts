/**
 * Apply policy, plan text, and status, without a database.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { applyUnits } from "../src/tooling/migrate/apply.js";
import { driftVerdict } from "../src/runtime/drift-detail.js";
import { describeStatus } from "../src/tooling/migrate/status.js";
import { formatPlan, parsePlan, type PlanStep } from "../src/tooling/migrate/plan.js";
import {
  assertDirectConnection,
  assertTargetAlias,
  assertTargetPolicy,
  selectTarget,
  type PolicyOperation,
  type TargetRecord,
} from "../src/tooling/migrate/policy.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";

const operations: readonly PolicyOperation[] = [
  "plan",
  "status",
  "check",
  "drift",
  "verify",
  "pull",
  "catalog-export",
  "inspect",
  "expand",
  "reference",
  "provision",
  "contract",
  "unclassified",
  "push",
  "backfill",
  "seed",
  "history-repair",
  "drop",
  "rollback",
];

const allowed = new Set<PolicyOperation>([
  "plan",
  "status",
  "check",
  "drift",
  "verify",
  "pull",
  "catalog-export",
  "inspect",
  "expand",
  "reference",
  "provision",
]);

test("protected policy matches the operation table", () => {
  const target = { name: "production", protected: true };
  for (const operation of operations) {
    if (operation === "drop" || operation === "rollback") {
      expect(() => assertTargetPolicy(target, operation, true)).toThrow(OkmError);
      continue;
    }
    if (allowed.has(operation)) {
      expect(() => assertTargetPolicy(target, operation)).not.toThrow();
      continue;
    }
    expect(() => assertTargetPolicy(target, operation)).toThrow(OkmError);
    try {
      assertTargetPolicy(target, operation);
    } catch (error) {
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) expect(error.code).toBe("OKM1850");
    }
    expect(() => assertTargetPolicy(target, operation, true)).not.toThrow();
  }
  expect(() => assertTargetPolicy({ name: "dev", protected: false }, "push")).not.toThrow();
  expect(() => assertTargetPolicy({ name: "production", protected: false }, "push")).not.toThrow();
});

test("several targets require --target and a shared database must agree", () => {
  const config = {
    schema: "./schema.ts",
    targets: {
      production: { url: "postgres://okm:okm@127.0.0.1:55432/okm", protected: true },
      staging: "postgres://okm:okm@127.0.0.1:55432/okm",
    },
  };
  expect(() => selectTarget(config, undefined)).toThrow(OkmError);
  try {
    selectTarget(config, undefined);
  } catch (error) {
    if (error instanceof OkmError) expect(error.code).toBe("OKM1853");
  }
  expect(selectTarget(config, "staging").name).toBe("staging");
  const targets = [
    endpoint("production", "postgres://okm:okm@db.example:5432/app", true),
    endpoint("preview", "postgres://okm:okm@db.example:5432/app", false),
  ];
  expect(() => assertTargetAlias(targets)).toThrow(OkmError);
  try {
    assertTargetAlias(targets);
  } catch (error) {
    if (error instanceof OkmError) expect(error.code).toBe("OKM1852");
  }
  expect(() =>
    assertTargetAlias([
      endpoint("a", "postgres://okm:okm@db.example:5432/app", false),
      endpoint("b", "postgres://okm:okm@db.example:5432/app", false),
    ]),
  ).not.toThrow();
});

test("known pooler URLs are refused", () => {
  expect(() =>
    assertDirectConnection("postgres://u@db.pooler.supabase.com:6543/app", false),
  ).toThrow(OkmError);
  expect(() => assertDirectConnection("postgres://u@ep-cool-pooler.neon.tech/app", false)).toThrow(
    OkmError,
  );
  expect(() =>
    assertDirectConnection("postgres://u@db.pooler.supabase.com:6543/app", true),
  ).not.toThrow();
  expect(() =>
    assertDirectConnection("postgres://okm:okm@127.0.0.1:55432/okm", false),
  ).not.toThrow();
});

test("a non-transactional step splits the units around it", () => {
  const migration: StoredMigration = {
    id: "0002_add",
    catalogHash: "hash",
    steps: [
      step("create type color as enum ('red')"),
      step("alter type color add value 'blue'", false),
      step("insert into items values (1, 'blue')"),
    ],
  };
  const units = applyUnits(migration, new Set());
  expect(units.map((unit) => unit.transactional)).toEqual([true, false, true]);
  expect(units[1]?.steps[0]?.index).toBe(1);
  const resumed = applyUnits(migration, new Set(["0002_add:0", "0002_add:1"]));
  expect(resumed).toHaveLength(1);
  expect(resumed[0]?.steps[0]?.index).toBe(2);
});

test("plan text round-trips", () => {
  const plan = {
    name: "add",
    class: "expand" as const,
    steps: [
      step("create table items (id integer)"),
      step("alter type color add value 'blue'", false),
    ],
  };
  const parsed = parsePlan(formatPlan(plan));
  expect(parsed.steps.map((item) => item.sql)).toEqual(plan.steps.map((item) => item.sql));
  expect(parsed.steps[1]?.transactional).toBe(false);
});

test("status states from history", () => {
  const expand = migration("0001_init", "a", [step("create table items (id integer)")]);
  const contract = migration("0002_drop", "b", [step("drop table items", true, "contract")]);
  expect(describeStatus([expand], [], undefined).state).toBe("behind by expand");
  expect(describeStatus([expand, contract], [], undefined).state).toBe("behind by contract");
  expect(
    describeStatus([expand], [{ migrationId: "0001_init", stepIndex: 0, class: "expand" }], {
      hash: "a",
      version: "0001_init",
    }).state,
  ).toBe("current");
  expect(
    describeStatus([expand], [{ migrationId: "0009_future", stepIndex: 0, class: "expand" }], {
      hash: "z",
      version: "0009_future",
    }).state,
  ).toBe("ahead");
  expect(
    describeStatus(
      [migration("0003_two", "c", [step("select 1"), step("select 2")])],
      [{ migrationId: "0003_two", stepIndex: 0, class: "expand" }],
      undefined,
    ).state,
  ).toBe("failed at step 1");
});

test("ahead by expand is compatible and contract or behind is not", () => {
  const older = { id: "0001", catalogHash: "code", expand: true };
  const newer = { id: "0002", catalogHash: "db", expand: true };
  expect(driftVerdict("code", "db", [older, newer])).toBe("ok");
  expect(driftVerdict("code", "db", [older, { ...newer, expand: false }])).toBe("contract");
  expect(driftVerdict("missing", "db", [older, newer])).toBe("behind");
  expect(driftVerdict("db", "code", [older, newer])).toBe("behind");
});

function step(
  sql: string,
  transactional = true,
  stepClass: PlanStep["class"] = "expand",
): PlanStep {
  return { sql, class: stepClass, action: "ddl", lock: "ACCESS EXCLUSIVE", transactional };
}

function migration(id: string, catalogHash: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash, steps };
}

function endpoint(name: string, url: string, protectedTarget: boolean): TargetRecord {
  const parsed = new URL(url);
  return {
    name,
    url,
    protected: protectedTarget,
    host: parsed.hostname,
    port: parsed.port.length > 0 ? parsed.port : "5432",
    database: parsed.pathname.slice(1),
  };
}
