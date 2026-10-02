/**
 * Failure, resume, and the per-target advisory lock.
 */

import { expect } from "bun:test";

import { openPostgres, primaryUrl } from "@okmodel/harness";

import { quoteIdent } from "../catalog/sql.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { openPostgresJs } from "../drivers/postgresjs.js";
import { applyToTarget } from "./apply.js";
import { TargetError } from "./error.js";
import { advisoryLockKey } from "./lock.js";
import type { PlannedStep, TargetPlan } from "./plan.js";
import { createMemoryRegistry } from "./registry.js";
import { applyRun, controlSharedTarget } from "./runner.js";
import { schemaNameForTenant } from "./sanitize.js";
import { dropControlSchema, ensureControlSchema, readControlRows } from "./state.js";
import { connectionDetailHits } from "./plan.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

postgresTest(
  decision,
  "a failed transactional step rolls back and resume repeats nothing finished",
  async () => {
    const admin = openPostgres();
    const suffix = crypto.randomUUID().slice(0, 8);
    const schema = schemaNameForTenant("roll");
    const controlSchema = `ctl_${suffix}`;
    await ensureControlSchema(admin, controlSchema);
    await admin.unsafe(`create schema ${quoteIdent(schema)}`);
    await admin.unsafe(`create table ${quoteIdent(schema)}.extra (id int)`);
    const registry = registryFor();
    registry.addTenant("roll");
    const plan = planOf([
      step("a", "m1", `create table "__schema__".items (id int primary key)`),
      step("b", "m1", `insert into "__schema__".items values (1)`),
      step("c", "m2", `insert into "__schema__".items values (2)`),
      step("d", "m2", `create table "__schema__".extra (id int)`),
    ]);
    try {
      const failed = await run(admin, controlSchema, `fail-${suffix}`, registry, plan);
      expect(failed.exitCode).toBe(1);
      expect(await ids(admin, schema)).toEqual([1]);
      await admin.unsafe(`drop table ${quoteIdent(schema)}.extra`);
      const resumed = await run(admin, controlSchema, `resume-${suffix}`, registry, plan);
      expect(resumed.exitCode).toBe(0);
      expect(await ids(admin, schema)).toEqual([1, 2]);
      const meta = await admin.unsafe(`select id from ${quoteIdent(schema)}.okm_meta order by id`);
      expect(meta.map((row) => String(row.id))).toEqual(["a", "b", "c", "d"]);
    } finally {
      await admin.unsafe(`drop schema if exists ${quoteIdent(schema)} cascade`);
      await dropControlSchema(admin, controlSchema);
      await admin.end({ timeout: 5 });
    }
  },
);

postgresTest(decision, "a failed concurrent index is invalid and resume rebuilds it", async () => {
  const admin = openPostgres();
  const suffix = crypto.randomUUID().slice(0, 8);
  const schema = schemaNameForTenant("idx");
  const controlSchema = `ctl_${suffix}`;
  await ensureControlSchema(admin, controlSchema);
  const registry = registryFor();
  registry.addTenant("idx");
  const plan = planOf([
    step("a", "m1", `create table "__schema__".items (id int primary key, name text)`),
    step("b", "m1", `insert into "__schema__".items values (1, 'a')`),
    step("c", "m1", `insert into "__schema__".items values (2, 'a')`),
    step(
      "d",
      "m2",
      `create unique index concurrently items_name_idx on "__schema__".items (name)`,
      {
        transactional: false,
        indexName: "items_name_idx",
      },
    ),
  ]);
  try {
    const failed = await run(admin, controlSchema, `idx-fail-${suffix}`, registry, plan);
    expect(failed.exitCode).toBe(1);
    expect(await indexValid(admin, schema, "items_name_idx")).toBe(false);
    await admin.unsafe(`delete from ${quoteIdent(schema)}.items where id = 2`);
    const resumed = await run(admin, controlSchema, `idx-resume-${suffix}`, registry, plan);
    expect(resumed.exitCode).toBe(0);
    expect(await indexValid(admin, schema, "items_name_idx")).toBe(true);
    expect(await ids(admin, schema)).toEqual([1]);
  } finally {
    await admin.unsafe(`drop schema if exists ${quoteIdent(schema)} cascade`);
    await dropControlSchema(admin, controlSchema);
    await admin.end({ timeout: 5 });
  }
});

