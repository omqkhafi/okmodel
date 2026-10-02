/**
 * Target runner: rollout, contract gating, and the second pass.
 */

import { expect, test } from "bun:test";

import { openPostgres, primaryUrl } from "@okmodel/harness";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { dropDatabasesByPrefix } from "./admin.js";
import type { PlannedStep, TargetPlan } from "./plan.js";
import { createMemoryRegistry, type MemoryRegistry } from "./registry.js";
import { applyRun, controlSharedTarget, defaultConcurrency } from "./runner.js";
import { schemaNameForTenant } from "./sanitize.js";
import { assertTenantCompatible, migrationStatus } from "./status.js";
import { dropControlSchema, ensureControlSchema, readControlRows } from "./state.js";
import { connectionDetailHits } from "./plan.js";
import type { Target } from "./target.js";
import { TargetError } from "./error.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

test("concurrency defaults and contract compatibility", () => {
  expect(defaultConcurrency("schemaPerTenant")).toBe(2);
  expect(defaultConcurrency("databasePerTenant")).toBe(8);

  const plan = planOf([
    step("e", "expand", "select 1"),
    step("c", "contract", "select 1", { class: "contract" }),
  ]);
  const acme = tenantTarget("acme");
  expect(migrationStatus(acme, ["e", "c"], plan).state).toBe("current");
  expect(migrationStatus(acme, ["e"], plan).state).toBe("behind-contract");
  expect(migrationStatus(acme, [], plan).state).toBe("behind-expand");
  expect(migrationStatus(acme, ["e", "c", "future"], plan).state).toBe("ahead");
  expect(migrationStatus(acme, ["e"], plan, { step: "c", error: "boom" }).state).toBe("failed");
  expect(() => assertTenantCompatible(["e"], plan)).toThrow(/OKM1520/);
  expect(() => assertTenantCompatible(["e", "c"], plan)).not.toThrow();
  expect(() => assertTenantCompatible([], planOf([step("e", "expand", "select 1")]))).not.toThrow();
});

