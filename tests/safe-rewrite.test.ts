/**
 * Safe rewrites for a table that already exists (D193).
 *
 * A new table keeps the plain statements. Exact SQL for each rewrite is
 * pinned here. Postgres applies the same plans in `safe-rewrite-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import { lintPlan } from "../src/tooling/migrate/lint.js";
import {
  formatPlan,
  parsePlan,
  planMigration,
  type PlanStep,
} from "../src/tooling/migrate/plan.js";

const tasks = () => table("tasks", { id: t.identity(), title: t.text() });

test("an index on an existing table is created and dropped concurrently", () => {
  const indexed = table(
    "tasks",
    { id: t.identity(), title: t.text() },
    { indexes: (columns) => [index(columns.title)] },
  );
  const added = planMigration({
    before: schema({ tables: [tasks()] }).catalog,
    after: schema({ tables: [indexed] }).catalog,
    name: "index",
  });
  expect(sqlOf(added.steps)).toEqual([
    'create index concurrently "tasks_title_idx" on "public"."tasks" ("title")',
  ]);
  expect(added.steps[0]).toMatchObject({
    kind: "create-index",
    class: "expand",
    lock: "SHARE UPDATE EXCLUSIVE",
    transactional: false,
  });

  const dropped = planMigration({
    before: schema({ tables: [indexed] }).catalog,
    after: schema({ tables: [tasks()] }).catalog,
    name: "drop-index",
  });
  expect(sqlOf(dropped.steps)).toEqual(['drop index concurrently "public"."tasks_title_idx"']);
  expect(dropped.steps[0]).toMatchObject({
    kind: "drop-index",
    lock: "SHARE UPDATE EXCLUSIVE",
    transactional: false,
  });
});

test("a check and a foreign key on an existing table are NOT VALID, then validated", () => {
  const open = table("tasks", { id: t.identity(), title: t.text() });
  const checked = table("tasks", { id: t.identity(), title: t.text().picklist(["a", "b"]) });
  const check = planMigration({
    before: schema({ tables: [open] }).catalog,
    after: schema({ tables: [checked] }).catalog,
    name: "check",
  });
  expect(sqlOf(check.steps)).toEqual([
    `alter table "public"."tasks" add constraint "tasks_title_check" check ((title IN ('a', 'b'))) not valid`,
    'alter table "public"."tasks" validate constraint "tasks_title_check"',
  ]);
  expect(check.steps.map((step) => step.kind)).toEqual(["add-constraint", "validate-constraint"]);
  expect(check.steps.map((step) => step.lock)).toEqual([
    "ACCESS EXCLUSIVE",
    "SHARE UPDATE EXCLUSIVE",
  ]);

  const users = table("users", { id: t.identity() });
  const before = table("tasks", { id: t.identity(), ownerId: t.bigint() });
  const after = table("tasks", { id: t.identity(), ownerId: t.bigint().references("users") });
  const foreign = planMigration({
    before: schema({ tables: [users, before] }).catalog,
    after: schema({ tables: [users, after] }).catalog,
    name: "fk",
  });
  expect(sqlOf(foreign.steps)).toEqual([
    'alter table "public"."tasks" add constraint "tasks_ownerId_fkey" foreign key ("ownerId") references "public"."users" ("id") not valid',
    'alter table "public"."tasks" validate constraint "tasks_ownerId_fkey"',
  ]);
  expect(foreign.steps[0]?.lock).toBe('ACCESS EXCLUSIVE; SHARE ROW EXCLUSIVE on "public"."users"');
  expect(foreign.steps[1]?.lock).toBe('SHARE UPDATE EXCLUSIVE; ROW SHARE on "public"."users"');
  expect(foreign.steps[1]?.kind).toBe("validate-constraint");
});

test("SET NOT NULL on an existing column goes through a validated check", () => {
  const loose = table("tasks", { id: t.identity(), title: t.text().nullable() });
  const tight = table("tasks", { id: t.identity(), title: t.text() });
  const plan = planMigration({
    before: schema({ tables: [loose] }).catalog,
    after: schema({ tables: [tight] }).catalog,
    name: "not-null",
  });
  expect(sqlOf(plan.steps)).toEqual([
    'alter table "public"."tasks" add constraint "tasks_title_notnull" check ("title" is not null) not valid',
    'alter table "public"."tasks" validate constraint "tasks_title_notnull"',
    'alter table "public"."tasks" alter column "title" set not null',
    'alter table "public"."tasks" drop constraint "tasks_title_notnull"',
  ]);
  expect(plan.steps.map((step) => step.kind)).toEqual([
    "add-constraint",
    "validate-constraint",
    "set-not-null",
    "drop-not-null-check",
  ]);
  expect(plan.steps.map((step) => step.lock)).toEqual([
    "ACCESS EXCLUSIVE",
    "SHARE UPDATE EXCLUSIVE",
    "ACCESS EXCLUSIVE",
    "ACCESS EXCLUSIVE",
  ]);
  expect(plan.class).toBe("contract");
});

test("a volatile default on an existing table is split, and a stable default is not", () => {
  const before = tasks();
  const volatile = table("tasks", {
    id: t.identity(),
    title: t.text(),
    token: t.uuid().defaultSql("gen_random_uuid()"),
  });
  const split = planMigration({
    before: schema({ tables: [before] }).catalog,
    after: schema({ tables: [volatile] }).catalog,
    name: "volatile",
  });
  expect(sqlOf(split.steps)).toEqual([
    'alter table "public"."tasks" add column "token" uuid',
    'alter table "public"."tasks" alter column "token" set default gen_random_uuid()',
    'update "public"."tasks" set "token" = gen_random_uuid() where "token" is null and ($1::text is null or "id" > $1::bigint) and ($2::text is null or "id" <= $2::bigint)',
    'alter table "public"."tasks" add constraint "tasks_token_notnull" check ("token" is not null) not valid',
    'alter table "public"."tasks" validate constraint "tasks_token_notnull"',
    'alter table "public"."tasks" alter column "token" set not null',
    'alter table "public"."tasks" drop constraint "tasks_token_notnull"',
  ]);
  expect(split.steps[2]).toMatchObject({
    kind: "backfill-expand",
    action: "backfill",
    lock: "ROW EXCLUSIVE",
  });
  expect(split.steps[5]?.kind).toBe("add-column");
  expect(split.class).toBe("expand");

  const nullable = table("tasks", {
    id: t.identity(),
    title: t.text(),
    token: t.uuid().nullable().defaultSql("uuidv7()"),
  });
  const optional = planMigration({
    before: schema({ tables: [before] }).catalog,
    after: schema({ tables: [nullable] }).catalog,
    name: "optional",
  });
  expect(sqlOf(optional.steps)).toEqual([
    'alter table "public"."tasks" add column "token" uuid',
    'alter table "public"."tasks" alter column "token" set default uuidv7()',
    'update "public"."tasks" set "token" = uuidv7() where "token" is null and ($1::text is null or "id" > $1::bigint) and ($2::text is null or "id" <= $2::bigint)',
  ]);

  const stamped = table("tasks", {
    id: t.identity(),
    title: t.text(),
    at: t.timestamptz().defaultSql("now()"),
  });
  const stable = planMigration({
    before: schema({ tables: [before] }).catalog,
    after: schema({ tables: [stamped] }).catalog,
    name: "stable",
  });
  expect(sqlOf(stable.steps)).toEqual([
    'alter table "public"."tasks" add column "at" timestamptz not null default now()',
  ]);

  const mint = fn("mint", {
    returns: "uuid",
    language: "sql",
    volatility: "volatile",
    body: "select gen_random_uuid()",
  });
  const called = table("tasks", {
    id: t.identity(),
    title: t.text(),
    token: t.uuid().nullable().defaultSql("mint()"),
  });
  const fromCatalog = planMigration({
    before: schema({ tables: [before], functions: [mint] }).catalog,
    after: schema({ tables: [called], functions: [mint] }).catalog,
    name: "fn",
  });
  expect(sqlOf(fromCatalog.steps).some((sql) => sql.startsWith("update "))).toBe(true);

  const steady = fn("steady", {
    returns: "timestamptz",
    language: "sql",
    volatility: "stable",
    body: "select now()",
  });
  const steadyColumn = table("tasks", {
    id: t.identity(),
    title: t.text(),
    at: t.timestamptz().defaultSql("steady()"),
  });
  const plain = planMigration({
    before: schema({ tables: [before], functions: [steady] }).catalog,
    after: schema({ tables: [steadyColumn], functions: [steady] }).catalog,
    name: "steady",
  });
  expect(sqlOf(plain.steps)).toEqual([
    'alter table "public"."tasks" add column "at" timestamptz not null default steady()',
  ]);
});

test("a unique constraint and a primary key on an existing table use a concurrent unique index", () => {
  const before = tasks();
  const unique = table("tasks", { id: t.identity(), title: t.text().unique() });
  const keyed = planMigration({
    before: schema({ tables: [before] }).catalog,
    after: schema({ tables: [unique] }).catalog,
    name: "unique",
  });
  expect(sqlOf(keyed.steps)).toEqual([
    'create unique index concurrently "tasks_title_key" on "public"."tasks" ("title")',
    'alter table "public"."tasks" add constraint "tasks_title_key" unique using index "tasks_title_key"',
  ]);
  expect(keyed.steps[0]).toMatchObject({
    kind: "create-index",
    lock: "SHARE UPDATE EXCLUSIVE",
    transactional: false,
  });
  expect(keyed.steps[1]).toMatchObject({
    kind: "add-constraint",
    lock: "ACCESS EXCLUSIVE",
    transactional: true,
  });

  const plain = table("items", { id: t.integer(), title: t.text() });
  const primary = table("items", { id: t.integer().primaryKey(), title: t.text() });
  const key = planMigration({
    before: schema({ tables: [plain] }).catalog,
    after: schema({ tables: [primary] }).catalog,
    name: "pkey",
  });
  expect(sqlOf(key.steps)).toEqual([
    'create unique index concurrently "items_pkey" on "public"."items" ("id")',
    'alter table "public"."items" add constraint "items_pkey" primary key using index "items_pkey"',
  ]);
});

test("a new table keeps the plain statements", () => {
  const created = schema({
    tables: [
      table(
        "tasks",
        {
          id: t.identity(),
          title: t.text().unique(),
          token: t.uuid().defaultSql("gen_random_uuid()"),
          label: t.text().picklist(["a"]),
        },
        { indexes: (columns) => [index(columns.title)] },
      ),
    ],
  });
  const plan = planMigration({ before: catalog([]), after: created.catalog, name: "create" });
  const text = sqlOf(plan.steps).join("\n");
  expect(text).not.toContain("concurrently");
  expect(text).not.toContain("not valid");
  expect(text).not.toContain("validate constraint");
  expect(text).toContain("default gen_random_uuid()");
  expect(text).toContain('create index "tasks_title_idx"');
  expect(text).toContain('add constraint "tasks_title_key" unique ("title")');
});

test("a generated plan with every rewrite has no locking error, and hand-written SQL does", () => {
  const users = table("users", { id: t.identity() });
  const before = table("tasks", {
    id: t.identity(),
    title: t.text().nullable(),
    ownerId: t.bigint(),
  });
  const after = table(
    "tasks",
    {
      id: t.identity(),
      title: t.text().picklist(["a", "b"]),
      ownerId: t.bigint().references("users"),
      code: t.text().unique(),
      token: t.uuid().defaultSql("gen_random_uuid()"),
    },
    { indexes: (columns) => [index(columns.title)] },
  );
  const plan = planMigration({
    before: schema({ tables: [users, before] }).catalog,
    after: schema({ tables: [users, after] }).catalog,
    name: "all",
  });
  const findings = lintPlan(
    plan,
    schema({ tables: [users, before] }).catalog,
    schema({ tables: [users, after] }).catalog,
  );
  const locking = findings.filter((item) => item.code >= "OKM1534" && item.code <= "OKM1537");
  expect(locking).toEqual([]);
  expect(findings.map((item) => item.code)).toContain("OKM1528");
  expect(findings.map((item) => item.code)).toContain("OKM1531");
  expect(findings.map((item) => item.code)).toContain("OKM1532");

  const hand = parsePlan(
    [
      "-- class: expand",
      "-- name: hand",
      "",
      "-- class: expand",
      "-- kind: create-index",
      "-- action: ddl",
      "-- lock: SHARE",
      'create index "tasks_title_idx" on "public"."tasks" ("title");',
      "",
      "-- class: expand",
      "-- kind: create-index",
      "-- action: ddl",
      "-- lock: SHARE",
      "-- okm-allow OKM1534: the table is empty in this window",
      'create index "tasks_code_idx" on "public"."tasks" ("code");',
      "",
    ].join("\n"),
  );
  const existing = schema({ tables: [tasks()] }).catalog;
  const handFindings = lintPlan(hand, existing, existing);
  expect(
    handFindings.filter((item) => item.code === "OKM1534").map((item) => item.severity),
  ).toEqual(["error"]);
  expect(handFindings.some((item) => item.place === "step 2" && item.code === "OKM1534")).toBe(
    false,
  );
});

test("safe plans round-trip through the plan text", () => {
  const plan = planMigration({
    before: schema({ tables: [tasks()] }).catalog,
    after: schema({
      tables: [
        table("tasks", {
          id: t.identity(),
          title: t.text(),
          token: t.uuid().defaultSql("gen_random_uuid()"),
        }),
      ],
    }).catalog,
    name: "round",
  });
  const parsed = parsePlan(formatPlan(plan));
  expect(parsed.steps.map((step) => step.kind)).toEqual(plan.steps.map((step) => step.kind));
  expect(parsed.steps.map((step) => step.transactional)).toEqual(
    plan.steps.map((step) => step.transactional),
  );
  expect(parsed.steps.map((step) => step.lock)).toEqual(plan.steps.map((step) => step.lock));
});

function sqlOf(steps: readonly PlanStep[]): readonly string[] {
  return steps.map((step) => step.sql);
}
