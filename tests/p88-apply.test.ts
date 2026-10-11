/**
 * Generate and apply correctness that does not need Postgres.
 *
 * Policy text, foreign-key order, materialized-view index documents, and
 * ownership marks. The database cases are in `p88-apply-pg.test.ts`.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { catalogHash, parseCatalog, serializeCatalog } from "../src/contracts/catalog/document.js";
import { tenantPolicyExpression } from "../src/contracts/catalog/policy.js";
import { OkmError } from "../src/contracts/error.js";
import { id, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { materializedView } from "../src/dialects/pg/view/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { privilegeSql } from "../src/dialects/pg/role/sql.js";
import { columnTenancy, rlsTenancy, via } from "../src/runtime/tenancy/index.js";
import { repoRoot } from "../scripts/root.js";
import { generateProject } from "../src/tooling/migrate/project.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { pathApp } from "./tenancy-strategies-schema.js";

const SNAKE_RLS_HASH = "4d4cb5789b2d906687fb778b2415b222862cab1acd52b2356fae4251f99de9cf";
const PATH_HASH = "6f52772adfc4551686d62973049f3f5482a7db07b83d8b0ed90db062350a6ccf";
const BARE = "(tenant_id = (NULLIF(current_setting('app.tenant'::text, true), ''::text))::uuid)";

test("tenant policy text matches pg_get_expr quoting", () => {
  expect(tenantPolicyExpression("tenant_id", "uuid")).toBe(BARE);
  expect(tenantPolicyExpression("tenantId", "uuid")).toBe(quoted("tenantId"));
  expect(tenantPolicyExpression("TenantId", "uuid")).toBe(quoted("TenantId"));
  expect(tenantPolicyExpression("user", "uuid")).toBe(quoted("user"));
  expect(tenantPolicyExpression("order", "uuid")).toBe(quoted("order"));
  const notes = () => table("notes", { id: id({ default: "none" }), title: text() });
  const snake = schema({
    casing: "snake",
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    tables: [notes()],
  });
  expect(catalogHash(snake.catalog)).toBe(SNAKE_RLS_HASH);
  const policy = snake.catalog.objects.find(
    (object) => object.kind === "policy" && object.identity.name.endsWith("_tenant"),
  );
  if (policy?.kind !== "policy") throw new Error("snake policy missing");
  expect(policy.definition.expression).toBe(BARE);
  expect(() =>
    schema({
      tenancy: rlsTenancy({ key: "user", type: "uuid" }),
      tables: [notes()],
    }),
  ).toThrow(OkmError);
});

test("a path foreign key follows the unique it references, for every name order", () => {
  expect(catalogHash(pathApp.catalog)).toBe(PATH_HASH);
  const names = [
    ["organizations", "departments", "teams"],
    ["teams", "departments", "organizations"],
    ["zzz", "mmm", "aaa"],
    ["aaa", "mmm", "zzz"],
    ["m", "a", "z"],
    ["departments", "organizations", "teams"],
  ] as const;
  for (const [org, dept, team] of names) {
    const planned = planMigration({
      before: catalog([]),
      after: pathNames(org, dept, team).catalog,
      name: "init",
    });
    const sql = planned.steps.map((step) => step.sql);
    const unique = sql.findIndex(
      (step) => step.includes(`unique ("id")`) && step.includes(`"${org}"`),
    );
    const foreign = sql.findIndex((step) => step.includes(`references "public"."${org}" ("id")`));
    expect(unique, `${org}/${dept}/${team} unique`).toBeGreaterThanOrEqual(0);
    expect(foreign, `${org}/${dept}/${team} foreign key`).toBeGreaterThan(unique);
  }
  const snake = planMigration({
    before: catalog([]),
    after: pathNames("organizations", "departments", "teams", "snake").catalog,
    name: "init",
  });
  const snakeSql = snake.steps.map((step) => step.sql);
  const unique = snakeSql.findIndex(
    (step) => step.includes(`unique ("id")`) && step.includes(`"organizations"`),
  );
  const foreign = snakeSql.findIndex((step) =>
    step.includes(`references "public"."organizations" ("id")`),
  );
  expect(foreign).toBeGreaterThan(unique);
});

test("a materialized view index round-trips without a column dependency", () => {
  const tasks = table("tasks", { id: text().primaryKey(), title: text() });
  const columns = [
    { name: "id", type: "text" },
    { name: "title", type: "text" },
  ];
  const built = schema({
    tables: [tasks],
    views: [
      materializedView("sums", {
        columns,
        query: "SELECT id, title FROM tasks",
        refresh: "concurrently",
        indexes: [
          { columns: ["id"], unique: true },
          { columns: ["title"], unique: false },
          { columns: ["id", "title"], unique: true },
          { columns: ["title", "id"], unique: false },
        ],
      }),
    ],
  });
  const again = parseCatalog(serializeCatalog(built.catalog));
  const indexes = again.objects.filter((object) => object.kind === "index");
  expect(indexes).toHaveLength(4);
  for (const index of indexes) {
    expect(index.dependencies.some((edge) => edge.target.kind === "column")).toBe(false);
    expect(index.dependencies.some((edge) => edge.target.kind === "materializedView")).toBe(true);
  }
  expect(serializeCatalog(again)).toBe(serializeCatalog(built.catalog));
});

test("application role writes are revoked on a materialized view", () => {
  const tasks = table("tasks", { id: text().primaryKey(), title: text() });
  const built = schema({
    tables: [tasks],
    views: [
      materializedView("sums", {
        columns: [
          { name: "id", type: "text" },
          { name: "title", type: "text" },
        ],
        query: "SELECT id, title FROM tasks",
        indexes: [{ columns: ["id"], unique: true }],
      }),
    ],
  });
  const declared = attachRoles(built.catalog, {
    migration: "mig",
    app: "app",
    reporting: "report",
    managed: [{ name: "mig" }, { name: "app" }, { name: "report" }],
  });
  const grants = privilegeSql([], declared.objects, "public").grant.map((item) => item.sql);
  const revoke = grants.filter((sql) => sql.startsWith("revoke insert, update, delete"));
  expect(revoke).toEqual(['revoke insert, update, delete on table "public"."sums" from "app"']);
});

test("generate omits ignored and external tables", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-owner-"));
  const root = repoRoot();
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, table, text, withOwner } from ${pg};`,
      'const people = withOwner(table("people", { email: text() }), "ignored");',
      'const outside = withOwner(table("outside", { email: text() }), "external");',
      'const managed = table("managed", { email: text() });',
      "export const app = schema({ tables: [people, outside, managed] });",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      'export default defineConfig({ schema: "./schema.ts" });',
      "",
    ].join("\n"),
  );
  try {
    const written = await generateProject(cwd, "init", []);
    if (written === undefined) throw new Error("generate wrote nothing");
    const sql = readFileSync(written.path, "utf8");
    expect(sql).toContain('"managed"');
    expect(sql).not.toContain('"people"');
    expect(sql).not.toContain('"outside"');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function quoted(column: string): string {
  return `("${column}" = (NULLIF(current_setting('app.tenant'::text, true), ''::text))::uuid)`;
}

function pathNames(org: string, dept: string, team: string, casing?: "snake") {
  const organizations = table(org, { id: id({ default: "none" }), name: text() });
  const departments = table(
    dept,
    {
      id: id({ default: "none" }),
      name: text(),
      organizationId: uuid().references(org),
    },
    {
      tenancy: via("organization"),
      relations: { organization: one(org, "organizationId") },
    },
  );
  const teams = table(
    team,
    {
      id: id({ default: "none" }),
      name: text(),
      departmentId: uuid().references(dept),
    },
    {
      tenancy: via("department.organization"),
      relations: { department: one(dept, "departmentId") },
    },
  );
  return schema({
    ...(casing === undefined ? {} : { casing }),
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
    tables: [organizations, departments, teams],
  });
}