postgresTest(decision, "runner applies one catalog to 3 schemas and 3 databases", async () => {
  const admin = openPostgres();
  const suffix = crypto.randomUUID().slice(0, 8);
  try {
    const schemaReport = await runSchema(admin, suffix, ["a", "b", "c"], planOf(happySteps()), {});
    expect(schemaReport.exitCode).toBe(0);
    expect(schemaReport.concurrency).toBe(2);
    for (const id of ["a", "b", "c"]) {
      const columns = await columnsIn(admin, schemaNameForTenant(id), "items");
      expect(columns).toEqual(["id"]);
    }
    expect(await tableExists(admin, `shp_${suffix}`, "meta")).toBe(false);
    const rows = await readControlRows(admin, `ctl_${suffix}`, `run-${suffix}`);
    expect(rows).toHaveLength(4);
    expect(connectionDetailHits(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("postgres://");

    const prefix = `p08b_${suffix}`;
    const databases = await runDatabases(admin, prefix, ["a", "b", "c"], planOf(happySteps()));
    expect(databases.exitCode).toBe(0);
    expect(databases.concurrency).toBe(8);
    for (const id of ["a", "b", "c"]) {
      const name = databases.registry.databaseName(id);
      const tenant = openPostgres(urlFor(name));
      try {
        const found =
          await tenant`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'items' order by ordinal_position`;
        expect(found.map((row) => row.column_name)).toEqual(["id"]);
      } finally {
        await tenant.end({ timeout: 5 });
      }
    }
  } finally {
    await cleanupSchemas(admin, suffix, ["a", "b", "c"]);
    await dropDatabasesByPrefix(admin, `p08b_${suffix}_`);
    await admin.unsafe(`drop schema if exists "shdb_p08b_${suffix}" cascade`);
    await admin.end({ timeout: 5 });
  }
});

postgresTest(
  decision,
  "canary, class, max-failures, contract gating, and the second pass",
  async () => {
    const admin = openPostgres();
    const suffix = crypto.randomUUID().slice(0, 8);
    const controlSchema = `ctl_${suffix}`;
    await ensureControlSchema(admin, controlSchema);
    const registry = schemaRegistry();
    for (const id of ["a", "b", "c"]) registry.addTenant(id);
    const shared = controlSharedTarget(`shp_${suffix}`);
    const source = { database: primaryUrl(), tenants: registry };
    try {
      const canary = await applyRun({
        source,
        shared,
        plan: planOf(happySteps()),
        strategy: "schemaPerTenant",
        control: admin,
        controlSchema,
        runId: `canary-${suffix}`,
        rollout: { canary: 1 },
      });
      expect(
        canary.targets.filter((target) => target.state === "current").map((target) => target.name),
      ).toEqual(["default", "tenant:a"]);
      expect(await tableExists(admin, schemaNameForTenant("a"), "items")).toBe(true);
      expect(await tableExists(admin, schemaNameForTenant("b"), "items")).toBe(false);
      expect(await tableExists(admin, `shp_${suffix}`, "meta")).toBe(false);

      await cleanupTenantSchemas(admin, ["a", "b", "c"]);
      await admin.unsafe(`drop schema if exists ${quote(`shp_${suffix}`)} cascade`);

      const onlyTenants = await applyRun({
        source,
        shared,
        plan: planOf(happySteps()),
        strategy: "schemaPerTenant",
        control: admin,
        controlSchema,
        runId: `class-tenant-${suffix}`,
        rollout: { class: "tenant" },
      });
      expect(onlyTenants.targets.map((target) => target.name)).toEqual([
        "tenant:a",
        "tenant:b",
        "tenant:c",
      ]);
      expect(await tableExists(admin, `shp_${suffix}`, "meta")).toBe(false);
      expect(await columnsIn(admin, schemaNameForTenant("b"), "items")).toEqual(["id"]);

      await cleanupTenantSchemas(admin, ["a", "b", "c"]);
      const onlyShared = await applyRun({
        source,
        shared,
        plan: planOf(happySteps()),
        strategy: "schemaPerTenant",
        control: admin,
        controlSchema,
        runId: `class-shared-${suffix}`,
        rollout: { class: "shared" },
      });
      expect(onlyShared.targets.map((target) => target.name)).toEqual(["default"]);
      expect(await tableExists(admin, `shp_${suffix}`, "meta")).toBe(false);
      expect(await tableExists(admin, schemaNameForTenant("a"), "items")).toBe(false);

      const failing = schemaRegistry();
      for (let index = 0; index < 6; index++) failing.addTenant(`f${index}`);
      const halted = await applyRun({
        source: { database: primaryUrl(), tenants: failing },
        shared: controlSharedTarget(`shf_${suffix}`),
        plan: planOf([step("x", "bad", "select 1/0")]),
        strategy: "schemaPerTenant",
        control: admin,
        controlSchema,
        runId: `halt-${suffix}`,
        rollout: { class: "tenant", concurrency: 1, maxFailures: 3 },
      });
      expect(halted.exitCode).toBe(1);
      expect(halted.targets.filter((target) => target.state === "failed")).toHaveLength(3);
      expect(halted.targets.filter((target) => target.state === "pending")).toHaveLength(3);

      const gated = schemaRegistry();
      gated.addTenant("ok");
      gated.addTenant("keep", { protected: true });
      const gatedRun = await applyRun({
        source: { database: primaryUrl(), tenants: gated },
        shared: controlSharedTarget(`shg_${suffix}`),
        plan: planOf([
          step("s", "expand-shared", `create table "__schema__".meta (id int)`, {
            scope: "shared",
          }),
          step("e", "expand-tenant", `create table "__schema__".items (id int)`),
          step("c", "contract-tenant", `drop table "__schema__".items`, { class: "contract" }),
          step("sc", "contract-shared", `drop table "__schema__".meta`, {
            class: "contract",
            scope: "shared",
          }),
        ]),
        strategy: "schemaPerTenant",
        control: admin,
        controlSchema,
        runId: `gate-${suffix}`,
      });
      expect(gatedRun.targets.find((target) => target.name === "tenant:keep")?.error).toContain(
        "OKM1850",
      );
      expect(gatedRun.targets.find((target) => target.name === "tenant:ok")?.state).toBe("current");
      expect(await tableExists(admin, schemaNameForTenant("ok"), "items")).toBe(false);
      expect(await tableExists(admin, schemaNameForTenant("keep"), "items")).toBe(true);
      expect(await tableExists(admin, `shg_${suffix}`, "meta")).toBe(true);
      expect(gatedRun.targets.find((target) => target.name === "default")?.state).toBe("pending");

      const second = schemaRegistry();
      second.addTenant("early");
      const secondSource = { database: primaryUrl(), tenants: second };
      const started = applyRun({
        source: secondSource,
        shared: controlSharedTarget(`sh2_${suffix}`),
        plan: planOf([step("e", "expand-tenant", `create table "__schema__".items (id int)`)]),
        strategy: "schemaPerTenant",
        control: admin,
        controlSchema,
        runId: `second-${suffix}`,
        rollout: { class: "tenant" },
      });
      second.addTenant("late");
      const secondReport = await started;
      expect(secondReport.secondPass).toEqual(["tenant:late"]);
      expect(await tableExists(admin, schemaNameForTenant("late"), "items")).toBe(true);
      expect(secondReport.targets.find((target) => target.name === "tenant:late")?.state).toBe(
        "current",
      );

      let refused = false;
      try {
        await applyRun({
          source: {
            database: primaryUrl(),
            targets: { production: primaryUrl(), staging: primaryUrl() },
            tenants: schemaRegistry(),
          },
          shared: controlSharedTarget("app"),
          plan: planOf([step("e", "expand", "select 1", { scope: "shared" })]),
          strategy: "schemaPerTenant",
          control: admin,
          controlSchema,
          runId: `named-${suffix}`,
        });
      } catch (error) {
        refused = error instanceof TargetError && error.code === "OKM1853";
      }
      expect(refused).toBe(true);

      let inflight = 0;
      let maxInflight = 0;
      const paced = schemaRegistry();
      for (const id of ["p0", "p1", "p2"]) paced.addTenant(id);
      await applyRun({
        source: { database: primaryUrl(), tenants: paced },
        shared: controlSharedTarget(`shpaced_${suffix}`),
        plan: planOf([step("e", "expand", "select pg_sleep(0.25)")]),
        strategy: "schemaPerTenant",
        control: admin,
        controlSchema,
        runId: `pace-${suffix}`,
        rollout: { class: "tenant" },
        onTargetStart: () => {
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
        },
        onTargetFinish: () => {
          inflight -= 1;
        },
      });
      expect(maxInflight).toBe(2);
    } finally {
      await cleanupTenantSchemas(admin, [
        "a",
        "b",
        "c",
        "ok",
        "keep",
        "early",
        "late",
        "p0",
        "p1",
        "p2",
      ]);
      for (let index = 0; index < 6; index++)
        await dropSchema(admin, schemaNameForTenant(`f${index}`));
      for (const name of [
        `shp_${suffix}`,
        `shf_${suffix}`,
        `shg_${suffix}`,
        `sh2_${suffix}`,
        `shpaced_${suffix}`,
      ]) {
        await dropSchema(admin, name);
      }
      await dropControlSchema(admin, controlSchema);
      await admin.end({ timeout: 5 });
    }
  },
);

function step(
  id: string,
  migrationId: string,
  sql: string,
  options?: {
    readonly class?: PlannedStep["class"];
    readonly scope?: PlannedStep["scope"];
    readonly transactional?: boolean;
  },
): PlannedStep {
  return {
    id,
    migrationId,
    sql,
    class: options?.class ?? "expand",
    transactional: options?.transactional ?? true,
    lock: "AccessExclusiveLock",
    scope: options?.scope ?? "tenant",
  };
}

function happySteps(): readonly PlannedStep[] {
  return [
    step("s", "expand-shared", `create table "__schema__".meta (id int8 primary key)`, {
      scope: "shared",
    }),
    step(
      "t",
      "expand-tenant",
      `create table "__schema__".items (id int8 primary key, name text not null)`,
    ),
    step("i", "expand-tenant", `insert into "__schema__".items (id, name) values (1, 'a')`),
    step("c", "contract-tenant", `alter table "__schema__".items drop column name`, {
      class: "contract",
    }),
    step("sc", "contract-shared", `drop table "__schema__".meta`, {
      class: "contract",
      scope: "shared",
    }),
  ];
}

function planOf(steps: readonly PlannedStep[]): TargetPlan {
  return { id: "plan", targetNames: steps.map((item) => item.scope), steps };
}

function tenantTarget(id: string): Target {
  return {
    name: `tenant:${id}`,
    class: "tenant",
    protected: false,
    namespace: "tenant_{id}",
    strategy: "schemaPerTenant",
    tenantId: id,
  };
}

function schemaRegistry(): MemoryRegistry {
  return createMemoryRegistry({
    strategy: "schemaPerTenant",
    origin: primaryUrl(),
    appPassword: "okm",
    migrationPassword: "okm",
    database: "okm",
    prefix: "unused",
  });
}

async function runSchema(
  admin: Sql,
  suffix: string,
  ids: readonly string[],
  plan: TargetPlan,
  rollout: { readonly canary?: number },
) {
  const controlSchema = `ctl_${suffix}`;
  await ensureControlSchema(admin, controlSchema);
  const registry = schemaRegistry();
  for (const id of ids) registry.addTenant(id);
  return applyRun({
    source: { database: primaryUrl(), tenants: registry },
    shared: controlSharedTarget(`shp_${suffix}`),
    plan,
    strategy: "schemaPerTenant",
    control: admin,
    controlSchema,
    runId: `run-${suffix}`,
    rollout,
  });
}

async function runDatabases(admin: Sql, prefix: string, ids: readonly string[], plan: TargetPlan) {
  const registry = createMemoryRegistry({
    strategy: "databasePerTenant",
    origin: primaryUrl(),
    appPassword: "okm",
    migrationPassword: "okm",
    database: "okm",
    prefix,
    admin,
  });
  for (const id of ids) {
    registry.addTenant(id);
    await registry.create?.(id);
  }
  const controlSchema = `ctl_${prefix}`;
  await ensureControlSchema(admin, controlSchema);
  const report = await applyRun({
    source: { database: primaryUrl(), tenants: registry },
    shared: controlSharedTarget(`shdb_${prefix}`),
    plan,
    strategy: "databasePerTenant",
    control: admin,
    controlSchema,
    runId: `db-${prefix}`,
  });
  await dropControlSchema(admin, controlSchema);
  await admin.unsafe(`drop schema if exists "shdb_${prefix}" cascade`);
  return { ...report, registry };
}

function urlFor(database: string): string {
  const url = new URL(primaryUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function columnsIn(sql: Sql, schema: string, table: string): Promise<readonly string[]> {
  const rows = await sql.unsafe(
    `select column_name from information_schema.columns
     where table_schema = $1 and table_name = $2
     order by ordinal_position`,
    [schema, table],
  );
  return rows.map((row) => String(row.column_name));
}

async function tableExists(sql: Sql, schema: string, table: string): Promise<boolean> {
  const rows = await sql.unsafe(
    `select 1 from information_schema.tables where table_schema = $1 and table_name = $2`,
    [schema, table],
  );
  return rows.length > 0;
}

async function cleanupSchemas(sql: Sql, suffix: string, ids: readonly string[]): Promise<void> {
  await cleanupTenantSchemas(sql, ids);
  await dropSchema(sql, `shp_${suffix}`);
  await dropControlSchema(sql, `ctl_${suffix}`);
}

async function cleanupTenantSchemas(sql: Sql, ids: readonly string[]): Promise<void> {
  for (const id of ids) await dropSchema(sql, schemaNameForTenant(id));
}

async function dropSchema(sql: Sql, schema: string): Promise<void> {
  await sql.unsafe(`drop schema if exists ${quote(schema)} cascade`);
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