postgresTest(
  decision,
  "resume after a kill continues from the control-database checkpoint",
  async () => {
    const admin = openPostgres();
    const suffix = crypto.randomUUID().slice(0, 8);
    const schema = schemaNameForTenant("kill");
    const controlSchema = `ctl_${suffix}`;
    const runId = `kill-${suffix}`;
    const applicationName = `okm-p08b-kill-${suffix}`;
    await ensureControlSchema(admin, controlSchema);
    await admin.unsafe("create table if not exists public.okm_p08b_gate (id text primary key)");
    await admin.unsafe("insert into public.okm_p08b_gate (id) values ($1) on conflict do nothing", [
      suffix,
    ]);
    const childPath = new URL("./kill-child.ts", import.meta.url).pathname;
    const child = Bun.spawn(["bun", childPath, suffix], { stdout: "pipe", stderr: "pipe" });
    try {
      const checkpoint = await waitForCheckpoint(admin, controlSchema, runId);
      expect(checkpoint).toBe("b");
      const sleeping = await waitForBackend(admin, applicationName, "okm_p08b_gate");
      expect(sleeping).toBeGreaterThan(0);
      child.kill("SIGKILL");
      await child.exited;
      await admin.unsafe("delete from public.okm_p08b_gate where id = $1", [suffix]);
      await waitUntilQuiet(admin, applicationName);
      const stored = await readControlRows(admin, controlSchema, runId);
      expect(stored.find((row) => row.name === "tenant:kill")?.checkpoint).toBe("b");
      expect(connectionDetailHits(stored)).toEqual([]);
      const registry = registryFor();
      registry.addTenant("kill");
      const started = performance.now();
      const resumed = await run(
        admin,
        controlSchema,
        `kill-resume-${suffix}`,
        registry,
        killPlan(suffix),
      );
      const resumeMs = performance.now() - started;
      expect(resumed.exitCode).toBe(0);
      expect(await ids(admin, schema)).toEqual([1]);
      console.log(`MEASURE resume.ms=${resumeMs.toFixed(1)} killedPid=${sleeping}`);
    } finally {
      child.kill("SIGKILL");
      await admin
        .unsafe("delete from public.okm_p08b_gate where id = $1", [suffix])
        .catch(() => undefined);
      await admin.unsafe(`drop schema if exists ${quoteIdent(schema)} cascade`);
      await dropControlSchema(admin, controlSchema);
      await admin.end({ timeout: 5 });
    }
  },
  60_000,
);

