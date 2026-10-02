/**
 * Runner throughput at 3, 20, and 200 schema targets.
 *
 * Database-per-tenant is measured at 3 and 20. Creating 200 databases is a
 * provisioning cost, measured with the pool cap, not repeated here.
 */

import { expect } from "bun:test";

import { openPostgres, primaryUrl } from "@okmodel/harness";

import { quoteIdent } from "../catalog/sql.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { dropDatabasesByPrefix } from "./admin.js";
import type { PlannedStep, TargetPlan } from "./plan.js";
import { createMemoryRegistry } from "./registry.js";
import { applyRun, controlSharedTarget } from "./runner.js";
import { schemaNameForTenant } from "./sanitize.js";
import { dropControlSchema, ensureControlSchema } from "./state.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

postgresTest(
  decision,
  "runner throughput at 3, 20, and 200 targets",
  async () => {
    const admin = openPostgres();
    const suffix = crypto.randomUUID().slice(0, 8);
    const controlSchema = `ctl_m_${suffix}`;
    await ensureControlSchema(admin, controlSchema);
    const lines: string[] = [];
    try {
      for (const count of [3, 20, 200]) {
        for (const concurrency of [1, 2, 8]) {
          const ms = await timeSchemas(admin, controlSchema, suffix, count, concurrency);
          const rate = (count / ms) * 1000;
          lines.push(
            `MEASURE runner.schema count=${count} concurrency=${concurrency} ms=${ms.toFixed(1)} perSecond=${rate.toFixed(2)}`,
          );
        }
      }
      for (const count of [3, 20]) {
        const ms = await timeDatabases(admin, suffix, count, 8);
        lines.push(
          `MEASURE runner.database count=${count} concurrency=8 ms=${ms.toFixed(1)} perSecond=${((count / ms) * 1000).toFixed(2)}`,
        );
      }
      for (const line of lines) console.log(line);
      expect(lines.length).toBe(11);
    } finally {
      for (const count of [3, 20, 200]) {
        for (const concurrency of [1, 2, 8]) {
          for (let index = 0; index < count; index++) {
            await admin.unsafe(
              `drop schema if exists ${quoteIdent(schemaNameForTenant(tenantId(suffix, count, concurrency, index)))} cascade`,
            );
          }
        }
      }
      await dropDatabasesByPrefix(admin, `p08b_m${suffix}`);
      await dropControlSchema(admin, controlSchema);
      await admin.end({ timeout: 5 });
    }
  },
  180_000,
);

function tenantId(suffix: string, count: number, concurrency: number, index: number): string {
  return `m${suffix}c${concurrency}n${count}x${index}`;
}

async function timeSchemas(
  admin: ReturnType<typeof openPostgres>,
  controlSchema: string,
  suffix: string,
  count: number,
  concurrency: number,
): Promise<number> {
  const registry = createMemoryRegistry({
    strategy: "schemaPerTenant",
    origin: primaryUrl(),
    appPassword: "okm",
    migrationPassword: "okm",
    database: "okm",
    prefix: "unused",
  });
  for (let index = 0; index < count; index++)
    registry.addTenant(tenantId(suffix, count, concurrency, index));
  const started = performance.now();
  const report = await applyRun({
    source: { database: primaryUrl(), tenants: registry },
    shared: controlSharedTarget("public"),
    plan: createPlan(),
    strategy: "schemaPerTenant",
    control: admin,
    controlSchema,
    runId: `m-${suffix}-${count}-${concurrency}`,
    rollout: { class: "tenant", concurrency },
  });
  expect(report.exitCode).toBe(0);
  expect(report.targets.filter((target) => target.state === "current")).toHaveLength(count);
  return performance.now() - started;
}

async function timeDatabases(
  admin: ReturnType<typeof openPostgres>,
  suffix: string,
  count: number,
  concurrency: number,
): Promise<number> {
  const prefix = `p08b_m${suffix}${count}`;
  const registry = createMemoryRegistry({
    strategy: "databasePerTenant",
    origin: primaryUrl(),
    appPassword: "okm",
    migrationPassword: "okm",
    database: "okm",
    prefix,
    admin,
  });
  for (let index = 0; index < count; index++) {
    const id = `d${index}`;
    registry.addTenant(id);
    await registry.create?.(id);
  }
  const started = performance.now();
  const report = await applyRun({
    source: { database: primaryUrl(), tenants: registry },
    shared: controlSharedTarget("public"),
    plan: createPlan(),
    strategy: "databasePerTenant",
    control: admin,
    controlSchema: `ctl_m_${suffix}`,
    runId: `db-${suffix}-${count}`,
    rollout: { class: "tenant", concurrency },
  });
  expect(report.exitCode).toBe(0);
  return performance.now() - started;
}

function createPlan(): TargetPlan {
  const step: PlannedStep = {
    id: "a",
    migrationId: "m1",
    sql: `create table "__schema__".items (id int primary key)`,
    class: "expand",
    transactional: true,
    lock: "AccessExclusiveLock",
    scope: "tenant",
  };
  return { id: "plan", targetNames: [], steps: [step] };
}
