/**
 * Random compositions of presets never reach a tenant table without the
 * tenant predicate, and never see archived rows or another tenant's rows.
 *
 * Statement text and results are checked on PGlite for reads. Writes are
 * checked on the statement text. The recorded rules go through
 * `safety.property` with the presets rule registered. Real Postgres is
 * `presets-pg.test.ts`.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { connect } from "../src/runtime/pg/pglite.js";
import {
  registerPresets,
  registerTenancy,
  safetyProperty,
  type SafetyInput,
} from "../src/runtime/safety/index.js";
import { ADA, GRACE, TENANT_A, TENANT_B, rowId, tenantApp } from "./presets-schema.js";

type Use =
  | readonly ["pending"]
  | readonly ["urgent"]
  | readonly ["flagged"]
  | readonly ["ownedBy", string]
  | readonly ["mineOrOpen", string]
  | readonly ["inState", ...string[]];

const owner = fc.constantFrom(ADA, GRACE);
const uses: fc.Arbitrary<Use> = fc.oneof(
  fc.constant(["pending"] as const),
  fc.constant(["urgent"] as const),
  fc.constant(["flagged"] as const),
  owner.map((who) => ["ownedBy", who] as const),
  owner.map((who) => ["mineOrOpen", who] as const),
  fc
    .array(fc.constantFrom("pending", "open", "done"), { minLength: 1, maxLength: 3 })
    .map((states) => ["inState", ...states] as const),
);
const chains = fc.array(uses, { maxLength: 5 });
const reads = fc.constantFrom("find", "count", "exists", "one", "aggregate", "page");
const writes = fc.constantFrom("update", "delete", "archive");

async function open() {
  const pool = await openPglite();
  for (const statement of renderCatalog(tenantApp.catalog, "public")) {
    await pool.execute(statement);
  }
  const db = await connect(pool, { schema: tenantApp });
  await db.connected;
  const a = db.for({ tenantId: TENANT_A });
  const b = db.for({ tenantId: TENANT_B });
  const seed = [
    { n: 1, status: "pending", owner: ADA, priority: 1 },
    { n: 2, status: "pending", owner: GRACE, priority: 4 },
    { n: 3, status: "open", owner: ADA, priority: 5 },
    { n: 4, status: "done", owner: GRACE, priority: 3 },
  ];
  for (const item of seed) {
    for (const [client, mark] of [
      [a, "a"],
      [b, "b"],
    ] as const) {
      await client.tasks.insert({
        id: rowId(item.n),
        title: `${mark}${String(item.n)}`,
        status: item.status,
        ownerId: item.owner,
        priority: item.priority,
      });
    }
  }
  await a.tasks.archive({ where: { id: rowId(4) } });
  return { db, a, pool };
}

type Scoped = Awaited<ReturnType<typeof open>>["a"];

function compose(client: Scoped, chain: readonly Use[]) {
  // The preset names are the keys of the table handle; each call returns a handle.
  let handle: Record<string, (...args: string[]) => unknown> = client.tasks as never;
  for (const [name, ...args] of chain) {
    handle = handle[name]?.(...args) as never;
  }
  return handle as unknown as Scoped["tasks"];
}

function statementsOf(planned: unknown): { text: string; params: readonly unknown[] }[] {
  const value = planned as {
    text?: string;
    params?: readonly unknown[];
    statements?: { text: string; params: readonly unknown[] }[];
  };
  return value.statements ?? [{ text: value.text ?? "", params: value.params ?? [] }];
}

function holdsTenant(statement: { text: string; params: readonly unknown[] }): boolean {
  const found = /t\."tenant_id" = \$(\d+)/.exec(statement.text);
  return found?.[1] !== undefined && statement.params[Number(found[1]) - 1] === TENANT_A;
}

test("random preset compositions keep the tenant predicate and the active set", async () => {
  const { db, a, pool } = await open();
  const stop = [registerPresets(), registerTenancy()];
  try {
    await fc.assert(
      fc.asyncProperty(chains, reads, async (chain, read) => {
        const handle = compose(a, chain);
        const query =
          read === "find"
            ? handle.find({ limit: 20 })
            : read === "count"
              ? handle.count()
              : read === "exists"
                ? handle.exists()
                : read === "one"
                  ? handle.one({ where: { id: rowId(1) } })
                  : read === "aggregate"
                    ? handle.aggregate({ count: true })
                    : handle.page({ orderBy: { title: "asc" }, limit: 5 });
        const planned = (await query.sql()) as never;
        for (const statement of statementsOf(planned)) {
          expect(holdsTenant(statement)).toBe(true);
          expect(statement.text).toContain('t."archived_at" is null');
        }

        const inspected = await query.inspect();
        expect(inspected.rules.some((rule) => rule.rule === "tenancy")).toBe(true);
        const names = inspected.rules.filter((rule) => rule.rule === "preset");
        expect(names).toHaveLength(chain.length);
        const input: SafetyInput = { contributions: inspected.rules };
        expect(safetyProperty([input])[0]).toEqual([]);
      }),
      { numRuns: 120 },
    );
  } finally {
    for (const undo of stop) undo();
    await db.close();
    await pool.close();
  }
});

test("random preset compositions never return another tenant's or an archived row", async () => {
  const { db, a, pool } = await open();
  try {
    await fc.assert(
      fc.asyncProperty(chains, async (chain) => {
        const rows = await compose(a, chain).find({ limit: 50 });
        for (const row of rows) {
          expect(row.tenantId).toBe(TENANT_A);
          expect(row.archivedAt).toBeNull();
          expect(row.title.startsWith("a")).toBe(true);
        }
        const plain = await a.tasks.find({ limit: 50 });
        expect(rows.length).toBeLessThanOrEqual(plain.length);
        expect(await compose(a, chain).count()).toBe(rows.length);
      }),
      { numRuns: 80 },
    );
  } finally {
    await db.close();
    await pool.close();
  }
});

test("random preset compositions keep the tenant predicate on writes", async () => {
  const { db, a, pool } = await open();
  try {
    await fc.assert(
      fc.asyncProperty(chains, writes, async (chain, write) => {
        const handle = compose(a, chain);
        const target = { where: { id: rowId(1) } };
        const planned =
          write === "update"
            ? handle.update({ ...target, set: { title: "x" } })
            : write === "delete"
              ? handle.delete(target)
              : handle.archive(target);
        for (const statement of statementsOf(await planned.sql())) {
          expect(holdsTenant(statement)).toBe(true);
          expect(statement.text).toContain('t."archived_at" is null');
          expect(statement.text).toContain('t."id" = $');
        }
      }),
      { numRuns: 80 },
    );
  } finally {
    await db.close();
    await pool.close();
  }
});

test("the presets rule rejects a contribution that removes or replaces a predicate", () => {
  const stop = registerPresets();
  try {
    const line = (contribution: string): SafetyInput => ({
      contributions: [{ rule: "preset", contribution, provenance: "table tasks" }],
    });
    const verdicts = safetyProperty([
      line("pending filters status"),
      line("pending removed tenancy"),
      line("pending replaced where"),
    ]);
    expect(verdicts[0]).toEqual([]);
    expect(verdicts[1]?.[0]?.detail).toBe(
      "A preset adds predicates. It cannot remove or replace one.",
    );
    expect(verdicts[2]?.length).toBe(1);
  } finally {
    stop();
  }
});
