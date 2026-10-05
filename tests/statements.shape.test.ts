/**
 * `statements.shape` (spec 5.3, P30): the number of statements a call sends is
 * set by the shape of the query, never by how many rows it returns or touches.
 *
 * Every shape runs against a tenant holding 0, 1, 10 and 1,000 projects (each with
 * a parent, two tasks and a label), on real Postgres, with the recording pool
 * counting what reached the driver. The counts must be equal across the four
 * sizes and equal to the number written down here. An insert of a list is the one
 * write that may split, by input size (`WRITE_PARAM_BUDGET`), inside one
 * transaction; its count is checked against that rule.
 */

import { expect } from "bun:test";

import { gte, has, none } from "../src/dialects/pg/index.js";
import { WRITE_PARAM_BUDGET } from "../src/runtime/write.js";
import fc from "fast-check";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { SQL_NAME, withGate, type GateEnv } from "./gate-env.js";
import { countQueries, tenantProblems } from "./gate-recorder.js";
import { readOp, runLeaf, type Client } from "./gate-ops.js";
import { assertGate } from "./gate-property.js";
import { key, TENANT_A, TENANT_B, TENANT_TABLES } from "./gate-schema.js";

const gate = await loadPostgresGate();

const SIZES = [0, 1, 10, 1000] as const;

type Scoped = ReturnType<GateEnv["db"]["for"]>;

/** One query shape: how to run it, and how many statements it is allowed. */
type Shape = {
  readonly name: string;
  readonly expected: number;
  readonly run: (a: Scoped) => PromiseLike<unknown>;
  /** What the call must have returned at this size, so a count of 1 is not 1 because nothing came back. */
  readonly returns?: (value: unknown, size: number) => void;
};

/** A tenant with `size` projects, two tasks and one label each, and a parent org. */
async function populate(env: GateEnv, size: number): Promise<void> {
  await env.clear();
  for (const tenant of [TENANT_A, TENANT_B]) {
    // Tenant B always holds 10 projects, so a statement that read across tenants would show.
    const count = tenant === TENANT_A ? size : 10;
    await env.sql.unsafe(`insert into orgs (id, name, tenant_id) values ($1, 'org', $2)`, [
      key("o", 0),
      tenant,
    ]);
    if (count === 0) continue;
    await env.sql.unsafe(
      `insert into projects (id, org_id, name, budget, tenant_id, starred)
         select ('01890c5a-8f0e-7c3a-9b2d-0002' || lpad(to_hex(i), 8, '0'))::uuid, $1, 'p' || i, i, $2, i % 2 = 0
         from generate_series(0, $3::int - 1) i`,
      [key("o", 0), tenant, count],
    );
    await env.sql.unsafe(
      `insert into tasks (id, project_id, title, priority, tenant_id)
         select ('01890c5a-8f0e-7c3a-9b2d-0003' || lpad(to_hex(i * 2 + k), 8, '0'))::uuid,
                ('01890c5a-8f0e-7c3a-9b2d-0002' || lpad(to_hex(i), 8, '0'))::uuid, 't' || i || '-' || k, k, $1
         from generate_series(0, $2::int - 1) i, generate_series(0, 1) k`,
      [tenant, count],
    );
    await env.sql.unsafe(`insert into labels (id, name, tenant_id) values ($1, 'l', $2)`, [
      key("l", 0),
      tenant,
    ]);
    await env.sql.unsafe(
      `insert into project_labels (id, project_id, label_id, tenant_id)
         select ('01890c5a-8f0e-7c3a-9b2d-0005' || lpad(to_hex(i), 8, '0'))::uuid,
                ('01890c5a-8f0e-7c3a-9b2d-0002' || lpad(to_hex(i), 8, '0'))::uuid, $1, $2
         from generate_series(0, $3::int - 1) i`,
      [key("l", 0), tenant, count],
    );
  }
  env.drain();
}

const LIMIT = 5000;

