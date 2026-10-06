/**
 * `isolation.property` (spec 5.3, P30): random compositions of the 0.2 features
 * never read or write a row of another tenant, and never reach a tenant table
 * without the tenant predicate. Real Postgres, the gate schema, two tenants with
 * the same ids and names.
 *
 * Four oracles, none of them the code under test:
 *
 * 1. The wire. Every statement the driver received binds each tenant table to the
 *    scoped tenant (`tenantProblems`), and carries no other tenant's key.
 * 2. The database. A trigger raises a notice for every row written, with the row's
 *    tenant; a notice survives a rollback, so rolled-back writes are audited too.
 *    A raw connection snapshots the other tenant before and after each step.
 * 3. The result. Every `tenantId` in every returned row, at any depth, is the scope.
 * 4. Independence. Run one tenant's steps alone on an empty database: each outcome
 *    and the final rows must equal what that tenant saw while the other tenant was
 *    active. A leak in either direction breaks the equality.
 *
 * Every run uses the fixed seed in `gate-property.ts`; a failure prints it.
 */

import { afterAll, expect, test } from "bun:test";
import fc from "fast-check";

import type { Statement } from "../src/contracts/driver.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { testing } from "../src/tooling/testing/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { SQL_NAME, withGate, type GateEnv } from "./gate-env.js";
import {
  Canon,
  Rollback,
  runLeaf,
  settle,
  startWrite,
  steps,
  seed,
  tenantsIn,
  type Client,
  type Op,
  type Settled,
  type Step,
  type TxOp,
  type WriteOp,
} from "./gate-ops.js";
import { assertGate, GATE_SEED } from "./gate-property.js";
import { tenantProblems } from "./gate-recorder.js";
import { gateApp, key, TENANT_TABLES, TENANTS } from "./gate-schema.js";

const gate = await loadPostgresGate();

const TABLES = Object.values(SQL_NAME);
const KIND = { orgs: "o", projects: "p", tasks: "t", labels: "l", projectLabels: "j" } as const;

/** What a test wants to know after the run. */
type Stats = {
  steps: number;
  attempts: number;
  txs: number;
  rolledBack: number;
  savepoints: number;
  savepointFailures: number;
  batches: number;
  reads: number;
  writes: number;
  errors: number;
};

function emptyStats(): Stats {
  return {
    steps: 0,
    attempts: 0,
    txs: 0,
    rolledBack: 0,
    savepoints: 0,
    savepointFailures: 0,
    batches: 0,
    reads: 0,
    writes: 0,
    errors: 0,
  };
}

/** Totals over every run of every property in this file, for the report. */
export const totals = emptyStats();

async function runTx(client: Client, op: TxOp, stats: Stats): Promise<unknown> {
  stats.txs += 1;
  try {
    return await (
      client as unknown as {
        tx(options: object, fn: (t: Client) => Promise<unknown>): Promise<unknown>;
      }
    ).tx({ isolation: op.isolation, retry: op.retry }, async (t) => {
      stats.attempts += 1;
      const first: unknown[] = [];
      for (const leaf of op.ops) first.push(await runLeaf(t, leaf));
      let inner: unknown = null;
      if (op.inner !== null) {
        const plan = op.inner;
        stats.savepoints += 1;
        inner = await (
          t as unknown as { tx(fn: (n: Client) => Promise<unknown>): Promise<unknown> }
        )
          .tx(async (nested) => {
            const out: unknown[] = [];
            for (const leaf of plan.ops) out.push(await runLeaf(nested, leaf));
            if (plan.fail) throw new Rollback();
            return out;
          })
          .catch((error: unknown): unknown => {
            stats.savepointFailures += 1;
            if (error instanceof Rollback) return "savepoint rolled back";
            return settle(() => Promise.reject(error));
          });
      }
      const rest: unknown[] = [];
      for (const leaf of op.after) rest.push(await runLeaf(t, leaf));
      if (op.fail) throw new Rollback();
      return { first, inner, rest };
    });
  } catch (error) {
    if (error instanceof Rollback) {
      stats.rolledBack += 1;
      return "rolled back";
    }
    throw error;
  }
}

