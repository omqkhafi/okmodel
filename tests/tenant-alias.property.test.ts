/**
 * QA-S4: every tenant-table alias in compiled SQL carries the tenant predicate.
 *
 * Random where, include, aggregate, page, and batch shapes. A global table has
 * no alias to check. An insert names the tenant column instead of a where.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import type { DriverPool } from "../src/contracts/driver.js";
import { eq, has, not, or } from "../src/dialects/pg/index.js";
import { tag } from "../src/dialects/pg/operators.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { effectivePredicate } from "../src/runtime/plan.js";
import { assertGate } from "./gate-property.js";
import { app, ORG, TASK, TENANT_A } from "./tenancy-schema.js";

const TENANT = new Set(["orgs", "tasks"]);

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
    prepared: "unnamed",
    describe: false,
  },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

const where = fc.oneof(
  fc.constant(undefined),
  fc.constant({}),
  fc.constant({ title: undefined }),
  fc.constant({ title: "ship" }),
  fc.constant({ id: TASK, title: undefined }),
  fc.constant(or([{ title: "ship" }, { code: "a" }])),
  fc.constant({ title: eq("ship") }),
  fc.constant({ title: not("secret") }),
  fc.constant(tag("and", [{ title: "ship" }, { code: undefined }])),
  fc.constant({ org: has({ name: "Acme" }) }),
);

const kind = fc.constantFrom(
  "find",
  "include",
  "nested",
  "aggregate",
  "page",
  "batch",
) as fc.Arbitrary<"find" | "include" | "nested" | "aggregate" | "page" | "batch">;

function textsOf(value: unknown): string[] {
  if (value !== null && typeof value === "object" && "text" in value) {
    return [String((value as { text: unknown }).text)];
  }
  if (value !== null && typeof value === "object" && "statements" in value) {
    const statements = (value as { statements: readonly { text: string }[] }).statements;
    return statements.map((statement) => statement.text);
  }
  return [];
}

function aliases(sql: string): readonly { readonly table: string; readonly alias: string }[] {
  const found: { table: string; alias: string }[] = [];
  const pattern =
    /(?:from|join|update|delete from)\s+"([^"]+)"(?:\s+as)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const match of sql.matchAll(pattern)) {
    const table = match[1];
    const alias = match[2];
    if (table !== undefined && alias !== undefined) found.push({ table, alias });
  }
  return found;
}

function tenantOnEveryAlias(sql: string): void {
  if (sql.startsWith("insert into")) {
    const table = /insert into "([^"]+)"/.exec(sql)?.[1];
    if (table !== undefined && TENANT.has(table)) expect(sql).toContain('"tenant_id"');
    return;
  }
  for (const { table, alias } of aliases(sql)) {
    if (!TENANT.has(table)) continue;
    expect(sql).toContain(`${alias}."tenant_id"`);
  }
}

test("QA-S4: tenant SQL keeps the predicate on every table alias", async () => {
  const db = connect(pool, { schema: app });
  await db.connected;
  const scoped = db.for({ tenantId: TENANT_A });
  await assertGate(
    "QA-S4",
    fc.asyncProperty(kind, where, async (op, filter) => {
      const clause = filter === undefined ? {} : { where: filter };
      const pending =
        op === "find"
          ? scoped.tasks.find({ ...clause, limit: 2 }).sql()
          : op === "include"
            ? scoped.tasks.find({ ...clause, limit: 1, include: { org: true } }).sql()
            : op === "nested"
              ? scoped.orgs.find({ limit: 1, include: { tasks: { limit: 2, ...clause } } }).sql()
              : op === "aggregate"
                ? scoped.tasks.aggregate({ count: true, ...clause }).sql()
                : op === "page"
                  ? scoped.tasks.page({ limit: 2, orderBy: { title: "asc" }, ...clause }).sql()
                  : Promise.all([
                      scoped.tasks.insert({ id: TASK, title: "ship", code: "a", orgId: ORG }).sql(),
                      scoped.tasks
                        .update({
                          where: effectivePredicate(filter) ? filter : { id: TASK },
                          set: { title: "next" },
                        })
                        .sql(),
                      scoped.tasks
                        .delete({ where: effectivePredicate(filter) ? filter : { id: TASK } })
                        .sql(),
                    ]);
      const value = await pending;
      const texts = Array.isArray(value) ? value.flatMap(textsOf) : textsOf(value);
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) tenantOnEveryAlias(text);
    }),
    24,
  );
});
