/**
 * Protected-target policy and the aliasing guard.
 *
 * `protected.policy` walks every operation class. OKM1852 refuses an
 * unprotected target that shares a database with a protected one.
 */

import { expect, test } from "bun:test";

import { assertNoProtectedAlias, type PhysicalTarget } from "./alias.js";
import { TargetError } from "./error.js";
import {
  assertTargetPolicy,
  OPERATION_CLASSES,
  policyDecision,
  type OperationClass,
} from "./policy.js";

const READ_ONLY = [
  "plan",
  "status",
  "check",
  "drift",
  "verify",
  "pull",
  "catalog-export",
  "inspect",
] as const satisfies readonly OperationClass[];

const ALLOWED_WHEN_PROTECTED = [...READ_ONLY, "expand", "reference"] as const;

const BLOCKED_WHEN_PROTECTED = [
  "contract",
  "unclassified",
  "push",
  "backfill",
  "seed",
  "history-repair",
] as const satisfies readonly OperationClass[];

test("protected.policy", () => {
  expect(new Set(OPERATION_CLASSES).size).toBe(OPERATION_CLASSES.length);
  for (const operation of OPERATION_CLASSES) {
    expect(policyDecision({ protected: false }, operation)).toBe(
      operation === "drop" || operation === "rollback" ? "block" : "allow",
    );
    expect(policyDecision({ protected: true }, operation, { allowProtected: true })).toBe(
      operation === "drop" || operation === "rollback" ? "block" : "allow",
    );
  }
  for (const operation of ALLOWED_WHEN_PROTECTED) {
    expect(policyDecision({ protected: true }, operation)).toBe("allow");
    expect(() => assertTargetPolicy({ protected: true }, operation)).not.toThrow();
  }
  for (const operation of BLOCKED_WHEN_PROTECTED) {
    expect(policyDecision({ protected: true }, operation)).toBe("block");
    expect(() => assertTargetPolicy({ protected: true }, operation)).toThrow(TargetError);
    expect(policyDecision({ protected: true }, operation, { allowProtected: true })).toBe("allow");
  }
  expect(policyDecision({ protected: true }, "provision", { empty: true })).toBe("allow");
  expect(policyDecision({ protected: true }, "provision", { empty: false })).toBe("block");
  expect(policyDecision({ protected: true }, "provision")).toBe("block");
  expect(policyDecision({ protected: false }, "provision", { empty: false })).toBe("allow");
  expect(() => assertTargetPolicy({ protected: false }, "drop")).toThrow(/OKM1850/);
  expect(() =>
    assertTargetPolicy({ protected: true }, "rollback", { allowProtected: true }),
  ).toThrow(/OKM1850/);
  expect(() => assertTargetPolicy({ protected: true }, "seed")).toThrow(/--allow-protected/);
});

test("aliasing guard refuses an unprotected target on a protected database", () => {
  const shared = target("tenant:a", false);
  const protectedTenant = target("tenant:b", true);
  expect(() => assertNoProtectedAlias([shared, protectedTenant])).toThrow(/OKM1852/);
  expect(() =>
    assertNoProtectedAlias([target("staging", false), target("production", false)]),
  ).not.toThrow();
  expect(() =>
    assertNoProtectedAlias([protectedTenant, { ...shared, database: "other" }]),
  ).not.toThrow();
  expect(() =>
    assertNoProtectedAlias([protectedTenant, { ...shared, port: "5433" }]),
  ).not.toThrow();
});

function target(name: string, protectedTarget: boolean): PhysicalTarget {
  return {
    name,
    protected: protectedTarget,
    host: "127.0.0.1",
    port: "55432",
    database: "okm",
  };
}
