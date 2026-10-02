/**
 * Column-strategy archive rows through the shared migration plan.
 *
 * Archived rows stay in the table, so each planned alter touches them.
 * Restore is ordinary SQL: a partial unique index rejects a restore that
 * collides with an active row, and `archive_id` restores one operation.
 */

import { expect } from "bun:test";

import { withPostgresSchema } from "@okmodel/harness";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { introspectObjects } from "../catalog/introspect.js";
import { staticNamespace, type CatalogObject } from "../catalog/object.js";
import { type NamespaceBinding } from "../catalog/render.js";
import { postgresRunner } from "../catalog/runners.js";
import { quoteIdent } from "../catalog/sql.js";
import { planMigration, planSql } from "../migrations/plan.js";
import { archiveSteps } from "./build.js";
import { errorMessage, sqlState } from "./session.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const OPERATION = "00000000-0000-0000-0000-00000000000a";
const EARLIER = "00000000-0000-0000-0000-00000000000b";

postgresTest(decision, "archived rows follow migrations, then restore by archive id", async () => {
  await withPostgresSchema(async (sql, schema) => {
    const namespace = staticNamespace(schema);
    const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: schema }];
    const steps = archiveSteps(namespace, true);
    const base = steps[0]?.before;
    if (base === undefined) throw new Error("Missing archive catalog.");
    await apply(sql, [], base, bindings, []);
    await seed(sql, schema);
    for (const step of steps) {
      await apply(sql, step.before, step.after, bindings, step.renames);
    }
    const counts = await countsOf(sql, schema);
    expect(counts.active).toBe(2);
    expect(counts.archived).toBe(2);
    const ranked = await sql<{ count: string }[]>`
      select count(*)::text as count from ${sql(schema)}.tasks
      where archived_at is not null and rank = 0
    `;
    expect(ranked[0]?.count).toBe("2");
    const named = await sql<{ count: string }[]>`
      select count(*)::text as count from ${sql(schema)}.tasks where name = 'archived'
    `;
    expect(named[0]?.count).toBe("1");
    const runner = postgresRunner(sql);
    const introspected = await introspectObjects(runner, [schema], []);
    const predicate = introspected.find((object) => object.name === "tasks_email_active");
    expect(predicate?.attributes.predicate).toBe("archived_at is null");
    const parentBypass = await restoreChildWhileParentArchived(sql, schema);
    expect(parentBypass.code).toBe("");
    await sql.unsafe(
      `update ${quoteIdent(schema)}.reminders set archived_at = now(), archive_id = ${quoteUuid(EARLIER)} where id = 11`,
    );
    const conflict = await restoreOne(sql, schema, 2);
    expect(conflict.code).toBe("23505");
    await sql.unsafe(
      `update ${quoteIdent(schema)}.tasks set archived_at = null, archive_id = null where archive_id = ${quoteUuid(OPERATION)}`,
    );
    await sql.unsafe(
      `update ${quoteIdent(schema)}.reminders set archived_at = null, archive_id = null where archive_id = ${quoteUuid(OPERATION)}`,
    );
    const after = await snapshot(sql, schema);
    expect(after.tasks.find((row) => row.id === "3")?.archived).toBe(false);
    expect(after.reminders.find((row) => row.id === "10")?.archived).toBe(false);
    expect(after.reminders.find((row) => row.id === "11")?.archived).toBe(true);
    expect(after.tasks.find((row) => row.id === "2")?.archived).toBe(true);
    console.log(
      JSON.stringify({
        event: "infra-archive-restore",
        parentBypass: parentBypass.message,
        uniqueConflict: conflict.message,
      }),
    );
  });
});

postgresTest(decision, "a non-partial unique constraint sees archived duplicates", async () => {
  await withPostgresSchema(async (sql, schema) => {
    const namespace = staticNamespace(schema);
    const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: schema }];
    const steps = archiveSteps(namespace, false);
    const narrowed = steps[2];
    if (narrowed === undefined) throw new Error("Missing unique step.");
    await apply(sql, [], narrowed.before, bindings, []);
    await sql.unsafe(
      `insert into ${quoteIdent(schema)}.tasks (id, email, title, score, sku, archived_at)
       values (1, 'a@x', 'a', 1, 'same', now()), (2, 'b@x', 'b', 1, 'same', now())`,
    );
    const failed = await applyExpecting(sql, narrowed.before, narrowed.after, bindings, []);
    expect(failed.code).toBe("23505");
    console.log(
      JSON.stringify({ event: "infra-archive-unique", code: failed.code, message: failed.message }),
    );
  });
});

postgresTest(
  decision,
  "migration time over 10k and 100k rows, half archived",
  async () => {
    const results = [];
    for (const rows of [10_000, 100_000] as const) {
      results.push(await timeMigrations(rows));
    }
    console.log(JSON.stringify({ event: "infra-archive-time", results }));
    for (const result of results) {
      expect(result.active).toBe(result.rows / 2);
      expect(result.archived).toBe(result.rows / 2);
    }
  },
  180_000,
);