const READS: readonly Shape[] = [
  {
    name: "find",
    expected: 1,
    run: (a) => a.projects.find({ limit: LIMIT }),
    returns: (value, size) => expect(value).toHaveLength(size),
  },
  {
    name: "find, order and where",
    expected: 1,
    run: (a) => a.projects.find({ where: { name: "p0" }, orderBy: { name: "asc" }, limit: LIMIT }),
  },
  {
    name: "find with one",
    expected: 1,
    run: (a) => a.projects.find({ include: { org: true }, limit: LIMIT }),
  },
  {
    name: "find with many",
    expected: 1,
    run: (a) => a.projects.find({ include: { tasks: { limit: 5 } }, limit: LIMIT }),
    returns: (value, size) => {
      const rows = value as readonly { tasks: readonly unknown[] }[];
      expect(rows).toHaveLength(size);
      for (const row of rows) expect(row.tasks).toHaveLength(2);
    },
  },
  {
    name: "find with manyThrough",
    expected: 1,
    run: (a) => a.projects.find({ include: { labels: { limit: 5 } }, limit: LIMIT }),
  },
  {
    name: "find with all three includes",
    expected: 1,
    run: (a) =>
      a.projects.find({
        include: { org: true, tasks: { limit: 5 }, labels: { limit: 5 } },
        limit: LIMIT,
      }),
  },
  {
    name: "find through a to-one include and back",
    expected: 1,
    run: (a) => a.tasks.find({ include: { project: true }, limit: LIMIT }),
  },
  {
    name: "find filtered by has()",
    expected: 1,
    run: (a) => a.projects.find({ where: { tasks: has({ title: "t0-0" }) }, limit: LIMIT }),
  },
  {
    name: "find filtered by none() through a join table",
    expected: 1,
    run: (a) => a.projects.find({ where: { labels: none({ name: "zz" }) }, limit: LIMIT }),
  },
  {
    name: "find with presets",
    expected: 1,
    run: (a) => a.projects.starred().rich().find({ limit: LIMIT }),
  },
  {
    name: "find with presets and includes",
    expected: 1,
    run: (a) =>
      a.projects.starred().find({ include: { tasks: { limit: 3 }, org: true }, limit: LIMIT }),
  },
  {
    name: "find withArchived",
    expected: 1,
    run: (a) => a.projects.withArchived().find({ limit: LIMIT }),
  },
  {
    name: "find onlyArchived",
    expected: 1,
    run: (a) => a.projects.onlyArchived().find({ limit: LIMIT }),
  },
  { name: "one", expected: 1, run: (a) => a.projects.one({ where: { name: "p0" } }) },
  {
    name: "count",
    expected: 1,
    run: (a) => a.projects.count(),
    returns: (value, size) => expect(value).toBe(size),
  },
  { name: "count with presets", expected: 1, run: (a) => a.projects.starred().count() },
  { name: "exists", expected: 1, run: (a) => a.projects.exists() },
  {
    name: "aggregate",
    expected: 1,
    run: (a) => a.projects.aggregate({ count: true, sum: ["budget"] }),
  },
  {
    name: "aggregate by group",
    expected: 1,
    run: (a) => a.tasks.aggregate({ groupBy: ["priority"], count: true, limit: 10 }),
  },
  {
    name: "page (one page)",
    expected: 1,
    run: (a) => a.projects.page({ orderBy: { name: "asc" }, limit: 50 }),
    returns: (value, size) =>
      expect((value as { items: unknown[] }).items).toHaveLength(Math.min(50, size)),
  },
  {
    name: "page with includes",
    expected: 1,
    run: (a) =>
      a.projects.page({ orderBy: { name: "asc" }, limit: 50, include: { tasks: { limit: 3 } } }),
  },
  // Reads in a transaction: BEGIN, the statement, COMMIT.
  {
    name: "find with includes in tx",
    expected: 3,
    run: (a) =>
      a.tx((t) => t.projects.find({ include: { org: true, tasks: { limit: 5 } }, limit: LIMIT })),
  },
  {
    name: "locked find in tx",
    expected: 3,
    run: (a) => a.tx((t) => t.projects.find({ lock: "share", limit: LIMIT })),
  },
  {
    name: "two reads in a nested tx",
    expected: 6,
    run: (a) =>
      a.tx(async (t) => {
        await t.projects.count();
        return t.tx((n) => n.projects.find({ limit: LIMIT }));
      }),
  },
];

