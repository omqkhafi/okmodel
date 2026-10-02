/**
 * Pool cap, idle eviction, and credential rotation over many tenants.
 */

import { expect } from "bun:test";

import { openPostgres, primaryUrl } from "@okmodel/harness";

import { quoteIdent } from "../catalog/sql.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { templateNamespace } from "../catalog/object.js";
import { planMigration } from "../migrations/plan.js";
import { countApplicationBackends, dropDatabasesByPrefix } from "./admin.js";
import { itemsCatalog } from "./fixture.js";
import { connectionDetailHits, initialRunState, targetPlanFromMigration } from "./plan.js";
import { openTargetPools } from "./pool.js";
import { createMemoryRegistry } from "./registry.js";
import type { Target } from "./target.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const TENANTS = 200;
const CAP = 8;

postgresTest(
  decision,
  "200 tenants stay under the pool cap and idle pools close",
  async () => {
    const admin = openPostgres();
    const prefix = `p08b_${crypto.randomUUID().slice(0, 8)}`;
    const applicationName = `okm-p08b-${prefix}`;
    const registry = createMemoryRegistry({
      strategy: "databasePerTenant",
      origin: primaryUrl(),
      appPassword: "okm",
      migrationPassword: "okm",
      database: "okm",
      prefix,
      admin,
    });
    const targets: Target[] = [];
    for (let index = 0; index < TENANTS; index++) {
      const id = `t${index.toString().padStart(3, "0")}`;
      targets.push(registry.addTenant(id));
      await registry.create?.(id);
    }

    let clock = 1_000;
    const pools = openTargetPools({
      source: { database: primaryUrl(), tenants: registry },
      maxOpenTargets: CAP,
      idleTimeout: 500,
      applicationName,
      now: () => clock,
    });
    const before = process.memoryUsage();
    let maxOpen = 0;
    let maxBackends = 0;
    try {
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        if (target === undefined) continue;
        await pools.query(target, "migration", "select 1");
        maxOpen = Math.max(maxOpen, pools.stats().openPools);
        if (index % 20 === 0 || index === targets.length - 1) {
          maxBackends = Math.max(
            maxBackends,
            await countApplicationBackends(admin, applicationName),
          );
        }
      }
      const afterTouch = process.memoryUsage();
      expect(pools.stats().openPools).toBeLessThanOrEqual(CAP);
      expect(maxOpen).toBeLessThanOrEqual(CAP);
      expect(maxOpen).toBe(CAP);
      expect(pools.stats().evictions).toBeGreaterThanOrEqual(TENANTS - CAP);
      expect(maxBackends).toBeLessThanOrEqual(CAP);

      const heldTarget = targets[targets.length - 1];
      if (heldTarget === undefined) throw new Error("missing tenant");
      const held = await pools.reserve(heldTarget, "migration");
      for (let index = 0; index < CAP + 2; index++) {
        const target = targets[index];
        if (target === undefined) continue;
        await pools.query(target, "migration", "select 1");
      }
      expect(pools.stats().reserved).toBe(1);
      const still = await held.execute("select 1");
      expect(still.rows[0]?.[0]).toBe("1");
      held.release();

      clock += 10_000;
      const closed = await pools.sweep();
      expect(closed).toBeGreaterThan(0);
      expect(pools.stats().openPools).toBe(0);
      const afterSweep = await countApplicationBackends(admin, applicationName);
      expect(afterSweep).toBe(0);

      const heap = afterTouch.heapUsed - before.heapUsed;
      console.log(
        `MEASURE pool.tenants=${TENANTS} cap=${CAP} maxOpen=${maxOpen} maxBackends=${maxBackends} evictions=${pools.stats().evictions} heapDeltaBytes=${heap} rssDeltaBytes=${afterTouch.rss - before.rss} idleClosed=${closed}`,
      );
    } finally {
      await pools.close();
      await dropDatabasesByPrefix(admin, `${prefix}_`);
      await admin.end({ timeout: 5 });
    }
  },
  180_000,
);

postgresTest(
  decision,
  "credential rotation replaces the pool once and leaves the plan untouched",
  async () => {
    const admin = openPostgres();
    const role = `p08b_rot_${crypto.randomUUID().slice(0, 8)}`;
    const applicationName = `okm-p08b-${role}`;
    const origin = primaryUrl().replace("okm:okm@", `${role}:alpha@`);
    const registry = createMemoryRegistry({
      strategy: "schemaPerTenant",
      origin,
      appPassword: "alpha",
      migrationPassword: "alpha",
      database: "okm",
      prefix: "unused",
    });
    const target = registry.addTenant("acme");
    const namespace = templateNamespace("tenant_{id}");
    const plan = targetPlanFromMigration(
      "m1",
      [target.name],
      planMigration([], itemsCatalog(namespace), [{ logical: namespace, concrete: "tenant_acme" }]),
    );
    const state = initialRunState("run-rot", plan);
    const planBefore = JSON.stringify(plan);
    const stateBefore = JSON.stringify(state);

    const pools = openTargetPools({
      source: { database: primaryUrl(), tenants: registry },
      maxOpenTargets: 2,
      idleTimeout: 60_000,
      applicationName,
    });
    try {
      await admin.unsafe(`create role ${quoteIdent(role)} login password 'alpha'`);
      await admin.unsafe(`grant connect on database okm to ${quoteIdent(role)}`);
      await pools.query(target, "migration", "select 1");

      await admin.unsafe(`alter role ${quoteIdent(role)} password 'beta'`);
      registry.rotate("acme", "migration", "beta");
      expect(JSON.stringify(plan)).toBe(planBefore);
      expect(JSON.stringify(state)).toBe(stateBefore);
      expect(connectionDetailHits(plan)).toEqual([]);
      expect(connectionDetailHits(state)).toEqual([]);

      await pools.releaseIdle(target);
      await pools.query(target, "migration", "select 1");
      expect(pools.stats().authRetries).toBe(1);

      await admin.unsafe(`alter role ${quoteIdent(role)} password 'nope'`);
      registry.rotate("acme", "migration", "gamma");
      await pools.releaseIdle(target);
      let rejected = false;
      try {
        await pools.query(target, "migration", "select 1");
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(pools.stats().authRetries).toBe(2);
      expect(JSON.stringify(plan)).toBe(planBefore);
    } finally {
      await pools.close();
      await admin
        .unsafe(
          "select pg_terminate_backend(pid) from pg_stat_activity where usename = $1 and pid <> pg_backend_pid()",
          [role],
        )
        .catch(() => undefined);
      await admin
        .unsafe(`revoke all privileges on database okm from ${quoteIdent(role)}`)
        .catch(() => undefined);
      await admin.unsafe(`drop role if exists ${quoteIdent(role)}`).catch(() => undefined);
      await admin.end({ timeout: 5 });
    }
  },
);
