/**
 * Column grants, the reporting role, and table ownership without a database.
 *
 * A schema that does not use them keeps the grant SQL it had before.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { catalogHash, startupCatalog, startupHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, t, withOwner } from "../src/dialects/pg/index.js";
import { rlsTenancy } from "../src/runtime/tenancy/index.js";
import { stampOwnership } from "../src/dialects/pg/owner.js";
import { RoleDeclarationError, attachRoles } from "../src/dialects/pg/role/index.js";
import type { TableExposure } from "../src/dialects/pg/role/index.js";
import { view } from "../src/dialects/pg/view/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const roles = { migration: "mig", app: "app", managed: [{ name: "mig" }] };

test("roles without the new fields emit the same grants", () => {
  const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
  const after = attachRoles(schema({ tables: [tasks] }).catalog, roles);
  const sql = planMigration({ before: catalog([]), after, name: "roles" }).steps.map(
    (step) => step.sql,
  );
  expect(sql).toEqual([
    'create role "mig" with nosuperuser nocreatedb nocreaterole inherit nologin',
    'alter default privileges for role "mig" in schema "public" grant execute on functions to "app"',
    'alter default privileges for role "mig" in schema "public" grant select on sequences to "app"',
    'alter default privileges for role "mig" in schema "public" grant usage on sequences to "app"',
    'alter default privileges for role "mig" in schema "public" grant delete on tables to "app"',
    'alter default privileges for role "mig" in schema "public" grant insert on tables to "app"',
    'alter default privileges for role "mig" in schema "public" grant select on tables to "app"',
    'alter default privileges for role "mig" in schema "public" grant update on tables to "app"',
    'create table "public"."tasks" (\n  "id" text not null,\n  "title" text not null,\n  constraint "tasks_pkey" primary key ("id")\n)',
    'grant delete on table "public"."tasks" to "app"',
    'grant insert on table "public"."tasks" to "app"',
    'grant select on table "public"."tasks" to "app"',
    'grant update on table "public"."tasks" to "app"',
  ]);
});

test("a column grant names columns and refuses one that is not there", () => {
  const people = table("people", { email: t.text(), status: t.text() });
  const declared = schema({ tables: [people] }).catalog;
  const after = attachRoles(declared, {
    ...roles,
    columns: [{ role: "reader", on: "people", select: ["email"], update: ["status"] }],
  });
  const sql = planMigration({ before: catalog([]), after, name: "columns" }).steps.map(
    (step) => step.sql,
  );
  expect(sql).toContain('grant select ("email") on table "public"."people" to "reader"');
  expect(sql).toContain('grant update ("status") on table "public"."people" to "reader"');
  const again = planMigration({ before: after, after, name: "same" });
  expect(again.steps).toEqual([]);
  expect(() =>
    attachRoles(declared, {
      ...roles,
      columns: [{ role: "reader", on: "people", select: ["missing"] }],
    }),
  ).toThrow(OkmError);
  try {
    attachRoles(declared, {
      ...roles,
      columns: [{ role: "reader", on: "missing", select: ["email"] }],
    });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    expect((error as OkmError).code).toBe("OKM1020");
  }
});

test("the reporting role gets select, and a hidden column only when named", () => {
  const people = table("people", { email: t.text(), secret: t.text().hidden() });
  const built = schema({ tables: [people] });
  const exposure: TableExposure[] = [
    {
      table: "people",
      columns: [
        { field: "email", sql: "email", hidden: false },
        { field: "secret", sql: "secret", hidden: true },
      ],
    },
  ];
  const after = attachRoles(
    built.catalog,
    { ...roles, reporting: "report", managed: [{ name: "mig" }, { name: "report", login: true }] },
    exposure,
  );
  const sql = planMigration({ before: catalog([]), after, name: "report" }).steps.map(
    (step) => step.sql,
  );
  expect(sql).toContain('grant usage on schema "public" to "report"');
  expect(sql).toContain(
    'alter default privileges for role "mig" in schema "public" grant select on tables to "report"',
  );
  expect(sql).toContain('grant select ("email") on table "public"."people" to "report"');
  expect(sql).toContain('revoke select on table "public"."people" from "report"');
  expect(
    sql.some(
      (step) => /grant (insert|update|delete|execute)/.test(step) && step.endsWith('to "report"'),
    ),
  ).toBe(false);
  const opened = attachRoles(
    built.catalog,
    {
      ...roles,
      reporting: "report",
      columns: [{ role: "report", on: "people", select: ["secret"] }],
    },
    exposure,
  );
  const openedSql = planMigration({ before: catalog([]), after: opened, name: "open" }).steps.map(
    (step) => step.sql,
  );
  expect(openedSql).toContain(
    'grant select ("email", "secret") on table "public"."people" to "report"',
  );
  expect(() =>
    attachRoles(built.catalog, {
      ...roles,
      reporting: "report",
      columns: [{ role: "report", on: "people", update: ["email"] }],
    }),
  ).toThrow(RoleDeclarationError);
  try {
    attachRoles(built.catalog, { ...roles, reporting: "app" });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(RoleDeclarationError);
    expect((error as RoleDeclarationError).reason).toBe("reporting_distinct");
  }
});

test("a listed column grant replaces select on a view", () => {
  const people = table("people", { id: t.text().primaryKey(), secret: t.text() });
  const notes = view("notes", {
    columns: [
      { name: "id", type: "text" },
      { name: "secret", type: "text" },
    ],
    query: "select id, secret from people",
  });
  const declared = schema({ tables: [people], views: [notes] }).catalog;
  const after = attachRoles(declared, {
    ...roles,
    reporting: "report",
    columns: [{ role: "report", on: "notes", select: ["id"] }],
  });
  const sql = planMigration({ before: catalog([]), after, name: "view" }).steps.map(
    (step) => step.sql,
  );
  expect(sql).toContain('grant select ("id") on table "public"."notes" to "report"');
  expect(sql.some((step) => step === 'grant select on table "public"."notes" to "report"')).toBe(
    false,
  );
});

test("ignored and external tables are not created, altered, or dropped", () => {
  const people = withOwner(
    table("people", { id: t.text().primaryKey(), name: t.text() }),
    "ignored",
  );
  const built = schema({ tables: [people] });
  const stamped = stampOwnership(built.catalog, new Map([["people", "ignored"]]));
  expect(startupCatalog(built.catalog)).toBe(built.catalog);
  expect(startupHash(stamped)).toBe(startupHash(built.catalog));
  expect(planMigration({ before: catalog([]), after: stamped, name: "skip" }).steps).toEqual([]);
  expect(planMigration({ before: built.catalog, after: stamped, name: "mark" }).steps).toEqual([]);
  const dropped = planMigration({
    before: built.catalog,
    after: catalog([]),
    name: "drop",
  }).steps.map((step) => step.sql);
  expect(dropped.some((step) => step.startsWith('drop table "public"."people"'))).toBe(true);
  expect(planMigration({ before: stamped, after: catalog([]), name: "keep" }).steps).toEqual([]);
  const shorter = stampOwnership(
    schema({ tables: [withOwner(table("people", { id: t.text().primaryKey() }), "ignored")] })
      .catalog,
    new Map([["people", "ignored"]]),
  );
  expect(planMigration({ before: stamped, after: shorter, name: "column" }).steps).toEqual([]);
  const external = stampOwnership(built.catalog, new Map([["people", "external"]]));
  expect(planMigration({ before: catalog([]), after: external, name: "external" }).steps).toEqual(
    [],
  );
  const adopted = planMigration({
    before: external,
    after: schema({ tables: [table("people", { id: t.text().primaryKey(), name: t.text() })] })
      .catalog,
    name: "adopt",
  });
  expect(adopted.steps).toEqual([]);
});

test("an external table under rlsTenancy keeps its policies and is not created", () => {
  const notes = table("notes", { id: t.uuid().primaryKey(), title: t.text() });
  const marked = withOwner(notes, "external");
  const tenancy = rlsTenancy({ key: "tenantId", type: "uuid" });
  const built = schema({ tenancy, tables: [marked] });
  const plain = schema({ tenancy, tables: [notes] });
  expect(catalogHash(built.catalog)).toBe(catalogHash(plain.catalog));
  expect(built.catalog.objects.some((object) => object.kind === "policy")).toBe(true);
  expect(built.catalog.objects.find((object) => object.kind === "table")?.owner).toBe("managed");
  const stamped = stampOwnership(built.catalog, new Map([["notes", "external"]]));
  const tableObject = stamped.objects.find((object) => object.kind === "table");
  expect(tableObject?.owner).toBe("external");
  const policies = stamped.objects.filter((object) => object.kind === "policy");
  expect(policies.length).toBeGreaterThan(0);
  expect(policies.every((object) => object.owner === "external")).toBe(true);
  expect(
    planMigration({ before: catalog([]), after: stamped, name: "external-rls" }).steps,
  ).toEqual([]);
});