const WRITES: readonly Shape[] = [
  {
    name: "update every row with a budget",
    expected: 1,
    run: (a) => a.projects.update({ where: { budget: gte(0) }, set: { notes: "x" } }),
  },
  {
    name: "update by id",
    expected: 1,
    run: (a) => a.projects.update({ where: { id: key("p", 0) }, set: { name: "renamed" } }),
  },
  {
    name: "update with presets",
    expected: 1,
    run: (a) => a.projects.starred().update({ where: { name: "p0" }, set: { budget: 1 } }),
  },
  {
    name: "archive with cascade to children",
    expected: 1,
    run: (a) => a.projects.archive({}).all("shape"),
  },
  {
    name: "restore with cascade to children",
    expected: 1,
    run: (a) => a.projects.restore({}).all("shape"),
  },
  { name: "delete every matching row", expected: 1, run: (a) => a.tasks.delete({}).all("shape") },
  {
    name: "batch of three writes",
    expected: 3,
    run: (a) =>
      a.batch([
        a.tasks.update({ where: { title: "t0-0" }, set: { priority: 9 } }),
        a.projectLabels.archive({}).all("shape"),
        a.tasks.delete({ where: { title: "t0-1" } }),
      ]),
  },
  {
    name: "tx with an update and a delete",
    expected: 4,
    run: (a) =>
      a.tx(async (t) => {
        await t.tasks.update({ where: { title: "t0-0" }, set: { priority: 4 } });
        await t.tasks.delete({ where: { title: "t0-1" } });
      }),
  },
];

async function measure(env: GateEnv, shape: Shape, size: number): Promise<number> {
  await populate(env, size);
  const a = env.db.for({ tenantId: TENANT_A });
  const { statements, value } = await countQueries(env.rec, () => Promise.resolve(shape.run(a)));
  shape.returns?.(value, size);
  expect(
    tenantProblems(statements, TENANT_A, [TENANT_B], Object.values(SQL_NAME)),
    `${shape.name} at ${String(size)} rows`,
  ).toEqual([]);
  return statements.length;
}

postgresTest(
  gate,
  "statements.shape: a read sends the same number of statements at 0, 1, 10 and 1,000 rows",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      for (const shape of READS) {
        const counts: number[] = [];
        for (const size of SIZES) counts.push(await measure(env, shape, size));
        expect(counts, `${shape.name} across ${SIZES.join(", ")} rows`).toEqual(
          SIZES.map(() => shape.expected),
        );
      }
    });
  },
  300_000,
);

postgresTest(
  gate,
  "statements.shape: a write sends the same number of statements whatever it touches",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      for (const shape of WRITES) {
        const counts: number[] = [];
        for (const size of SIZES) counts.push(await measure(env, shape, size));
        // A write that matches nothing still sends its statement.
        expect(counts, `${shape.name} across ${SIZES.join(", ")} rows`).toEqual(
          SIZES.map(() => shape.expected),
        );
      }
    });
  },
  300_000,
);

postgresTest(
  gate,
  "statements.shape: a list insert splits by input size only, inside one unit",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      await env.clear();
      const a = env.db.for({ tenantId: TENANT_A });
      await a.orgs.insert({ id: key("o", 0), name: "org" });
      env.drain();
      // Four parameters a row: id, org, name, tenant key. The rest take their defaults.
      const perRow = 4;
      for (const size of SIZES) {
        await env.sql.unsafe("delete from projects");
        const rows = Array.from({ length: size }, (_, index) => ({
          id: key("p", index),
          orgId: key("o", 0),
          name: `p${String(index)}`,
        }));
        const calls = env.rec.calls.count;
        const { statements } = await countQueries(env.rec, () => a.projects.insert(rows));
        // One driver call, whatever the number of statements: the chunks are one atomic unit.
        expect(env.rec.calls.count - calls).toBe(size === 0 ? 0 : 1);
        const inserts = statements.filter((statement) => /^insert /i.test(statement.text));
        expect(inserts.length).toBe(Math.ceil((size * perRow) / WRITE_PARAM_BUDGET));
        expect(statements.length).toBe(inserts.length);
        expect(await a.projects.count()).toBe(size);
        // Splitting is not a loop over rows: 1,000 rows is a handful of statements.
        expect(inserts.length).toBeLessThanOrEqual(2);
      }
    });
  },
  120_000,
);

