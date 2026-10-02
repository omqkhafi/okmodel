/**
 * Child process for the kill-and-resume test.
 *
 * The parent starts this process, waits until the first migration is
 * checkpointed, and sends SIGKILL. The parent then resumes the same plan.
 */

import { openPostgres, primaryUrl } from "@okmodel/harness";

import { applyRun, controlSharedTarget } from "./runner.js";
import { createMemoryRegistry } from "./registry.js";
import { ensureControlSchema } from "./state.js";
import type { PlannedStep, TargetPlan } from "./plan.js";

const suffix = process.argv[2] ?? "";
if (!/^[a-z0-9]+$/.test(suffix)) throw new Error("kill child requires a lowercase suffix");

const admin = openPostgres();
const controlSchema = `ctl_${suffix}`;
await ensureControlSchema(admin, controlSchema);
const registry = createMemoryRegistry({
  strategy: "schemaPerTenant",
  origin: primaryUrl(),
  appPassword: "okm",
  migrationPassword: "okm",
  database: "okm",
  prefix: "unused",
});
registry.addTenant("kill");

const steps: readonly PlannedStep[] = [
  {
    id: "a",
    migrationId: "m1",
    sql: `create table "__schema__".items (id int primary key)`,
    class: "expand",
    transactional: true,
    lock: "AccessExclusiveLock",
    scope: "tenant",
  },
  {
    id: "b",
    migrationId: "m1",
    sql: `insert into "__schema__".items values (1)`,
    class: "expand",
    transactional: true,
    lock: "AccessExclusiveLock",
    scope: "tenant",
  },
  {
    id: "c",
    migrationId: "m2",
    sql: `select pg_sleep(case when exists (select 1 from public.okm_p08b_gate where id = '${suffix}') then 30 else 0 end)`,
    class: "expand",
    transactional: true,
    lock: "none",
    scope: "tenant",
  },
];
const plan: TargetPlan = { id: "plan", targetNames: ["tenant:kill"], steps };

const report = await applyRun({
  source: { database: primaryUrl(), tenants: registry },
  shared: controlSharedTarget("public"),
  plan,
  strategy: "schemaPerTenant",
  control: admin,
  controlSchema,
  runId: `kill-${suffix}`,
  rollout: { class: "tenant" },
  applicationName: `okm-p08b-kill-${suffix}`,
});
if (report.exitCode !== 0) {
  console.log(
    JSON.stringify({ exitCode: report.exitCode, error: report.targets[0]?.error ?? null }),
  );
}
await admin.end({ timeout: 5 });
process.exit(report.exitCode);
