/**
 * OKM1550 flags a hand-written step that weakens rlsTenancy.
 *
 * Generated enable, force, and create steps stay clean. An allow needs a reason.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { global, rlsTenancy } from "../src/runtime/tenancy/index.js";
import { readMigrationPlan } from "../src/tooling/migrate/files.js";
import { lintPlan, type Finding } from "../src/tooling/migrate/lint.js";
import { parsePlan, planMigration } from "../src/tooling/migrate/plan.js";

const notes = table("notes", { id: id({ default: "none" }), title: text() });
const other = table(
  "other",
  { id: id({ default: "none" }), title: text() },
  { tenancy: global("shared") },
);
const built = schema({
  casing: "snake",
  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes, other],
});
const empty = schema({ tables: [] }).catalog;

function hand(sql: string): readonly Finding[] {
  return lintPlan(parsePlan(`-- class: expand\n\n${sql}\n`), built.catalog, built.catalog);
}

function reasons(sql: string): readonly string[] {
  return hand(sql)
    .filter((item) => item.code === "OKM1550")
    .map((item) => item.reason);
}

test("generated rls steps are not OKM1550", () => {
  const plan = planMigration({ before: empty, after: built.catalog, name: "0001_init" });
  expect(lintPlan(plan, empty, built.catalog).some((item) => item.code === "OKM1550")).toBe(false);
});

test("OKM1550 flags every way to weaken row-level security", () => {
  expect(reasons("alter table notes disable row level security")).toEqual([
    "disables row level security",
  ]);
  expect(reasons("alter table notes no force row level security")).toEqual([
    "stops forcing row level security",
  ]);
  expect(reasons("drop policy notes_tenant on notes")).toEqual(["drops a policy"]);
  expect(reasons("drop policy if exists notes_tenant on notes")).toEqual(["drops a policy"]);
  expect(reasons("create policy extra on notes using (true)")).toEqual([
    "creates a policy that matches every row",
  ]);
  expect(reasons("create policy extra on notes using(true)")).toEqual([
    "creates a policy that matches every row",
  ]);
  expect(reasons("alter policy notes_tenant on notes using (true)")).toEqual([
    "widens a policy to match every row",
  ]);
  expect(reasons("alter policy notes_tenant on notes with check (true)")).toEqual([
    "widens a policy to match every row",
  ]);
  expect(reasons("alter role app with bypassrls")).toEqual(["grants BYPASSRLS"]);
  expect(reasons("create user app bypassrls")).toEqual(["grants BYPASSRLS"]);
  expect(reasons('alter table "public"."notes" owner to app')).toEqual([
    "changes the owner of a tenant table",
  ]);
  expect(reasons("create policy extra on notes using (1=1)")).toEqual([
    "creates a policy that is not the tenant predicate",
  ]);
  expect(reasons("create policy extra on notes using ((true))")).toEqual([
    "creates a policy that is not the tenant predicate",
  ]);
  expect(reasons("create policy extra on notes using (true or false)")).toEqual([
    "creates a policy that is not the tenant predicate",
  ]);
  expect(reasons("alter policy notes_tenant on notes to public using (1=1)")).toEqual([
    "widens a policy away from the tenant predicate",
  ]);
  expect(
    reasons(
      "create policy extra on notes using (tenant_id = (nullif(current_setting('app.tenant'::text, true), ''::text))::uuid)",
    ),
  ).toEqual(["creates a policy that is not the tenant predicate"]);
  expect(reasons("create policy extra on other using (1=1)")).toEqual([]);
});

test("enable, force, and NOBYPASSRLS are not OKM1550", () => {
  expect(reasons("alter table notes enable row level security")).toEqual([]);
  expect(reasons("alter table notes force row level security")).toEqual([]);
  expect(reasons("alter role app nobypassrls")).toEqual([]);
  expect(reasons("alter role app with nobypassrls")).toEqual([]);
  expect(reasons("alter table other owner to app")).toEqual([]);
  expect(
    reasons(
      "create policy notes_tenant on notes using (tenant_id = (nullif(current_setting('app.tenant'::text, true), ''::text))::uuid)",
    ),
  ).toEqual([]);
});

test("OKM1550 sees LF, CRLF, and CR, and an allow needs a reason", () => {
  const sql = "alter table notes disable row level security;";
  for (const ending of ["\n", "\r\n", "\r"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "okm-rls-lint-"));
    const path = join(dir, "0002_hand.sql");
    writeFileSync(path, `-- class: expand${ending}${ending}${sql}${ending}`);
    try {
      const plan = readMigrationPlan(path);
      const found = lintPlan(plan, built.catalog, built.catalog).filter(
        (item) => item.code === "OKM1550",
      );
      expect(found.map((item) => item.reason)).toEqual(["disables row level security"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  expect(
    hand("-- okm-allow OKM1550: reviewed\nalter table notes disable row level security").some(
      (item) => item.code === "OKM1550",
    ),
  ).toBe(false);
  expect(
    hand("-- okm-allow OKM1550:\nalter table notes disable row level security").some(
      (item) => item.code === "OKM1510",
    ),
  ).toBe(true);
});
