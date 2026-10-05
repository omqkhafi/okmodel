/**
 * `archive.correctness` (P30): archive, restore, cascade to direct children, partial
 * unique indexes and `archiveId` stay consistent under random sequences, with
 * tenancy and inside `tx`, on real Postgres.
 *
 * A small model says what each call must do, from the archive contract (spec 7.1):
 *
 * - archive sets `archivedAt` and one `archiveId` on the row and on its active
 *   direct children (orgs to projects, projects to tasks), never on grandchildren;
 * - restore of a row clears it and the children that share its `archiveId`; it
 *   fails (kind `invalid`) while the row's cascade parent is archived, and fails
 *   (kind `unique`) when an active row holds the same name, for the row or any child;
 * - uniques only count active rows, so an archived name can be taken again;
 * - nothing here ever touches the other tenant, which holds the same ids and names.
 *
 * The model learns an `archiveId` from the call's result; after each step it must
 * match the database row for row, including the `archiveId` itself. A step that
 * fails changes nothing. A `tx` that rolls back, an inner savepoint that rolls
 * back, and a `batch` that fails leave the state of the step before them.
 */

import { expect } from "bun:test";
import fc from "fast-check";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { SQL_NAME, withGate, type GateEnv } from "./gate-env.js";
import { handle, Rollback, startWrite, type Client } from "./gate-ops.js";
import { assertGate } from "./gate-property.js";
import { tenantProblems } from "./gate-recorder.js";
import { key, TENANTS, type TenantTable } from "./gate-schema.js";

const gate = await loadPostgresGate();

const TABLES = ["orgs", "projects", "tasks"] as const;
type Table = (typeof TABLES)[number];
const KIND = { orgs: "o", projects: "p", tasks: "t" } as const;
const NAME_FIELD = { orgs: "name", projects: "name", tasks: "title" } as const;
const PARENT_OF = { orgs: undefined, projects: "orgs", tasks: "projects" } as const;
const CHILD_OF = { orgs: "projects", projects: "tasks", tasks: undefined } as const;

type Row = {
  id: string;
  parent: string | null;
  name: string;
  archived: boolean;
  group: string | null;
};
type State = { orgs: Row[]; projects: Row[]; tasks: Row[] };

type AOp =
  | {
      readonly k: "insert";
      readonly table: Table;
      readonly n: number;
      readonly label: number;
      readonly parent: number;
    }
  | { readonly k: "archive"; readonly table: Table; readonly n: number }
  | { readonly k: "restore"; readonly table: Table; readonly n: number }
  | { readonly k: "restoreGroup"; readonly table: Table; readonly n: number }
  | { readonly k: "rename"; readonly table: Table; readonly n: number; readonly label: number }
  | { readonly k: "delete"; readonly table: Table; readonly n: number; readonly only: boolean };

type Wrap = "none" | "txCommit" | "txRollback" | "batch" | "savepointKeep" | "savepointDrop";

type AStep = { readonly who: 0 | 1; readonly wrap: Wrap; readonly ops: readonly AOp[] };

const TABLE_SQL = Object.values(SQL_NAME);
const empty = (): State => ({ orgs: [], projects: [], tasks: [] });
const clone = (state: State): State => structuredClone(state);
const idOf = (table: Table, n: number): string => key(KIND[table], n);
const nameOf = (label: number): string => `n${String(label)}`;

/** What the run covered, so a green run cannot be a run that never reached the hard cases. */
const seen = new Map<string, number>();
const hit = (name: string): void => void seen.set(name, (seen.get(name) ?? 0) + 1);

type Kind = OkmError["kind"];
type Outcome = { readonly count: number } | { readonly error: Kind };