/** Runs one operation as one tenant and returns its settled result. */
async function runTop(client: Client, op: Op, stats: Stats): Promise<Settled> {
  stats.steps += 1;
  const settled = await (async () => {
    switch (op.t) {
      case "tx":
        return settle(() => runTx(client, op, stats));
      case "batch":
        stats.batches += 1;
        return settle(() =>
          (client as unknown as { batch(ops: unknown[]): PromiseLike<unknown> }).batch(
            op.ops.map((write) => startWrite(client, write)),
          ),
        );
      case "insert":
      case "update":
      case "delete":
      case "archive":
      case "restore":
      case "restoreGroup":
        stats.writes += 1;
        return settle(() => runLeaf(client, op));
      default:
        stats.reads += 1;
        return settle(() => runLeaf(client, op));
    }
  })();
  if ("error" in settled) stats.errors += 1;
  return settled;
}

/** Would an insert succeed? Decided from the tenant's own rows, read raw. */
async function insertShouldSucceed(
  env: GateEnv,
  tenant: string,
  op: Extract<WriteOp, { t: "insert" }>,
): Promise<boolean> {
  const rows = await env.rows(op.table, tenant);
  const id = key(KIND[op.table], op.n);
  if (rows.some((row) => row.id === id)) return false;
  const unique = { orgs: "name", projects: "name", tasks: "title" } as const;
  const field = unique[op.table as keyof typeof unique];
  if (field !== undefined) {
    const value = `n${String(op.label)}`;
    if (rows.some((row) => row.archivedAt === null && row[field] === value)) return false;
  }
  const has = async (table: "orgs" | "projects" | "labels", n: number): Promise<boolean> =>
    (await env.rows(table, tenant)).some((row) => row.id === key(KIND[table], n));
  if (op.table === "projects") return has("orgs", op.parent);
  if (op.table === "tasks") return has("projects", op.parent);
  if (op.table === "projectLabels") {
    return (await has("projects", op.parent)) && (await has("labels", op.other));
  }
  return true;
}

/** The state of the pooled connection after a step: nothing left open, nothing left set. */
async function connectionIsClean(env: GateEnv): Promise<void> {
  const result = await env.rec.pool.execute(
    "select pg_current_xact_id_if_assigned() is null, current_setting('transaction_isolation'), current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('idle_in_transaction_session_timeout')",
  );
  expect(result.rows[0]).toEqual(["t", "read committed", "0", "0", "0"]);
}

/** One step as one tenant, with every per-step check. Returns the normalised outcome. */
async function checkedStep(
  env: GateEnv,
  step: Step,
  canon: Canon,
  stats: Stats,
  cleanConnection: boolean,
): Promise<unknown> {
  const tenant = TENANTS[step.who];
  const other = TENANTS[1 - step.who] as string;
  const client = env.db.for({ tenantId: tenant }) as unknown as Client;
  const ownBefore = await env.snapshot(tenant);
  const otherBefore = await env.snapshot(other);
  const shouldInsert =
    step.op.t === "insert" ? await insertShouldSucceed(env, tenant, step.op) : undefined;
  const countBefore =
    step.op.t === "count" && step.op.view === "active" && step.op.chain.length === 0
      ? (await env.rows(step.op.table, tenant)).filter((row) => row.archivedAt === null).length
      : undefined;
  env.drain();

  const settled = await runTop(client, step.op, stats);

  const statements = env.rec.log.slice();
  expect(tenantProblems(statements, tenant, [other], TABLES)).toEqual([]);
  expect(env.audits.filter((audit) => audit.tenant !== tenant)).toEqual([]);
  expect(tenantsIn(settled).filter((found) => found !== tenant)).toEqual([]);
  expect(await env.snapshot(other)).toBe(otherBefore);
  const failed =
    "error" in settled || (step.op.t === "tx" && "ok" in settled && settled.ok === "rolled back");
  if (failed) expect(await env.snapshot(tenant)).toBe(ownBefore);
  if (shouldInsert !== undefined) expect("ok" in settled).toBe(shouldInsert);
  if (countBefore !== undefined) expect(settled).toEqual({ ok: countBefore });
  if (cleanConnection) await connectionIsClean(env);
  return canon.normalise(settled);
}

async function normalisedState(env: GateEnv, tenant: string): Promise<unknown> {
  return new Canon().normalise(JSON.parse(await env.snapshot(tenant)));
}