async function timeMigrations(rows: number): Promise<{
  readonly rows: number;
  readonly active: number;
  readonly archived: number;
  readonly steps: readonly { readonly label: string; readonly ms: number }[];
}> {
  return withPostgresSchema(async (sql, schema) => {
    const namespace = staticNamespace(schema);
    const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: schema }];
    const steps = archiveSteps(namespace, false);
    const base = steps[0]?.before;
    if (base === undefined) throw new Error("Missing archive catalog.");
    await apply(sql, [], base, bindings, []);
    await sql.unsafe(
      `insert into ${quoteIdent(schema)}.tasks (id, email, title, score, sku, archived_at, archive_id)
       select g, 'user' || g || '@x', 't', 1, 'sku-' || g,
         case when g % 2 = 0 then now() else null end,
         case when g % 2 = 0 then ${quoteUuid(OPERATION)} else null end
       from generate_series(1, ${String(rows)}) g`,
    );
    const timed: { label: string; ms: number }[] = [];
    for (const step of steps) {
      const started = performance.now();
      await apply(sql, step.before, step.after, bindings, step.renames);
      timed.push({ label: step.label, ms: performance.now() - started });
    }
    const counts = await countsOf(sql, schema);
    return { rows, active: counts.active, archived: counts.archived, steps: timed };
  });
}

async function seed(sql: Sql, schema: string): Promise<void> {
  const table = quoteIdent(schema);
  await sql.unsafe(
    `insert into ${table}.tasks (id, email, title, score, sku, archived_at, archive_id) values
      (1, 'shared@x', 'active', 1, 'sku-1', null, null),
      (2, 'shared@x', 'archived', 1, 'sku-2', now(), ${quoteUuid(EARLIER)}),
      (3, 'other@x', 'parent', 1, 'sku-3', now(), ${quoteUuid(OPERATION)}),
      (4, 'solo@x', 'solo', 1, 'sku-4', null, null)`,
  );
  await sql.unsafe(
    `insert into ${table}.reminders (id, task_id, archived_at, archive_id) values
      (10, 3, now(), ${quoteUuid(OPERATION)}),
      (11, 3, now(), ${quoteUuid(EARLIER)})`,
  );
}

async function restoreChildWhileParentArchived(
  sql: Sql,
  schema: string,
): Promise<{ readonly code: string; readonly message: string }> {
  try {
    await sql.unsafe(
      `update ${quoteIdent(schema)}.reminders set archived_at = null, archive_id = null where id = 11`,
    );
    return { code: "", message: "update succeeded while the parent was still archived" };
  } catch (error) {
    return { code: sqlState(error), message: errorMessage(error) };
  }
}

async function restoreOne(
  sql: Sql,
  schema: string,
  id: number,
): Promise<{ readonly code: string; readonly message: string }> {
  try {
    await sql.unsafe(
      `update ${quoteIdent(schema)}.tasks set archived_at = null, archive_id = null where id = ${String(id)}`,
    );
    return { code: "", message: "" };
  } catch (error) {
    return { code: sqlState(error), message: errorMessage(error) };
  }
}

async function countsOf(
  sql: Sql,
  schema: string,
): Promise<{ readonly active: number; readonly archived: number }> {
  const rows = await sql<{ active: string; archived: string }[]>`
    select count(*) filter (where archived_at is null)::text as active,
      count(*) filter (where archived_at is not null)::text as archived
    from ${sql(schema)}.tasks
  `;
  return { active: Number(rows[0]?.active ?? "0"), archived: Number(rows[0]?.archived ?? "0") };
}

async function snapshot(
  sql: Sql,
  schema: string,
): Promise<{
  readonly tasks: readonly { readonly id: string; readonly archived: boolean }[];
  readonly reminders: readonly { readonly id: string; readonly archived: boolean }[];
}> {
  const tasks = await sql<{ id: string; archived: boolean }[]>`
    select id::text as id, archived_at is not null as archived
    from ${sql(schema)}.tasks order by id
  `;
  const reminders = await sql<{ id: string; archived: boolean }[]>`
    select id::text as id, archived_at is not null as archived
    from ${sql(schema)}.reminders order by id
  `;
  return { tasks, reminders };
}

async function apply(
  sql: Sql,
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
  renames: readonly {
    readonly namespace: string;
    readonly parent: string;
    readonly from: string;
    readonly to: string;
  }[],
): Promise<void> {
  for (const statement of planSql(planMigration(before, after, bindings, renames))) {
    await sql.unsafe(statement);
  }
}

async function applyExpecting(
  sql: Sql,
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
  renames: readonly {
    readonly namespace: string;
    readonly parent: string;
    readonly from: string;
    readonly to: string;
  }[],
): Promise<{ readonly code: string; readonly message: string }> {
  try {
    await apply(sql, before, after, bindings, renames);
    return { code: "", message: "" };
  } catch (error) {
    return { code: sqlState(error), message: errorMessage(error) };
  }
}

function quoteUuid(value: string): string {
  return `'${value}'::uuid`;
}
