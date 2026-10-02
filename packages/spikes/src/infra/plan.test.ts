/**
 * Planner behaviour for roles, grants, and partial indexes.
 *
 * These tests do not need Postgres. They check that the shared diff and plan
 * accept the new kinds, and where that plan is a special case.
 */

import { expect, test } from "bun:test";

import { assertCatalog } from "../catalog/graph.js";
import { staticNamespace, type ExtensionObject } from "../catalog/object.js";
import { diffCatalog } from "../migrations/diff.js";
import { planMigration, planSql } from "../migrations/plan.js";
import { type NamespaceBinding } from "../catalog/render.js";
import {
  appNamespace,
  grant,
  partialIndexCatalog,
  privilegeRoundTrip,
  privilegeScale,
  role,
} from "./build.js";

const namespace = appNamespace();
const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: "app" }];

test("roles, grants, and default privileges plan through the shared catalog", () => {
  const catalog = privilegeRoundTrip(namespace, "mig", "app");
  const sql = planSql(planMigration([], catalog, bindings));
  expect(sql).toContain('create role "mig" nologin inherit');
  expect(sql).toContain('create role "app" nologin inherit');
  expect(sql.some((statement) => statement.startsWith('grant select on table "app"."tasks"'))).toBe(
    true,
  );
  expect(
    sql.some((statement) =>
      statement.startsWith(
        'alter default privileges for role "mig" in schema "app" grant select on tables to "app"',
      ),
    ),
  ).toBe(true);
  const roleAt = sql.findIndex((statement) => statement.startsWith("create role"));
  const grantAt = sql.findIndex((statement) => statement.startsWith("grant "));
  expect(roleAt).toBeGreaterThanOrEqual(0);
  expect(grantAt).toBeGreaterThan(roleAt);
});

test("an external role is not created or dropped", () => {
  const catalog = privilegeRoundTrip(namespace, "mig", "app", "external", "external");
  const created = planSql(planMigration([], catalog, bindings));
  expect(created.some((statement) => statement.includes("create role"))).toBe(false);
  expect(created.some((statement) => statement.startsWith("grant select"))).toBe(true);
  const dropped = planSql(planMigration([role("mig", "external", false)], [], bindings));
  expect(dropped).toEqual([]);
});

test("a managed role attribute change is ALTER ROLE", () => {
  const before = [role("mig", "managed", false)];
  const after = [role("mig", "managed", true)];
  expect(planSql(planMigration(before, after, bindings))).toEqual([
    'alter role "mig" login inherit',
  ]);
});

test("an extension version change is ALTER EXTENSION UPDATE, not drop and create", () => {
  const before = extension("1.4");
  const after = extension("1.6");
  expect(planSql(planMigration([before], [after], bindings))).toEqual([
    `alter extension "citext" update to '1.6'`,
  ]);
});

test("an extension schema change is ALTER EXTENSION SET SCHEMA", () => {
  const before = extension(undefined, "public");
  const after = extension(undefined, "extensions");
  expect(planSql(planMigration([before], [after], bindings))).toEqual([
    'alter extension "citext" set schema "extensions"',
  ]);
});

test("renaming a column named by a partial index recreates that index", () => {
  const before = partialIndexCatalog(namespace, "archived_at");
  const after = partialIndexCatalog(namespace, "hidden_at");
  const sql = planSql(
    planMigration(before, after, bindings, [
      { namespace: "app", parent: "tasks", from: "archived_at", to: "hidden_at" },
    ]),
  );
  expect(
    sql.some((statement) => statement.startsWith('drop index "app"."tasks_email_active"')),
  ).toBe(true);
  expect(sql.some((statement) => statement.includes("where (hidden_at is null)"))).toBe(true);
  const dropAt = sql.findIndex((statement) => statement.startsWith("drop index"));
  const renameAt = sql.findIndex((statement) => statement.includes("rename column"));
  const createAt = sql.findIndex((statement) => statement.includes("where (hidden_at is null)"));
  expect(dropAt).toBeLessThan(renameAt);
  expect(renameAt).toBeLessThan(createAt);
});

test("a grant name may exceed 63 bytes", () => {
  const longRole = "r".repeat(60);
  const object = grant(namespace, "tasks", "table", longRole, "references", []);
  expect(object.identity.name.length).toBeGreaterThan(63);
  expect(() => assertCatalog([object], { partial: true })).not.toThrow();
});

test("diff of 50 roles and 1000 grants stays on the identity key", () => {
  const catalog = privilegeScale(staticNamespace("app"), "p08scale");
  const grants = catalog.filter((object) => object.kind === "grant");
  expect(grants).toHaveLength(1000);
  const started = performance.now();
  const same = diffCatalog(catalog, catalog);
  const sameMs = performance.now() - started;
  const withoutOne = catalog.filter((object) => object !== grants[0]);
  const changedStarted = performance.now();
  const changed = diffCatalog(withoutOne, catalog);
  const changedMs = performance.now() - changedStarted;
  expect(same.create).toHaveLength(0);
  expect(same.drop).toHaveLength(0);
  expect(changed.create).toHaveLength(1);
  expect(changed.drop).toHaveLength(0);
  console.log(
    JSON.stringify({
      event: "infra-diff",
      roles: 50,
      grants: 1000,
      sameMs,
      changedMs,
    }),
  );
});

function extension(version?: string, schema?: string): ExtensionObject {
  return {
    kind: "extension",
    identity: { kind: "extension", name: "citext" },
    owner: "managed",
    definition: {
      name: "citext",
      ...(version === undefined ? {} : { version }),
      ...(schema === undefined ? {} : { schema }),
    },
    dependencies: [],
    provenance: { source: "infra" },
  };
}