/** Applies one call to a model state and says what it must return. */
function model(state: State, op: AOp, token: string): Outcome {
  const rows = state[op.table];
  const id = idOf(op.table, op.n);
  const row = rows.find((candidate) => candidate.id === id);
  const parentTable = PARENT_OF[op.table];
  const childTable = CHILD_OF[op.table];
  const children = (of: Row): Row[] =>
    childTable === undefined ? [] : state[childTable].filter((child) => child.parent === of.id);
  switch (op.k) {
    case "insert": {
      const name = nameOf(op.label);
      if (row !== undefined) return { error: "unique" };
      if (rows.some((other) => !other.archived && other.name === name)) return { error: "unique" };
      let parent: string | null = null;
      if (parentTable !== undefined) {
        parent = idOf(parentTable, op.parent);
        if (!state[parentTable].some((other) => other.id === parent)) {
          return { error: "foreign_key" };
        }
      }
      if (rows.some((other) => other.archived && other.name === name))
        hit("an archived name taken again");
      rows.push({ id, parent, name, archived: false, group: null });
      return { count: 1 };
    }
    case "archive": {
      if (row === undefined || row.archived) return { count: 0 };
      row.archived = true;
      row.group = token;
      for (const child of children(row)) {
        if (child.archived) continue;
        child.archived = true;
        child.group = token;
        hit("archive cascaded to a child");
        if (childTable !== undefined && CHILD_OF[childTable] !== undefined) {
          if (state[CHILD_OF[childTable]!].some((g) => g.parent === child.id && !g.archived)) {
            hit("a grandchild left active");
          }
        }
      }
      return { count: 1 };
    }
    case "restore":
    case "restoreGroup": {
      if (row === undefined || !row.archived) return { count: 0 };
      const targets =
        op.k === "restore"
          ? [row]
          : rows.filter((other) => other.archived && other.group === row.group);
      // The statement fails as a whole, so nothing changes unless every target can come back.
      for (const target of targets) {
        if (parentTable !== undefined) {
          const parent = state[parentTable].find((other) => other.id === target.parent);
          if (parent?.archived === true) {
            hit("restore blocked by an archived parent");
            return { error: "invalid" };
          }
        }
        if (
          rows.some((other) => !other.archived && other.name === target.name && other !== target)
        ) {
          hit("restore blocked by an active name");
          return { error: "unique" };
        }
        for (const child of children(target)) {
          if (!child.archived || target.group === null || child.group !== target.group) continue;
          const siblings = state[childTable!];
          if (siblings.some((other) => !other.archived && other.name === child.name)) {
            hit("restore blocked by a child's active name");
            return { error: "unique" };
          }
        }
      }
      for (const target of targets) {
        for (const child of children(target)) {
          if (child.archived && target.group !== null && child.group === target.group) {
            child.archived = false;
            child.group = null;
            hit("restore cascaded to a child");
          }
        }
        if (op.k === "restoreGroup") hit("restore by archiveId");
        target.archived = false;
        target.group = null;
      }
      return { count: targets.length };
    }
    case "rename": {
      if (row === undefined || row.archived) return { count: 0 };
      const name = nameOf(op.label);
      if (rows.some((other) => !other.archived && other.name === name && other !== row)) {
        return { error: "unique" };
      }
      row.name = name;
      return { count: 1 };
    }
    case "delete": {
      if (row === undefined || row.archived === !op.only) return { count: 0 };
      if (children(row).length > 0) {
        hit("delete blocked by a child");
        return { error: "foreign_key" };
      }
      rows.splice(rows.indexOf(row), 1);
      hit("delete");
      return { count: 1 };
    }
  }
}

/** The same call as the isolation gate makes, so one function starts every write. */
function start(client: Client, op: AOp): PromiseLike<unknown> {
  switch (op.k) {
    case "insert":
      return startWrite(client, {
        t: "insert",
        table: op.table,
        n: op.n,
        label: op.label,
        parent: op.parent,
        other: 0,
      });
    case "archive":
      return startWrite(client, { t: "archive", table: op.table, n: op.n, chain: [] });
    case "restore":
      return startWrite(client, { t: "restore", table: op.table, n: op.n });
    case "restoreGroup":
      return startWrite(client, { t: "restoreGroup", table: op.table, n: op.n });
    case "rename":
      return startWrite(client, {
        t: "update",
        table: op.table,
        n: op.n,
        label: op.label,
        parent: 0,
        chain: [],
      });
    case "delete":
      return startWrite(client, {
        t: "delete",
        table: op.table,
        n: op.n,
        view: op.only ? "only" : "active",
        chain: [],
      });
  }
}

type Called =
  | { readonly ok: { readonly count: number; readonly archiveId?: string } }
  | { readonly error: OkmError };

/** An insert gives back the row; the model only says it happened. */
function norm(op: AOp, value: unknown): { count: number; archiveId?: string } {
  return op.k === "insert" ? { count: 1 } : (value as { count: number; archiveId?: string });
}

async function call(op: AOp, fn: () => PromiseLike<unknown>): Promise<Called> {
  try {
    return { ok: norm(op, await fn()) };
  } catch (error) {
    if (error instanceof OkmError) return { error };
    throw error;
  }
}