function withSeeds(list: readonly Step[]): Step[] {
  const first = seed(0);
  const second = seed(1);
  const out: Step[] = [];
  for (let index = 0; index < first.length; index += 1) {
    out.push(first[index]!, second[index]!);
  }
  return [...out, ...list];
}

/** Runs `list` for one tenant only on an empty database. */
async function solo(
  env: GateEnv,
  list: readonly Step[],
  who: 0 | 1,
  stats: Stats,
): Promise<{ outcomes: unknown[]; state: unknown }> {
  await env.clear();
  const canon = new Canon();
  const outcomes: unknown[] = [];
  for (const step of list) {
    if (step.who !== who) continue;
    outcomes.push(await checkedStep(env, step, canon, stats, false));
  }
  return { outcomes, state: await normalisedState(env, TENANTS[who]) };
}

/** The mixed-steps property, for a given environment. */
function mixedProperty(env: GateEnv, stats: Stats) {
  return fc.asyncProperty(steps(14), async (generated) => {
    const list = withSeeds(generated);
    await env.clear();
    const canons = [new Canon(), new Canon()];
    const mixed: unknown[][] = [[], []];
    for (const step of list) {
      const outcome = await checkedStep(env, step, canons[step.who]!, stats, true);
      mixed[step.who]!.push(outcome);
    }
    const states = [await normalisedState(env, TENANTS[0]), await normalisedState(env, TENANTS[1])];
    for (const who of [0, 1] as const) {
      const alone = await solo(env, list, who, emptyStats());
      expect(mixed[who]).toEqual(alone.outcomes);
      expect(states[who]).toEqual(alone.state);
    }
  });
}

postgresTest(
  gate,
  "isolation.property: mixed steps on one pooled connection stay inside the tenant",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      await assertGate("isolation.property mixed", mixedProperty(env, totals), 60);
    });
  },
  300_000,
);

/**
 * Statements with one tenant predicate made always true, as a bug in the planner would.
 * The property must fail on each, or it proves nothing.
 */
