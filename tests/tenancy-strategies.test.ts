/**
 * Composite and path tenancy: catalog shape, build refusals, and planned SQL.
 *
 * Rows on real Postgres are `tenancy-strategies-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { id, index, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";
import {
  compositeApp,
  DOC,
  ORG_A,
  pathApp,
  PROJECT,
  TENANT_A,
  WS_1,
} from "./tenancy-strategies-schema.js";

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

test("composite keys widen the primary key, the unique, and the conflict target", async () => {
  const objects = compositeApp.catalog.objects;
  const pk = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.identity.parent.name === "documents" &&
      object.definition.constraintKind === "primaryKey",
  );
  expect(pk?.kind === "constraint" ? pk.definition.columns : []).toEqual([
    "id",
    "organization_id",
    "workspace_id",
  ]);
  const beside = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === "documents" &&
      object.definition.columns.join(",") === "id,organization_id,workspace_id",
  );
  expect(nameOf(beside)).toBe("documents_id_organizationId_workspaceId_key");
  const title = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === "documents" &&
      object.definition.nameKey === "title",
  );
  expect(title?.kind === "constraint" ? title.definition.columns : []).toEqual([
    "organization_id",
    "workspace_id",
    "title",
  ]);

  const db = connect(pool, { schema: compositeApp });
  const scoped = db.for({ organizationId: ORG_A, workspaceId: WS_1 });
  const planned = await scoped.documents
    .insert(
      { id: DOC, title: "shared", body: "a" },
      { onConflict: { on: "title", update: ["body"] } },
    )
    .sql();
  expect(planned.statements[0]?.text).toContain(
    'on conflict ("organization_id", "workspace_id", "title")',
  );
  const filtered = await scoped.documents.find({ limit: 1 }).sql();
  expect(filtered.text).toContain('"organization_id"');
  expect(filtered.text).toContain('"workspace_id"');
  expect(() => db.for({ organizationId: ORG_A } as never)).toThrow(OkmError);
  expect(() => db.for({ organizationId: ORG_A, workspaceId: WS_1, extra: "no" } as never)).toThrow(
    /extra/,
  );
});

test("an object map is refused in favor of the key list", () => {
  expect(() =>
    columnTenancy({
      key: { organizationId: "uuid", workspaceId: "uuid" },
      type: "uuid",
    } as never),
  ).toThrow(/list of field names/);
});

test("an index that does not lead with the first composite key is OKM1706", () => {
  expect(() =>
    schema({
      casing: "snake",
      tenancy: columnTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
      tables: [
        table(
          "documents",
          { id: id({ default: "none" }), title: text() },
          { indexes: (columns) => [index(columns.title)] },
        ),
      ],
    }),
  ).toThrow(/OKM1706|organization_id/);
});

test("a path ends at the tenant table and stores a unique on its declared key", async () => {
  const objects = pathApp.catalog.objects;
  const endpoint = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === "organizations" &&
      object.definition.columns.join(",") === "id",
  );
  expect(endpoint).toBeDefined();
  const projectFk = objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "foreignKey" &&
      object.identity.parent.name === "projects",
  );
  expect(projectFk?.kind === "constraint" ? projectFk.definition.columns : []).toEqual([
    "organization_id",
  ]);
  expect(projectFk?.kind === "constraint" ? projectFk.definition.references?.columns : []).toEqual([
    "id",
  ]);
  const projectIndex = objects.find(
    (object) => object.kind === "index" && object.identity.parent.name === "projects",
  );
  expect(projectIndex?.kind === "index" ? projectIndex.definition.columns[0] : "").toBe(
    "organization_id",
  );
  expect(
    objects.some(
      (object) =>
        object.kind === "column" &&
        object.identity.parent.name === "projects" &&
        object.identity.name === "tenant_id",
    ),
  ).toBe(false);

  const db = connect(pool, { schema: pathApp });
  const scoped = db.for({ tenantId: TENANT_A });
  const filtered = await scoped.projects.find({ limit: 1 }).sql();
  expect(filtered.text).toContain("exists (select 1 from");
  expect(filtered.text.includes("for share")).toBe(false);
  const inserted = await scoped.projects
    .insert({ id: PROJECT, name: "Road", organizationId: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01" })
    .sql();
  const insert = inserted.statements[0]?.text ?? "";
  expect(insert).toContain("exists (select 1 from");
  expect(insert).toContain("for share");
  const deep = await scoped.notes.find({ limit: 1 }).sql();
  const hops = deep.text;
  expect(hops).toContain("teams");
  expect(hops).toContain("departments");
  expect(hops).toContain("organizations");
});

test("a path that is too long, broken, cyclic, or short of a tenant table is OKM1705", () => {
  const tenancy = columnTenancy({ key: "tenantId", type: "uuid" });
  const organizations = table(
    "organizations",
    { id: id({ default: "none" }), name: text() },
    { indexes: (columns) => [index(...handles(columns, "tenantId"))] },
  );
  expect(() =>
    schema({
      tenancy,
      tables: [
        organizations,
        table(
          "notes",
          { id: id({ default: "none" }), organizationId: uuid().references("organizations") },
          { tenancy: { via: "a.b.c.d" }, relations: { a: one("organizations", "organizationId") } },
        ),
      ],
    }),
  ).toThrow(/longer than 3/);

  expect(() =>
    schema({
      tenancy,
      tables: [
        organizations,
        table(
          "notes",
          { id: id({ default: "none" }), organizationId: uuid().references("organizations") },
          { tenancy: { via: "missing" } },
        ),
      ],
    }),
  ).toThrow(/no to-one relation/);

  const countries = table(
    "countries",
    { id: id({ default: "none" }), name: text() },
    { tenancy: global("shared") },
  );
  expect(() =>
    schema({
      tenancy,
      tables: [
        countries,
        table(
          "notes",
          { id: id({ default: "none" }), countryId: uuid().references("countries") },
          { tenancy: { via: "country" }, relations: { country: one("countries", "countryId") } },
        ),
      ],
    }),
  ).toThrow(/not a tenant table/);

  const left = table(
    "left",
    { id: id({ default: "none" }), rightId: uuid() },
    {
      tenancy: { via: "right.left" },
      relations: { right: one("right", "rightId") },
    },
  );
  const right = table(
    "right",
    { id: id({ default: "none" }), leftId: uuid() },
    {
      tenancy: { via: "left.right" },
      relations: { left: one("left", "leftId") },
    },
  );
  expect(() => schema({ tenancy, tables: [organizations, left, right] })).toThrow(/cycles/);
});

function handles(columns: object, ...fields: readonly string[]): { readonly name: string }[] {
  const record = columns as Readonly<Record<string, { readonly name: string }>>;
  return fields.map((field) => {
    const handle = record[field];
    if (handle === undefined) throw new Error(`missing ${field}`);
    return handle;
  });
}

function nameOf(object: { readonly identity: object } | undefined): string {
  const identity = object?.identity;
  if (identity === undefined || !("name" in identity) || typeof identity.name !== "string")
    return "";
  return identity.name;
}