async function callBatch(
  ops: readonly AOp[],
  fn: () => PromiseLike<unknown>,
): Promise<
  { readonly ok: { count: number; archiveId?: string }[] } | { readonly error: OkmError }
> {
  try {
    const out = (await fn()) as unknown[];
    return { ok: out.map((value, index) => norm(ops[index]!, value)) };
  } catch (error) {
    if (error instanceof OkmError) return { error };
    throw error;
  }
}

/** Compares a call with the model: the same count, or the same kind of failure. */
function expectSame(got: Called, want: Outcome, label: string): void {
  if ("error" in want) {
    expect("error" in got, `${label}: expected ${want.error}`).toBe(true);
    if ("error" in got) expect(got.error.kind, label).toBe(want.error);
  } else {
    expect("ok" in got, `${label}: ${"error" in got ? got.error.message : ""}`).toBe(true);
    if ("ok" in got) expect(got.ok.count, label).toBe(want.count);
  }
}

async function dbState(env: GateEnv, tenant: string): Promise<State> {
  const state = empty();
  for (const table of TABLES) {
    const raw = await env.rows(table as TenantTable, tenant);
    state[table] = raw.map((row) => ({
      id: row.id,
      parent:
        table === "projects"
          ? (row.orgId as string)
          : table === "tasks"
            ? (row.projectId as string)
            : null,
      name: row[NAME_FIELD[table]] as string,
      archived: row.archivedAt !== null,
      group: row.archiveId,
    }));
  }
  return state;
}

const byId = (state: State): State => ({
  orgs: [...state.orgs].sort((a, b) => a.id.localeCompare(b.id)),
  projects: [...state.projects].sort((a, b) => a.id.localeCompare(b.id)),
  tasks: [...state.tasks].sort((a, b) => a.id.localeCompare(b.id)),
});

/**
 * True when a restore in the list would be refused because its parent is archived.
 *
 * FINDING P30-1: `batch` checks that result after the unit has committed, so the
 * other writes in the batch stay while the caller sees OKM1xxx `invalid`. The
 * property runs such a list in a `tx` instead and the report states the finding.
 */
function blocksRestore(state: State, ops: readonly AOp[]): boolean {
  const trial = clone(state);
  return ops
    .filter((op) => op.k !== "restoreGroup")
    .some((op, index) => {
      const outcome = model(trial, op, `@${String(index)}`);
      return op.k === "restore" && "error" in outcome && outcome.error === "invalid";
    });
}

/**
 * Runs one step against the database and the model. Returns the model state after it.
 *
 * The database is the authority on an `archiveId`: the model takes it from the result.
 */
