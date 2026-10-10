/**
 * Composite and path tenancy on real Postgres.
 *
 * Composite pairs stay apart, including a same-title upsert. A path child is
 * visible only through a parent in the caller's tenant. `isolation()` covers
 * both and fails when the predicate is removed.
 */

import { expect } from "bun:test";

import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, index, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import type { QuerySchema } from "../src/dialects/pg/model.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import type { Connected } from "../src/runtime/types.js";
import {
  columnTenancy,
  compositeTenancy,
  via,
  type ColumnTenancy,
} from "../src/runtime/tenancy/index.js";
import { tenantProbe } from "../src/tooling/testing/facts.js";
import { testing } from "../src/tooling/testing/index.js";
import {
  compositeApp,
  DEPT,
  DOC,
  FILE,
  NOTE,
  ORG,
  ORG_A,
  ORG_B,
  pathApp,
  PROJECT,
  TEAM,
  TENANT_A,
  TENANT_B,
  WS_1,
  WS_2,
} from "./tenancy-strategies-schema.js";

const gate = await loadPostgresGate();
const ORG_ALPHA = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c41";
const LATE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c42";

postgresTest(
  gate,
  "a composite tenant cannot see or change another key combination",
  async () => {
    await withApp(compositeApp, async (db) => {
      expect(() => db.for({ organizationId: ORG_A } as never)).toThrow(OkmError);
      const one = db.for({ organizationId: ORG_A, workspaceId: WS_1 });
      const sameOrg = db.for({ organizationId: ORG_A, workspaceId: WS_2 });
      const sameWorkspace = db.for({ organizationId: ORG_B, workspaceId: WS_1 });
      await one.documents.insert({ id: DOC, title: "shared", body: "one" });
      await sameOrg.documents.insert({ id: DOC, title: "shared", body: "same-org" });
      await sameWorkspace.documents.insert({ id: DOC, title: "shared", body: "same-workspace" });
      await one.files.insert({ id: FILE, name: "one" });
      await sameOrg.files.insert({ id: FILE, name: "same-org" });

      expect(await one.documents.find({ where: { body: "same-org" }, limit: 5 })).toEqual([]);
      expect(await one.documents.find({ where: { body: "same-workspace" }, limit: 5 })).toEqual([]);
      expect((await one.documents.find({ limit: 5 })).map((row) => row.body)).toEqual(["one"]);
      expect(
        countOf(
          await one.documents.update({ where: { body: "same-org" }, set: { body: "stolen" } }),
        ),
      ).toBe(0);
      expect(countOf(await one.documents.delete({ where: { body: "same-workspace" } }))).toBe(0);
      expect(countOf(await one.files.archive({ where: { name: "same-org" } }))).toBe(0);
      expect((await sameOrg.documents.one({ where: { id: DOC } }))?.body).toBe("same-org");
      expect((await sameWorkspace.documents.one({ where: { id: DOC } }))?.body).toBe(
        "same-workspace",
      );
      expect((await sameOrg.files.one({ where: { id: FILE } }))?.name).toBe("same-org");

      const merged = await one.documents.insert(
        { id: DOC, title: "shared", body: "one-next" },
        { onConflict: { on: "title", update: ["body"] } },
      );
      expect(merged.body).toBe("one-next");
      expect((await sameOrg.documents.one({ where: { id: DOC } }))?.body).toBe("same-org");
      expect((await sameWorkspace.documents.one({ where: { id: DOC } }))?.body).toBe(
        "same-workspace",
      );

      await expectCode(
        one.documents.update({ where: { id: DOC }, set: { workspaceId: WS_2 } } as never),
        "OKM1704",
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a path child of tenant B is invisible to A, including a three-hop path",
  async () => {
    await withApp(pathApp, async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await b.organizations.insert({ id: ORG, name: "Beta" });
      await b.projects.insert({ id: PROJECT, name: "Road", organizationId: ORG });
      await b.departments.insert({ id: DEPT, name: "Eng", organizationId: ORG });
      await b.teams.insert({ id: TEAM, name: "Core", departmentId: DEPT });
      await b.notes.insert({ id: NOTE, body: "secret", teamId: TEAM });

      expect(await a.projects.find({ where: { id: PROJECT }, limit: 5 })).toEqual([]);
      expect(await a.projects.one({ where: { id: PROJECT } })).toBeNull();
      expect(await a.projects.count({ where: { id: PROJECT } })).toBe(0);
      const aggregated = await a.projects.aggregate({ where: { id: PROJECT }, count: true });
      expect(aggregated.every((row) => row.count === 0)).toBe(true);
      expect(
        (await a.projects.page({ where: { id: PROJECT }, orderBy: { id: "asc" }, limit: 5 })).items,
      ).toEqual([]);
      const streamed: unknown[] = [];
      for await (const row of a.projects.find({ where: { id: PROJECT }, limit: 5 }).stream()) {
        streamed.push(row);
      }
      expect(streamed).toEqual([]);
      expect(
        await a.projects.find({
          where: { id: PROJECT },
          include: { organization: true },
          limit: 5,
        }),
      ).toEqual([]);
      expect(
        countOf(await a.projects.update({ where: { id: PROJECT }, set: { name: "nope" } })),
      ).toBe(0);
      expect(countOf(await a.projects.delete({ where: { id: PROJECT } }))).toBe(0);
      expect((await b.projects.one({ where: { id: PROJECT } }))?.name).toBe("Road");

      expect(await a.notes.find({ where: { id: NOTE }, limit: 5 })).toEqual([]);
      expect(await a.notes.one({ where: { id: NOTE } })).toBeNull();
      expect(await a.notes.count({ where: { id: NOTE } })).toBe(0);
      expect(countOf(await a.notes.update({ where: { id: NOTE }, set: { body: "nope" } }))).toBe(0);
      expect(countOf(await a.notes.delete({ where: { id: NOTE } }))).toBe(0);
      expect((await b.notes.one({ where: { id: NOTE } }))?.body).toBe("secret");

      await expectCode(
        a.projects.insert({ id: LATE, name: "late", organizationId: ORG }),
        "OKM1705",
      );

      await a.organizations.insert({ id: ORG_ALPHA, name: "Alpha" });
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deleting = a.tx(async (tx) => {
        await tx.organizations.delete({ where: { id: ORG_ALPHA } });
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      await held;
      const inserting = a.projects.insert({
        id: LATE,
        name: "raced",
        organizationId: ORG_ALPHA,
      });
      await expectCode(inserting, "OKM1705");
      await deleting;
    });
  },
  60_000,
);

postgresTest(
  gate,
  "isolation passes for composite and path and fails when the predicate is removed",
  async () => {
    await expectIsolation(
      () => compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
      compositeSchema,
      ["documents"],
    );
    await expectIsolation(() => columnTenancy({ key: "tenantId", type: "uuid" }), pathSchema, [
      "organizations",
      "projects",
    ]);
  },
  90_000,
);

async function expectIsolation<S extends Parameters<typeof testing>[0]>(
  fresh: () => ColumnTenancy,
  build: (tenancy: ColumnTenancy) => S,
  checked: readonly string[],
): Promise<void> {
  const database = await createIsolatedDatabase();
  try {
    const harness = await testing(build(fresh()), { driver: open({ url: database.url }) });
    try {
      const report = await harness.isolation();
      for (const name of checked) expect(report.checked).toContain(name);
    } finally {
      await harness.close();
    }
    const leaking = await testing(build(dropPredicate(fresh())), {
      driver: open({ url: database.url }),
      migrate: false,
    });
    try {
      await expectLeak(leaking.isolation());
    } finally {
      await leaking.close();
    }
  } finally {
    await database.close();
  }
}

async function expectLeak(pending: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await pending;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OkmError);
  expect(failure instanceof OkmError ? failure.message : "").toContain("Isolation leak");
}

function dropPredicate(real: ColumnTenancy): ColumnTenancy {
  return {
    ...real,
    predicate(input: Parameters<ColumnTenancy["predicate"]>[0]): boolean {
      if (
        input.scope !== undefined &&
        "value" in input.scope &&
        input.scope.value === tenantProbe
      ) {
        return real.predicate(input);
      }
      return false;
    },
  };
}

function compositeSchema(tenancy: ColumnTenancy) {
  return schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "documents",
        { id: id({ default: "none" }), title: text() },
        {
          indexes: (columns) => [index(...handles(columns, "organizationId", "workspaceId"))],
        },
      ),
    ],
  });
}