/** Four tenants of the sizes the brief names, in one database, plus a fifth that holds 10. */
const SIZED = [
  [0, "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c90"],
  [1, "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c91"],
  [10, "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c92"],
  [1000, "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c93"],
] as const;

async function populateSized(env: GateEnv): Promise<void> {
  await env.clear();
  for (const [size, tenant] of SIZED) {
    await env.sql.unsafe(`insert into orgs (id, name, tenant_id) values ($1, 'n0', $2)`, [
      key("o", 0),
      tenant,
    ]);
    await env.sql.unsafe(`insert into labels (id, name, tenant_id) values ($1, 'n0', $2)`, [
      key("l", 0),
      tenant,
    ]);
    if (size === 0) continue;
    await env.sql.unsafe(
      `insert into projects (id, org_id, name, budget, tenant_id, starred)
         select ('01890c5a-8f0e-7c3a-9b2d-0002' || lpad(to_hex(i), 8, '0'))::uuid, $1, 'n' || i, 100 * (i % 3), $2, i % 2 = 0
         from generate_series(0, $3::int - 1) i`,
      [key("o", 0), tenant, size],
    );
    await env.sql.unsafe(
      `insert into tasks (id, project_id, title, priority, done, tenant_id)
         select ('01890c5a-8f0e-7c3a-9b2d-0003' || lpad(to_hex(i * 2 + k), 8, '0'))::uuid,
                ('01890c5a-8f0e-7c3a-9b2d-0002' || lpad(to_hex(i), 8, '0'))::uuid, 'n' || (i * 2 + k), k + 1, k = 1, $1
         from generate_series(0, $2::int - 1) i, generate_series(0, 1) k`,
      [tenant, size],
    );
    await env.sql.unsafe(
      `insert into project_labels (id, project_id, label_id, tenant_id)
         select ('01890c5a-8f0e-7c3a-9b2d-0005' || lpad(to_hex(i), 8, '0'))::uuid,
                ('01890c5a-8f0e-7c3a-9b2d-0002' || lpad(to_hex(i), 8, '0'))::uuid, $1, $2
         from generate_series(0, $3::int - 1) i`,
      [key("l", 0), tenant, size],
    );
  }
  env.drain();
}

postgresTest(
  gate,
  "statements.shape: any random read, alone or in a transaction, sends a count set by its shape",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      await populateSized(env);
      await assertGate(
        "statements.shape random reads",
        fc.asyncProperty(readOp, fc.integer({ min: 0, max: 3 }), async (op, wrap) => {
          const counts: number[] = [];
          for (const [, tenant] of SIZED) {
            const client = env.db.for({ tenantId: tenant }) as unknown as Client;
            const run = (c: Client): Promise<unknown> =>
              op.t === "page"
                ? (c[op.table] as unknown as { page(o: object): Promise<unknown> }).page({
                    orderBy: { id: "asc" },
                    limit: op.limit,
                  })
                : runLeaf(c, op);
            const { statements } = await countQueries(env.rec, () =>
              wrap === 0
                ? run(client)
                : (
                    client as unknown as {
                      tx(fn: (t: Client) => Promise<unknown>): Promise<unknown>;
                    }
                  ).tx(async (t) => {
                    for (let index = 0; index < wrap; index += 1) await run(t);
                  }),
            );
            counts.push(statements.length);
            expect(tenantProblems(statements, tenant, [], Object.values(SQL_NAME))).toEqual([]);
          }
          // One statement a read; a transaction adds BEGIN and COMMIT.
          const expected = wrap === 0 ? 1 : wrap + 2;
          expect(counts, JSON.stringify(op)).toEqual([expected, expected, expected, expected]);
        }),
        120,
      );
    });
  },
  300_000,
);

postgresTest(
  gate,
  "statements.shape: the tables the shapes ran on are the tenant tables of the gate schema",
  async () => {
    // Guards the fixture: if a table is added to the schema, a shape for it is added too.
    expect([...TENANT_TABLES]).toEqual(["orgs", "projects", "tasks", "labels", "projectLabels"]);
  },
);
