/**
 * Invariant H: plans and run state hold target names, not connection details.
 */

import { expect, test } from "bun:test";

import { templateNamespace } from "../catalog/object.js";
import { planMigration } from "../migrations/plan.js";
import { itemsCatalog } from "./fixture.js";
import {
  connectionDetailHits,
  initialRunState,
  targetPlanFromMigration,
  type TargetPlan,
  type TargetRunState,
} from "./plan.js";
import { createMemoryRegistry } from "./registry.js";
import { connectionUrl } from "./resolver.js";
import type { Target } from "./target.js";

type ConnectionField = "url" | "password" | "host" | "port" | "user" | "username";
type NoConnection<T> = Extract<keyof T, ConnectionField> extends never ? true : never;

const targetHasNoConnection: NoConnection<Target> = true;
const planHasNoConnection: NoConnection<TargetPlan> = true;
const stateHasNoConnection: NoConnection<TargetRunState> = true;

test("plan.no-connection", () => {
  expect(targetHasNoConnection && planHasNoConnection && stateHasNoConnection).toBe(true);

  const namespace = templateNamespace("tenant_{id}");
  const migration = planMigration([], itemsCatalog(namespace), [
    { logical: namespace, concrete: "tenant_acme" },
  ]);
  const plan = targetPlanFromMigration("m1", ["default", "tenant:acme"], migration);
  const state = initialRunState("run-1", plan);

  expect(plan.targetNames).toEqual(["default", "tenant:acme"]);
  expect(plan.steps.length).toBeGreaterThan(0);
  expect(connectionDetailHits(plan)).toEqual([]);
  expect(connectionDetailHits(state)).toEqual([]);
  expect(JSON.stringify(plan)).not.toContain("postgres://");
  expect(JSON.stringify(state)).not.toContain("127.0.0.1");

  const registry = createMemoryRegistry({
    strategy: "schemaPerTenant",
    origin: "postgres://okm:alpha@127.0.0.1:55432/okm",
    appPassword: "alpha",
    migrationPassword: "alpha",
    database: "okm",
    prefix: "p08b_plan",
  });
  registry.addTenant("acme");
  const before = JSON.stringify(plan);
  const beforeState = JSON.stringify(state);
  registry.rotate("acme", "migration", "beta");
  expect(JSON.stringify(plan)).toBe(before);
  expect(JSON.stringify(state)).toBe(beforeState);
  expect(connectionUrl(registry.resolve("acme", { role: "migration" }))).toContain("beta");

  expect(
    connectionDetailHits({ nested: { url: "postgres://okm:okm@127.0.0.1:55432/okm" } }),
  ).toEqual(["$.nested.url", "$.nested.url"]);
});
