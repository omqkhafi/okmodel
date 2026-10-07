/**
 * Roles, grants, and default privileges without a database.
 *
 * A managed role is created and altered in place. It is never dropped.
 * Grant identity is not an identifier.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { catalogHash, startupCatalog, startupHash } from "../src/contracts/catalog/document.js";
import { grantObject, roleObject } from "../src/contracts/catalog/privilege.js";
import { staticNamespace } from "../src/contracts/catalog/identity.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const provenance = { origin: "file" as const, name: "roles" };

test("the startup hash leaves roles out, and a catalog without roles hashes as before", () => {
  const tasks = table("tasks", {
    id: t.text().primaryKey(),
    title: t.text(),
    done: t.boolean().nullable(),
  });
  const declared = schema({ tables: [tasks] }).catalog;
  const before = "eef6bc7c12bae7ead432757da9d77df95fe21f6c630f9b1da0c259eff45c6f7f";
  expect(catalogHash(declared)).toBe(before);
  expect(startupHash(declared)).toBe(before);
  expect(startupCatalog(declared)).toBe(declared);
  const withRoles = attachRoles(declared, {
    migration: "mig",
    app: "app",
    managed: [{ name: "app" }],
  });
  expect(catalogHash(withRoles)).not.toBe(before);
  expect(startupHash(withRoles)).toBe(before);
});

test("a managed role is created without IF NOT EXISTS and is never dropped", () => {
  const tasks = table("tasks", { id: t.text().primaryKey() });
  const declared = schema({ tables: [tasks] });
  const after = attachRoles(declared.catalog, {
    migration: "mig",
    app: "app",
    managed: [{ name: "mig" }],
  });
  const plan = planMigration({ before: catalog([]), after, name: "roles" });
  const sql = plan.steps.map((step) => step.sql);
  expect(sql.some((step) => step.startsWith('create role "mig"'))).toBe(true);
  expect(sql.some((step) => /if not exists/i.test(step))).toBe(false);
  expect(sql.some((step) => /drop role/i.test(step))).toBe(false);
  expect(sql.some((step) => /set role/i.test(step))).toBe(false);
  expect(sql.some((step) => step.includes('alter default privileges for role "mig"'))).toBe(true);
  expect(
    sql.some((step) => step.startsWith('grant select on table "public"."tasks" to "app"')),
  ).toBe(true);
  const createRole = sql.findIndex((step) => step.startsWith("create role"));
  const createTable = sql.findIndex((step) => step.startsWith("create table"));
  const grant = sql.findIndex((step) => step.startsWith("grant select"));
  expect(createRole).toBeGreaterThanOrEqual(0);
  expect(createRole).toBeLessThan(createTable);
  expect(grant).toBeGreaterThan(createTable);
});

test("an external role emits no role DDL and a definition change is ALTER ROLE", () => {
  const before = catalog([
    roleObject({ name: "mig", login: false, inherit: true, owner: "managed", provenance }),
  ]);
  const after = catalog([
    roleObject({ name: "mig", login: true, inherit: true, owner: "managed", provenance }),
  ]);
  const changed = planMigration({ before, after, name: "login" }).steps.map((step) => step.sql);
  expect(changed).toEqual(['alter role "mig" with inherit login']);
  const external = catalog([
    roleObject({ name: "app", login: false, inherit: true, owner: "external", provenance }),
  ]);
  const steps = planMigration({ before: catalog([]), after: external, name: "external" }).steps;
  expect(steps).toEqual([]);
  const gone = planMigration({ before: after, after: catalog([]), name: "keep" }).steps;
  expect(gone.some((step) => /drop role/i.test(step.sql))).toBe(false);
});

test("grant identity is exempt from the 63-byte identifier limit", () => {
  const name = "t".repeat(80);
  const granted = grantObject({
    role: "app",
    object: { kind: "table", namespace: staticNamespace("public"), name },
    privilege: "SELECT",
    provenance,
  });
  expect(granted.identity.privilege).toBe("SELECT");
  expect(() => catalog([granted, roleObject({ name: "app", provenance })])).not.toThrow();
  let caught: OkmError | undefined;
  try {
    roleObject({ name: "r".repeat(64), provenance });
  } catch (error) {
    if (error instanceof OkmError) caught = error;
  }
  expect(caught?.code).toBe("OKM1122");
});