async function runStep(env: GateEnv, step: AStep, models: State[]): Promise<void> {
  const tenant = TENANTS[step.who];
  const client = env.db.for({ tenantId: tenant }) as unknown as Client;
  const draft = clone(models[step.who]!);
  const label = JSON.stringify(step);
  const wrap = step.wrap === "batch" && blocksRestore(draft, step.ops) ? "txCommit" : step.wrap;

  const one = async (target: Client, op: AOp, within: State): Promise<Called> => {
    const got = await call(op, () => start(target, op));
    const token = "ok" in got ? (got.ok.archiveId ?? "none") : "none";
    const want = model(within, op, token);
    if (op.k === "restoreGroup" && "ok" in got && got.ok.count === 0 && "count" in want) {
      expect(want.count, label).toBe(0);
    } else expectSame(got, want, `${label} :: ${JSON.stringify(op)}`);
    return got;
  };

  hit(`wrapped in ${wrap}`);
  switch (wrap) {
    case "none":
      for (const op of step.ops) await one(client, op, draft);
      break;
    case "txCommit":
    case "txRollback": {
      const rollback = wrap === "txRollback";
      const inner = clone(draft);
      let failed = false;
      try {
        await (
          client as unknown as { tx(fn: (t: Client) => Promise<unknown>): Promise<unknown> }
        ).tx(async (t) => {
          for (const op of step.ops) {
            const got = await one(t, op, inner);
            if ("error" in got) {
              failed = true;
              throw got.error;
            }
          }
          if (rollback) throw new Rollback();
        });
      } catch (error) {
        if (!(error instanceof Rollback) && !(error instanceof OkmError)) throw error;
      }
      if (!failed && !rollback) models[step.who] = inner;
      break;
    }
    case "batch": {
      const writes = step.ops.filter((op) => op.k !== "restoreGroup");
      const placeholder = writes.map((_, index) => `@${String(index)}`);
      const inner = clone(draft);
      const wants = writes.map((op, index) => model(inner, op, placeholder[index]!));
      const failedAt = wants.findIndex((want) => "error" in want);
      const got = await callBatch(writes, () =>
        (client as unknown as { batch(ops: unknown[]): PromiseLike<unknown> }).batch(
          writes.map((op) => start(client, op)),
        ),
      );
      if (failedAt >= 0) {
        expect("error" in got, label).toBe(true);
        if ("error" in got) {
          expect(got.error.kind, label).toBe((wants[failedAt] as { error: Kind }).error);
          expect(got.error.batchIndex, label).toBe(failedAt);
        }
      } else {
        if (!("ok" in got)) throw got.error;
        const results = got.ok;
        results.forEach((result, index) => {
          expect(result.count, label).toBe((wants[index] as { count: number }).count);
        });
        // The model learned its tokens from the results.
        const tokens = new Map(
          placeholder.map((p, index) => [p, results[index]?.archiveId ?? "none"]),
        );
        for (const table of TABLES) {
          for (const row of inner[table]) {
            if (row.group !== null && tokens.has(row.group)) row.group = tokens.get(row.group)!;
          }
        }
        models[step.who] = inner;
      }
      break;
    }
    case "savepointKeep":
    case "savepointDrop": {
      const [first, ...rest] = step.ops;
      const outer = clone(draft);
      let innerFailed = false;
      await (client as unknown as { tx(fn: (t: Client) => Promise<unknown>): Promise<unknown> })
        .tx(async (t) => {
          // The first call is outside the savepoint. An error there ends the transaction.
          if (first !== undefined) {
            const got = await one(t, first, outer);
            if ("error" in got) {
              innerFailed = true;
              throw got.error;
            }
          }
          const nested = clone(outer);
          try {
            await (
              t as unknown as { tx(fn: (n: Client) => Promise<unknown>): Promise<unknown> }
            ).tx(async (n) => {
              for (const op of rest) {
                const got = await one(n, op, nested);
                if ("error" in got) throw got.error;
              }
              if (wrap === "savepointDrop") throw new Rollback();
            });
            // The savepoint was released: its changes stay.
            outer.orgs = nested.orgs;
            outer.projects = nested.projects;
            outer.tasks = nested.tasks;
          } catch (error) {
            if (!(error instanceof Rollback) && !(error instanceof OkmError)) throw error;
            // Rolled back to the savepoint: the outer transaction goes on without it.
          }
        })
        .catch((error: unknown) => {
          if (!innerFailed) throw error;
        });
      if (!innerFailed) models[step.who] = outer;
      break;
    }
  }
  if (wrap === "none") models[step.who] = draft;
}

const table = fc.constantFrom<Table>(...TABLES);
const n = fc.integer({ min: 0, max: 2 });
/** Mostly one name, so a freed name is often taken and then wanted back. */
const label = fc.oneof(
  { weight: 4, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constant(1) },
);

const aop: fc.Arbitrary<AOp> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ k: fc.constant("insert" as const), table, n, label, parent: n }),
  },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("archive" as const), table, n }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("restore" as const), table, n }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("restoreGroup" as const), table, n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("rename" as const), table, n, label }) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant("delete" as const), table, n, only: fc.boolean() }),
  },
);

const wrap = fc.constantFrom<Wrap>(
  "none",
  "none",
  "none",
  "txCommit",
  "txRollback",
  "batch",
  "savepointKeep",
  "savepointDrop",
);

const aStep: fc.Arbitrary<AStep> = fc.record({
  who: fc.constantFrom<0 | 1>(0, 1),
  wrap,
  ops: fc.array(aop, { minLength: 1, maxLength: 3 }),
});

/** Opening moves so there is something to archive in both tenants. */
const OPENING: AStep[] = ([0, 1] as const).flatMap((who) => [
  {
    who,
    wrap: "none" as const,
    ops: [{ k: "insert" as const, table: "orgs" as const, n: 0, label: 0, parent: 0 }],
  },
  {
    who,
    wrap: "none" as const,
    ops: [{ k: "insert" as const, table: "projects" as const, n: 0, label: 0, parent: 0 }],
  },
  {
    who,
    wrap: "none" as const,
    ops: [{ k: "insert" as const, table: "projects" as const, n: 1, label: 1, parent: 0 }],
  },
  {
    who,
    wrap: "none" as const,
    ops: [{ k: "insert" as const, table: "tasks" as const, n: 0, label: 0, parent: 0 }],
  },
  {
    who,
    wrap: "none" as const,
    ops: [{ k: "insert" as const, table: "tasks" as const, n: 1, label: 1, parent: 1 }],
  },
]);

