/**
 * Tenant-first indexes (Q3).
 *
 * The tenancy config, the table, and the index each set a scope. The nearest
 * one wins. Resolved columns are what the catalog, generate, and describe show.
 */

import { expect, test } from "bun:test";

import type { Catalog, IndexObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import { buildIndex } from "../src/dialects/pg/table.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { columnTenancy, compositeTenancy, rlsTenancy } from "../src/runtime/tenancy/index.js";
import { describe } from "../src/tooling/migrate/schema-api.js";
import { lintPlan } from "../src/tooling/migrate/lint.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const tenancy = columnTenancy({ key: "tenantId", type: "uuid" });

test("the default prefixes the tenant key, and an index that already leads is not prefixed twice", () => {
  const prefixed = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        { indexes: (columns) => [index(columns.title)] },
      ),
    ],
  });
  expect(indexColumns(prefixed, "notes")).toEqual([["tenant_id", "title"]]);
  const sql = renderCatalog(prefixed.catalog, "public").join("\n");
  expect(sql).toContain(
    'create index "notes_tenant_id_title_idx" on "public"."notes" ("tenant_id", "title")',
  );
  const described = describe(prefixed);
  expect(indexColumns(described, "notes")).toEqual([["tenant_id", "title"]]);

  const leading = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        {
          indexes: (columns) => {
            const handles = columns as typeof columns & {
              readonly tenantId: (typeof columns)["title"];
            };
            return [index(handles.tenantId, handles.title)];
          },
        },
      ),
    ],
  });
  expect(indexColumns(leading, "notes")).toEqual([["tenant_id", "title"]]);
});

test("a non-boolean tenantIndexes is refused when the schema is built", () => {
  expect(() =>
    schema({
      tenancy,
      tables: [
        table(
          "notes",
          { id: t.identity(), title: t.text() },
          {
            tenantIndexes: "no" as unknown as boolean,
            indexes: (columns) => [index(columns.title)],
          },
        ),
      ],
    }),
  ).toThrow(/tenantIndexes must be true or false/);
});

test("tenantIndexes: false leaves the index alone and OKM1706 stays", () => {
  expect(() =>
    schema({
      tenancy,
      tables: [
        table(
          "notes",
          { id: t.identity(), title: t.text() },
          { tenantIndexes: false, indexes: (columns) => [index(columns.title)] },
        ),
      ],
    }),
  ).toThrow(OkmError);
  try {
    schema({
      tenancy,
      tables: [
        table(
          "notes",
          { id: t.identity(), title: t.text() },
          { tenantIndexes: false, indexes: (columns) => [index(columns.title)] },
        ),
      ],
    });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1706");
  }

  const kept = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        {
          tenantIndexes: false,
          indexes: (columns) => {
            const handles = columns as typeof columns & {
              readonly tenantId: (typeof columns)["title"];
            };
            return [index(handles.tenantId, handles.title)];
          },
        },
      ),
    ],
  });
  expect(indexColumns(kept, "notes")).toEqual([["tenant_id", "title"]]);
});

test("indexes: false keeps OKM1706, and .scoped() still prefixes", () => {
  const off = columnTenancy({ key: "tenantId", type: "uuid", indexes: false });
  expect(() =>
    schema({
      tenancy: off,
      tables: [
        table(
          "notes",
          { id: t.identity(), title: t.text() },
          { indexes: (columns) => [index(columns.title)] },
        ),
      ],
    }),
  ).toThrow(OkmError);
  try {
    schema({
      tenancy: off,
      tables: [
        table(
          "notes",
          { id: t.identity(), title: t.text() },
          { indexes: (columns) => [index(columns.title)] },
        ),
      ],
    });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1706");
  }

  const opted = schema({
    casing: "snake",
    tenancy: off,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        { indexes: (columns) => [index(columns.title).scoped()] },
      ),
    ],
  });
  expect(indexColumns(opted, "notes")).toEqual([["tenant_id", "title"]]);

  const tableOn = schema({
    casing: "snake",
    tenancy: off,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        { tenantIndexes: true, indexes: (columns) => [index(columns.title)] },
      ),
    ],
  });
  expect(indexColumns(tableOn, "notes")).toEqual([["tenant_id", "title"]]);
});

test(".global(reason) opts out, and an empty reason is refused", () => {
  expect(() => index(column("title")).global("")).toThrow(/reason/);
  expect(() => index(column("title")).global("   ")).toThrow(/reason/);
  try {
    index(column("title")).global("");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1060");
  }

  const globalIndex = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        { indexes: (columns) => [index(columns.title).global("shared title lookup")] },
      ),
    ],
  });
  expect(indexColumns(globalIndex, "notes")).toEqual([["title"]]);

  const nearest = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text(), body: t.text() },
        {
          tenantIndexes: false,
          indexes: (columns) => [
            index(columns.title).global("shared"),
            index(columns.body).scoped(),
          ],
        },
      ),
    ],
  });
  expect(
    indexColumns(nearest, "notes").sort((left, right) => left.join().localeCompare(right.join())),
  ).toEqual([["tenant_id", "body"], ["title"]]);
});