function pathSchema(tenancy: ColumnTenancy) {
  const organizations = table(
    "organizations",
    { id: id({ default: "none" }), name: text() },
    { indexes: (columns) => [index(...handles(columns, "tenantId"))] },
  );
  const projects = table(
    "projects",
    {
      id: id({ default: "none" }),
      name: text(),
      organizationId: uuid().references("organizations"),
    },
    {
      tenancy: via("organization"),
      relations: { organization: one("organizations", "organizationId") },
    },
  );
  return schema({ casing: "snake", tenancy, tables: [organizations, projects] });
}

async function withApp<S extends QuerySchema & { readonly catalog: Catalog }>(
  app: S,
  fn: (db: Connected<S>) => Promise<void>,
): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
    try {
      await db.connected;
      await fn(db);
    } finally {
      await db.close();
    }
  });
}

function handles(columns: object, ...fields: readonly string[]): { readonly name: string }[] {
  const record = columns as Readonly<Record<string, { readonly name: string }>>;
  return fields.map((field) => {
    const handle = record[field];
    if (handle === undefined) throw new Error(`missing ${field}`);
    return handle;
  });
}

function countOf(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null && "count" in value) {
    const count = (value as { readonly count: unknown }).count;
    if (typeof count === "number") return count;
  }
  return -1;
}

async function expectCode(pending: Promise<unknown>, code: string): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