const MUTATIONS: readonly (readonly [string, (statement: Statement) => Statement])[] = [
  [
    "a read of tasks without its tenant predicate",
    dropPredicate(/^select .* from "tasks" t where /s, "t"),
  ],
  ["an update of tasks without its tenant predicate", dropPredicate(/^update "tasks" as t /, "t")],
  [
    "a delete of tasks without its tenant predicate",
    dropPredicate(/^delete from "tasks" as t /, "t"),
  ],
  [
    "an archive of orgs without its tenant predicate",
    dropPredicate(/^with archived as \(update "orgs" as t /, "t"),
  ],
];

function dropPredicate(match: RegExp, alias: string) {
  return (statement: Statement): Statement => {
    if (!match.test(statement.text)) return statement;
    const text = statement.text.replace(
      new RegExp(`${alias}\\."tenant_id" = (\\$\\d+)`),
      "($& or true)",
    );
    return { ...statement, text };
  };
}

for (const [label, mutate] of MUTATIONS) {
  postgresTest(
    gate,
    `isolation.property catches ${label}`,
    async () => {
      await withGate({ max: 1, mutate }, async (env) => {
        let caught = false;
        try {
          await fc.assert(mixedProperty(env, emptyStats()), { seed: GATE_SEED, numRuns: 60 });
        } catch {
          caught = true;
        }
        expect(caught).toBe(true);
      });
    },
    300_000,
  );
}

postgresTest(
  gate,
  "isolation.property: two tenants at once on a pool of three match each tenant alone",
  async () => {
    await withGate({ max: 3 }, async (env) => {
      await assertGate(
        "isolation.property concurrent",
        fc.asyncProperty(steps(10), async (generated) => {
          const list = withSeeds(generated);
          // Transactions retry a serialization failure, so a clash between the two
          // tenants' serializable transactions ends in the same result as running alone.
          const retried: Step[] = list.map((step) =>
            step.op.t === "tx" ? { who: step.who, op: { ...step.op, retry: 12 } } : step,
          );
          await env.clear();
          const outcomes: unknown[][] = [[], []];
          const stats = emptyStats();
          await Promise.all(
            ([0, 1] as const).map(async (who) => {
              const canon = new Canon();
              const client = env.db.for({ tenantId: TENANTS[who] }) as unknown as Client;
              for (const step of retried) {
                if (step.who !== who) continue;
                outcomes[who]!.push(canon.normalise(await runTop(client, step.op, stats)));
              }
            }),
          );
          // No statement mixes the two tenants, and each binds the tenant it names.
          for (const statement of env.rec.log) {
            const named = TENANTS.filter(
              (tenant) => statement.params.includes(tenant) || statement.text.includes(tenant),
            );
            expect(named.length).toBeLessThanOrEqual(1);
            const [tenant] = named;
            if (tenant === undefined) continue;
            const other = TENANTS.find((candidate) => candidate !== tenant)!;
            expect(tenantProblems([statement], tenant, [other], TABLES)).toEqual([]);
          }
          const states = [
            await normalisedState(env, TENANTS[0]),
            await normalisedState(env, TENANTS[1]),
          ];
          for (const who of [0, 1] as const) {
            const alone = await solo(env, retried, who, emptyStats());
            expect(outcomes[who]).toEqual(alone.outcomes);
            expect(states[who]).toEqual(alone.state);
          }
        }),
        40,
      );
    });
  },
  300_000,
);

postgresTest(
  gate,
  "isolation.property: serializable transactions of two tenants retry and stay apart",
  async () => {
    await withGate({ max: 3 }, async (env) => {
      await env.clear();
      const a = env.db.for({ tenantId: TENANTS[0] });
      const b = env.db.for({ tenantId: TENANTS[1] });
      for (const client of [a, b]) {
        await client.orgs.insert({ id: key("o", 0), name: "n0" });
        await client.projects.insert({ id: key("p", 0), orgId: key("o", 0), name: "n0" });
        await client.tasks.insert({ id: key("t", 0), projectId: key("p", 0), title: "n0" });
      }
      env.drain();
      // A reads tasks and writes a project. B reads projects and writes a task.
      // Each reads what the other writes, so the two cannot both commit as they started.
      let attempts = 0;
      const gateOpen = Promise.withResolvers<void>();
      let waiting = 0;
      const rendezvous = async (): Promise<void> => {
        waiting += 1;
        if (waiting >= 2) gateOpen.resolve();
        await gateOpen.promise;
      };
      const [left, right] = await Promise.all([
        a.tx({ isolation: "serializable", retry: 5 }, async (t) => {
          attempts += 1;
          const seen = await t.tasks.count();
          if (attempts === 1) await rendezvous();
          await t.projects.insert({
            id: key("p", 1),
            orgId: key("o", 0),
            name: `seen${String(seen)}`,
          });
          return seen;
        }),
        b.tx({ isolation: "serializable", retry: 5 }, async (t) => {
          attempts += 1;
          const seen = await t.projects.count();
          if (attempts <= 2) await rendezvous();
          await t.tasks.insert({
            id: key("t", 1),
            projectId: key("p", 0),
            title: `seen${String(seen)}`,
          });
          return seen;
        }),
      ]);
      expect(left).toBeGreaterThanOrEqual(1);
      expect(right).toBeGreaterThanOrEqual(1);
      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(env.audits.filter((audit) => audit.op === "INSERT").length).toBeGreaterThanOrEqual(2);
      const problems = TENANTS.flatMap((tenant) =>
        tenantProblems(
          env.rec.log.filter((item) => item.params.includes(tenant)),
          tenant,
          TENANTS.filter((other) => other !== tenant),
          TABLES,
        ),
      );
      expect(problems).toEqual([]);
      expect((await a.projects.find({ limit: 5 })).map((row) => row.id).sort()).toEqual(
        [key("p", 0), key("p", 1)].sort(),
      );
      expect((await b.tasks.find({ limit: 5 })).map((row) => row.id).sort()).toEqual(
        [key("t", 0), key("t", 1)].sort(),
      );
      expect(await a.tasks.count()).toBe(1);
      expect(await b.projects.count()).toBe(1);
    });
  },
  60_000,
);

afterAll(() => {
  if (process.env.OKM_PROPERTY_REPORT === "1") {
    console.log(`[isolation.property] ${JSON.stringify(totals)}`);
  }
});

test("isolation() holds on the gate schema", async () => {
  const harness = await testing(gateApp, { driver: openPglite() });
  try {
    const report = await harness.isolation();
    expect([...report.checked]).toEqual([...TENANT_TABLES]);
    expect(report.skipped).toEqual([{ table: "countries", reason: "shared reference data" }]);
  } finally {
    await harness.close();
  }
});