test("a using index is not rewritten, and OKM1706 stays unless it is global", () => {
  const expression = 'using gin ("title" gin_trgm_ops)';
  try {
    schema({
      tenancy,
      tables: [
        table(
          "notes",
          { id: t.identity(), title: t.text() },
          { indexes: () => [buildIndex({ columns: ["title"], expression })] },
        ),
      ],
    });
    throw new Error("using index should be OKM1706");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1706");
      expect(error.fix?.summary).toContain('index().global("reason")');
      expect(error.fix?.summary).toContain("does not prefix a using tail");
    }
  }
  const kept = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        { indexes: () => [buildIndex({ columns: ["title"], expression }).global("search")] },
      ),
    ],
  });
  expect(indexColumns(kept, "notes")).toEqual([["title"]]);
});

test("a unique index becomes unique per tenant", () => {
  const built = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), email: t.text() },
        { indexes: (columns) => [index(columns.email).unique()] },
      ),
    ],
  });
  const found = indexesOn(built, "notes");
  expect(found).toHaveLength(1);
  expect(found[0]?.definition.unique).toBe(true);
  expect(found[0]?.definition.columns).toEqual(["tenant_id", "email"]);
  expect(renderCatalog(built.catalog, "public").join("\n")).toContain(
    'create unique index "notes_tenant_id_email_idx" on "public"."notes" ("tenant_id", "email")',
  );
});

test("a tenant key later in the index is moved forward and not repeated", () => {
  const built = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), body: t.text() },
        { indexes: (columns) => [index(columns.body, columns.tenantId)] },
      ),
    ],
  });
  expect(indexColumns(built, "notes")).toEqual([["tenant_id", "body"]]);
});

test("two indexes that match after the tenant prefix are OKM1023 and name both", () => {
  let error: OkmError | undefined;
  try {
    schema({
      casing: "snake",
      tenancy,
      tables: [
        table(
          "notes",
          { id: t.identity(), body: t.text() },
          {
            indexes: (columns) => [
              index(columns.body, columns.tenantId),
              index(columns.tenantId, columns.body),
            ],
          },
        ),
      ],
    });
  } catch (caught) {
    if (caught instanceof OkmError) error = caught;
    else throw caught;
  }
  expect(error?.code).toBe("OKM1023");
  expect(error?.message).toContain("body, tenant_id");
  expect(error?.message).toContain("tenant_id, body");
});

test("a composite unique index includes every key", () => {
  const built = schema({
    casing: "snake",
    tenancy: compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
    tables: [
      table(
        "documents",
        { id: t.identity(), email: t.text() },
        { indexes: (columns) => [index(columns.email).unique()] },
      ),
    ],
  });
  expect(indexColumns(built, "documents")).toEqual([["organization_id", "workspace_id", "email"]]);
  const sql = renderCatalog(built.catalog, "public").join("\n");
  expect(sql).toContain(
    'create unique index "documents_organization_id_workspace_id_email_idx" on "public"."documents" ("organization_id", "workspace_id", "email")',
  );
});

test("composite and rls prefix the first key, and a global index stays put", () => {
  const composite = schema({
    casing: "snake",
    tenancy: compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
    tables: [
      table(
        "documents",
        { id: t.identity(), title: t.text() },
        { indexes: (columns) => [index(columns.title)] },
      ),
    ],
  });
  expect(indexColumns(composite, "documents")).toEqual([["organization_id", "title"]]);

  const rls = schema({
    casing: "snake",
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        { indexes: (columns) => [index(columns.title).global("shared")] },
      ),
    ],
  });
  expect(indexColumns(rls, "notes")).toEqual([["title"]]);
});

test("replacing a tenant index builds the new one concurrently, then drops the old one", () => {
  const before = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        { indexes: (columns) => [index(columns.title).global("legacy title")] },
      ),
    ],
  });
  const after = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text() },
        { indexes: (columns) => [index(columns.title)] },
      ),
    ],
  });
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: "prefix" });
  expect(plan.steps.map((step) => step.sql)).toEqual([
    'create index concurrently "notes_tenant_id_title_idx" on "public"."notes" ("tenant_id", "title")',
    'drop index concurrently "public"."notes_title_idx"',
  ]);
  expect(plan.steps.map((step) => step.lock)).toEqual([
    "SHARE UPDATE EXCLUSIVE",
    "SHARE UPDATE EXCLUSIVE",
  ]);
  expect(plan.steps.every((step) => step.transactional === false)).toBe(true);
  const errors = lintPlan(plan, before.catalog, after.catalog).filter(
    (finding) => finding.severity === "error",
  );
  expect(errors).toEqual([]);
});

function column(name: string): { readonly name: string } {
  return { name };
}

function indexesOn(source: { readonly catalog: Catalog }, tableName: string): IndexObject[] {
  return source.catalog.objects.filter(
    (object): object is IndexObject =>
      object.kind === "index" && object.identity.parent.name === tableName,
  );
}

function indexColumns(source: { readonly catalog: Catalog }, tableName: string): string[][] {
  return indexesOn(source, tableName).map((object) => [...object.definition.columns]);
}