postgresTest(decision, "a second runner on one target is refused at once", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const schema = schemaNameForTenant("lock");
  const holder = openPostgresJs(primaryUrl(), {
    max: 1,
    applicationName: `lock-hold-${suffix}`,
    idleTimeout: 5,
  });
  const held = await holder.reserve?.();
  if (held === undefined) throw new Error("pool cannot reserve");
  const key = advisoryLockKey("tenant:lock");
  try {
    await held.execute("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
    const started = performance.now();
    let code = "";
    try {
      await applyToTarget({
        targetName: "tenant:lock",
        url: primaryUrl(),
        schema,
        steps: [step("a", "m1", "select 1")],
        protected: false,
        applicationName: `lock-run-${suffix}`,
        catalogHash: "spike",
      });
    } catch (error) {
      if (error instanceof TargetError) code = error.code;
    }
    expect(code).toBe("OKM1522");
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally {
    await held
      .execute("select pg_advisory_unlock(hashtextextended($1, 0))", [key])
      .catch(() => undefined);
    held.release();
    await holder.close();
  }
});

function step(
  id: string,
  migrationId: string,
  sql: string,
  options?: { readonly transactional?: boolean; readonly indexName?: string },
): PlannedStep {
  return {
    id,
    migrationId,
    sql,
    class: "expand",
    transactional: options?.transactional ?? true,
    lock: options?.transactional === false ? "ShareLock" : "AccessExclusiveLock",
    scope: "tenant",
    ...(options?.indexName === undefined ? {} : { indexName: options.indexName }),
  };
}

function planOf(steps: readonly PlannedStep[]): TargetPlan {
  return { id: "plan", targetNames: ["tenant:one"], steps };
}

function registryFor() {
  return createMemoryRegistry({
    strategy: "schemaPerTenant",
    origin: primaryUrl(),
    appPassword: "okm",
    migrationPassword: "okm",
    database: "okm",
    prefix: "unused",
  });
}

async function run(
  admin: ReturnType<typeof openPostgres>,
  controlSchema: string,
  runId: string,
  registry: ReturnType<typeof registryFor>,
  plan: TargetPlan,
  applicationName?: string,
) {
  return applyRun({
    source: { database: primaryUrl(), tenants: registry },
    shared: controlSharedTarget("public"),
    plan,
    strategy: "schemaPerTenant",
    control: admin,
    controlSchema,
    runId,
    rollout: { class: "tenant" },
    ...(applicationName === undefined ? {} : { applicationName }),
  });
}

async function ids(
  admin: ReturnType<typeof openPostgres>,
  schema: string,
): Promise<readonly number[]> {
  const rows = await admin.unsafe(`select id from ${quoteIdent(schema)}.items order by id`);
  return rows.map((row) => Number(row.id));
}

async function indexValid(
  admin: ReturnType<typeof openPostgres>,
  schema: string,
  name: string,
): Promise<boolean | null> {
  const rows = await admin.unsafe(
    `select i.indisvalid as valid
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2`,
    [schema, name],
  );
  const valid = rows[0]?.valid;
  if (valid === true || valid === "t" || valid === "true") return true;
  if (valid === false || valid === "f" || valid === "false") return false;
  return null;
}

async function waitForBackend(
  admin: ReturnType<typeof openPostgres>,
  applicationName: string,
  marker: string,
): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await admin.unsafe(
      `select pid from pg_stat_activity
       where application_name = $1 and query like $2 and pid <> pg_backend_pid()`,
      [applicationName, `%${marker}%`],
    );
    const pid = rows[0]?.pid;
    if (typeof pid === "number") return pid;
    if (typeof pid === "string") return Number(pid);
    await Bun.sleep(50);
  }
  return 0;
}

function killPlan(suffix: string): TargetPlan {
  return planOf([
    step("a", "m1", `create table "__schema__".items (id int primary key)`),
    step("b", "m1", `insert into "__schema__".items values (1)`),
    step(
      "c",
      "m2",
      `select pg_sleep(case when exists (select 1 from public.okm_p08b_gate where id = '${suffix}') then 30 else 0 end)`,
    ),
  ]);
}

async function waitForCheckpoint(
  admin: ReturnType<typeof openPostgres>,
  controlSchema: string,
  runId: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const rows = await readControlRows(admin, controlSchema, runId);
    const checkpoint = rows.find((row) => row.name === "tenant:kill")?.checkpoint ?? null;
    if (checkpoint === "b") return checkpoint;
    await Bun.sleep(50);
  }
  return null;
}

async function waitUntilQuiet(
  admin: ReturnType<typeof openPostgres>,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await admin.unsafe(
      "select pid from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()",
      [applicationName],
    );
    if (rows.length === 0) return;
    await Bun.sleep(50);
  }
  await admin.unsafe(
    "select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()",
    [applicationName],
  );
}