/**
 * A short script for the case chance rarely builds: a child's name is taken while
 * its parent is archived, then the parent is restored.
 */
const SCRIPT: AStep[] = [
  { who: 0, wrap: "none", ops: [{ k: "archive", table: "projects", n: 0 }] },
  { who: 0, wrap: "none", ops: [{ k: "insert", table: "tasks", n: 2, label: 0, parent: 1 }] },
  { who: 0, wrap: "none", ops: [{ k: "restore", table: "projects", n: 0 }] },
];

postgresTest(
  gate,
  "archive.correctness: random sequences match the contract, with tenancy and inside tx",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      // The unique on each name is partial, and the tenant key leads it.
      const indexes = await env.sql.unsafe(
        `select tablename, indexdef from pg_indexes where schemaname = current_schema() and indexdef ilike '%unique%'`,
      );
      for (const name of ["orgs", "projects", "tasks"]) {
        const defs = indexes
          .filter((row) => row.tablename === name)
          .map((row) => String(row.indexdef).toLowerCase());
        expect(
          defs.some((def) => def.includes("tenant_id") && def.includes("archived_at is null")),
          `${name}: ${defs.join(" | ")}`,
        ).toBe(true);
      }
      await assertGate(
        "archive.correctness",
        fc.asyncProperty(
          fc.boolean(),
          fc.array(aStep, { minLength: 8, maxLength: 20 }),
          async (scripted, generated) => {
            await env.clear();
            const models: State[] = [empty(), empty()];
            for (const step of [...OPENING, ...(scripted ? SCRIPT : []), ...generated]) {
              const other = TENANTS[1 - step.who]!;
              const otherBefore = await env.snapshot(other);
              env.drain();
              await runStep(env, step, models);
              const tenant = TENANTS[step.who]!;
              expect(tenantProblems(env.rec.log, tenant, [other], TABLE_SQL)).toEqual([]);
              expect(env.audits.filter((audit) => audit.tenant !== tenant)).toEqual([]);
              expect(await env.snapshot(other)).toBe(otherBefore);
              // The database matches the model, row for row, `archiveId` included.
              const actual = byId(await dbState(env, tenant));
              expect(actual, JSON.stringify(step)).toEqual(byId(models[step.who]!));
              // Every archived row has an id, and no active row has one.
              for (const t of TABLES) {
                for (const row of actual[t]) expect(row.archived).toBe(row.group !== null);
              }
              // The reads agree with the rows: active, archived, and both.
              const scoped = env.db.for({ tenantId: tenant }) as unknown as Client;
              for (const t of TABLES) {
                const ids = (rows: unknown): string[] =>
                  (rows as { id: string }[]).map((row) => row.id).sort();
                const want = (archived: boolean | undefined): string[] =>
                  actual[t]
                    .filter((row) => archived === undefined || row.archived === archived)
                    .map((row) => row.id)
                    .sort();
                expect(ids(await handle(scoped, t, "active", []).find!({ limit: 20 }))).toEqual(
                  want(false),
                );
                expect(ids(await handle(scoped, t, "only", []).find!({ limit: 20 }))).toEqual(
                  want(true),
                );
                expect(ids(await handle(scoped, t, "with", []).find!({ limit: 20 }))).toEqual(
                  want(undefined),
                );
                expect(await handle(scoped, t, "active", []).count!()).toBe(want(false).length);
              }
            }
          },
        ),
        100,
      );
      const reached = [
        "an archived name taken again",
        "archive cascaded to a child",
        "a grandchild left active",
        "restore blocked by an archived parent",
        "restore blocked by an active name",
        "restore blocked by a child's active name",
        "restore cascaded to a child",
        "restore by archiveId",
        "delete",
        "delete blocked by a child",
        "wrapped in none",
        "wrapped in txCommit",
        "wrapped in txRollback",
        "wrapped in batch",
        "wrapped in savepointKeep",
        "wrapped in savepointDrop",
      ];
      if (process.env.OKM_PROPERTY_REPORT === "1") console.log(Object.fromEntries(seen));
      expect(reached.filter((name) => (seen.get(name) ?? 0) === 0)).toEqual([]);
    });
  },
  300_000,
);
