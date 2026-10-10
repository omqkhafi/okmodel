/**
 * `rlsTenancy()` at schema build: policies, views, and a column schema that
 * does not move.
 */

import { expect, test } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { view } from "../src/dialects/pg/view/index.js";
import { columnTenancy, global, rlsTenancy, via } from "../src/runtime/tenancy/index.js";
import { app } from "./tenancy-schema.js";

const COLUMN_HASH = "12bdf154322bd0f113aabd10055763e74781458a9d5bd1589d18f291b336e445";

test("a column schema keeps its catalog hash and emits no policies", () => {
  expect(catalogHash(app.catalog)).toBe(COLUMN_HASH);
  const sql = renderCatalog(app.catalog, "public").join("\n");
  expect(sql).not.toContain("row level security");
  expect(sql).not.toContain("security_invoker");
  expect(app.catalog.objects.some((object) => object.kind === "policy")).toBe(false);
});

test("rls emits enable, force, and two policies, and skips global tables", () => {
  const notes = table("notes", { id: id({ default: "none" }), title: text().unique() });
  const countries = table(
    "countries",
    { id: id({ default: "none" }), name: text() },
    { tenancy: global("shared") },
  );
  const built = schema({
    casing: "snake",
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    tables: [notes, countries],
  });
  const policies = built.catalog.objects.filter((object) => object.kind === "policy");
  expect(policies.map((object) => object.identity.name)).toEqual([
    "notes_tenant",
    "notes_unscoped_select",
  ]);
  const tenant = policies[0];
  const unscoped = policies[1];
  if (tenant?.kind !== "policy" || unscoped?.kind !== "policy") {
    throw new Error("expected two policy objects");
  }
  expect(tenant.definition.command).toBe("all");
  expect(tenant.definition.force).toBe(true);
  expect(tenant.definition.expression).toContain("app.tenant");
  expect(tenant.definition.expression).toContain("::uuid");
  expect(unscoped.definition.command).toBe("select");
  expect(unscoped.definition.expression).toContain("app.unscoped");
  const sql = renderCatalog(built.catalog, "app").join("\n");
  expect(sql).toContain('alter table "app"."notes" enable row level security');
  expect(sql).toContain('alter table "app"."notes" force row level security');
  expect(sql).toContain('create policy "notes_tenant"');
  expect(sql).toContain('create policy "notes_unscoped_select"');
  expect(sql).not.toContain('policy "countries');
  expect(sql).not.toContain('countries" enable');
  expect(built.tenancy?.strategy).toBe("rls");
});

test("a view over tenant tables is security_invoker and a view without the key is OKM1820", () => {
  const notes = table("notes", { id: id({ default: "none" }), title: text() });
  const open = view("open_notes", {
    columns: [
      { name: "id", type: "uuid" },
      { name: "tenant_id", type: "uuid" },
    ],
    query: "select id, tenant_id from notes",
  });
  const built = schema({
    casing: "snake",
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    tables: [notes],
    views: [open],
  });
  const listed = built.catalog.objects.find((object) => object.kind === "view");
  if (listed?.kind !== "view") throw new Error("expected a view");
  expect(listed.definition.securityInvoker).toBe(true);
  expect(renderCatalog(built.catalog, "app").join("\n")).toContain(
    "with (security_invoker = true)",
  );

  const hidden = view("hidden_notes", {
    columns: [{ name: "id", type: "uuid" }],
    query: "select id from notes",
  });
  expect(() =>
    schema({
      casing: "snake",
      tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
      tables: [notes],
      views: [hidden],
    }),
  ).toThrow(OkmError);
  try {
    schema({
      casing: "snake",
      tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
      tables: [notes],
      views: [hidden],
    });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    expect(error instanceof OkmError ? error.code : "").toBe("OKM1820");
  }
});

test("via() and a key list are refused", () => {
  const orgs = table("orgs", { id: id({ default: "none" }) });
  const tasks = table(
    "tasks",
    { id: id({ default: "none" }), orgId: uuid().references("orgs") },
    { tenancy: via("orgs") },
  );
  expect(() =>
    schema({
      casing: "snake",
      tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
      tables: [orgs, tasks],
    }),
  ).toThrow(/not supported yet/);

  const listed = { key: ["organizationId", "workspaceId"], type: "uuid" } as unknown as {
    key: string;
    type: "uuid";
  };
  expect(() => rlsTenancy(listed)).toThrow(/not supported yet/);
});

test("a view under column tenancy is not security_invoker", () => {
  const notes = table("notes", { id: id({ default: "none" }), title: text() });
  const open = view("open_notes", {
    columns: [
      { name: "id", type: "uuid" },
      { name: "tenant_id", type: "uuid" },
    ],
    query: "select id, tenant_id from notes",
  });
  const built = schema({
    casing: "snake",
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
    tables: [notes],
    views: [open],
  });
  const listed = built.catalog.objects.find((object) => object.kind === "view");
  if (listed?.kind !== "view") throw new Error("expected a view");
  expect(listed.definition.securityInvoker).toBeUndefined();
  expect(renderCatalog(built.catalog, "app").join("\n")).not.toContain("security_invoker");
});
