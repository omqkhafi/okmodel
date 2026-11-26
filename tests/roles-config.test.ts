/**
 * Roles config and grant presets. No database.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { normalizeRoles } from "../src/dialects/pg/role/config.js";
import { expandGrants } from "../src/dialects/pg/role/grants.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { classifyLogin, roleDoctorNotes } from "../src/tooling/migrate/roles-cmd.js";
import type { DriverPool } from "../src/contracts/driver.js";

const roles = normalizeRoles({
  migration: { name: "okm_migrate", env: "MIGRATE_DATABASE_URL" },
  app: { name: "okm_app", env: "APP_DATABASE_URL" },
  reporting: { name: "okm_read" },
});

test("proof:roles.manage", () => {
  expect(() =>
    normalizeRoles({ migration: "okm_migrate" as never, app: { name: "okm_app" } }),
  ).toThrow(OkmError);
  expect(() =>
    normalizeRoles({
      migration: { name: "okm_migrate", password: "no" } as never,
      app: { name: "okm_app" },
    }),
  ).toThrow(/password/);
  const custom = normalizeRoles({
    migration: { name: "okm_migrate" },
    app: { name: "okm_app" },
    worker: { name: "okm_worker", env: "WORKER_DATABASE_URL", connectionLimit: 4 },
  });
  expect(custom.find((entry) => entry.key === "worker")?.name).toBe("okm_worker");
});

test("proof:roles.membership", () => {
  const member = normalizeRoles({
    migration: { name: "okm_migrate" },
    app: { name: "okm_app", memberOf: [{ role: "okm_migrate", inherit: true, set: true }] },
  });
  expect(member[1]?.memberOf?.[0]).toEqual({ role: "okm_migrate", inherit: true, set: true });
  expect(() =>
    normalizeRoles({
      migration: { name: "okm_migrate" },
      app: { name: "okm_app", memberOf: ["missing"] },
    }),
  ).toThrow(/missing/);
});

test("proof:grants.object", () => {
  const expanded = expandGrants(
    { app: "write", reporting: "read", audit: ["select"] },
    "table",
    [...roles, { key: "audit", name: "okm_audit" }],
    "table tasks",
  );
  expect(expanded.grants.map((grant) => `${grant.role}:${grant.privilege}`)).toContain(
    "okm_app:INSERT",
  );
  expect(() => expandGrants({ app: "all" }, "table", roles, "table tasks")).toThrow(/all/);
  const after = attachRoles(
    schema({ tables: [table("docs", { id: t.text().primaryKey() })] }).catalog,
    {
      migration: { name: "okm_migrate" },
      app: { name: "okm_app" },
      reporting: { name: "okm_read" },
    },
    undefined,
    new Map([["docs", { app: "write", reporting: "read" }]]),
  );
  const sql = planMigration({ before: catalog([]), after, name: "grants" }).steps.map(
    (step) => step.sql,
  );
  expect(
    sql.some((step) => step.includes('grant select on table "public"."docs" to "okm_read"')),
  ).toBe(true);
  expect(sql.some((step) => step.startsWith("create role"))).toBe(false);
});

test("proof:grants.column", () => {
  const expanded = expandGrants(
    { reporting: { select: ["id", "title"] } },
    "table",
    roles,
    "table docs",
  );
  expect(expanded.grants[0]?.privilege).toBe("SELECT(id,title)");
  expect(expanded.warnings.some((warning) => warning.summary.includes("select *"))).toBe(true);
});

test("proof:grants.verify", () => {
  const wrong = classifyLogin(
    Object.assign(new Error("password authentication failed"), { code: "28P01" }),
    false,
  );
  expect(wrong.result).toBe("wrong");
  const sasl = classifyLogin(
    Object.assign(new Error("SASL authentication failed"), { code: "08P01" }),
    true,
  );
  expect(sasl.result).toBe("wrong");
  const pooler = classifyLogin(
    Object.assign(new Error("XX000 ENOIDENTIFIER"), { code: "XX000" }),
    true,
  );
  expect(pooler.result).toBe("pooler-username");
  const unknown = classifyLogin(Object.assign(new Error("timeout"), { code: "08006" }), true);
  expect(unknown.result).toBe("unknown");
  expect(unknown.result === "unknown" ? unknown.detail : "").toBe("cannot verify through a pooler");
});

test("doctor lists an app role setting from pg_db_role_setting", async () => {
  const pool = {
    execute: async (text: string) => {
      if (text.includes("pg_db_role_setting")) {
        return { rows: [["statement_timeout=5s"]], columns: [] };
      }
      return { rows: [["0"]], columns: [] };
    },
  } as unknown as DriverPool;
  const notes = await roleDoctorNotes(pool, "okm_app");
  expect(notes).toContain(
    "statement_timeout=5s is set on okm_app and is not applied when the client switches role with SET ROLE",
  );
});
