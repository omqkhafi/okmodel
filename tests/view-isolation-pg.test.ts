/**
 * View isolation on real Postgres.
 *
 * A tenant view and a materialized view are read, not inserted into. A view
 * that hides the tenant key is global and listed. Row-level security uses
 * `security_invoker`. An external table under `rlsTenancy` is owned by
 * another role.
 */

import { expect } from "bun:test";
import postgres from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, index, one, schema, table, text, uuid, withOwner } from "../src/dialects/pg/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import {
  columnTenancy,
  compositeTenancy,
  global,
  rlsTenancy,
  via,
  type ColumnTenancy,
} from "../src/runtime/tenancy/index.js";
import { RlsRoleError } from "../src/runtime/tenancy/rls.js";
import { tenantProbe } from "../src/tooling/testing/facts.js";
import { testing } from "../src/tooling/testing/index.js";

const gate = await loadPostgresGate();
const PASSWORD = "viewisolation";

postgresTest(
  gate,
  "column isolation reads a view and a materialized view and skips a global view",
  async () => {
    const report = await runIsolation(
      columnSchema(columnTenancy({ key: "workspaceId", type: "uuid" })),
    );
    expect(report.checked).toEqual(["projects"]);
    expect(report.views).toEqual(["projectNames", "projectDirectory"]);
    expect(report.skipped).toEqual([{ table: "sharedTitles", reason: "shared titles" }]);
  },
  60_000,
);

postgresTest(
  gate,
  "a view whose predicate is dropped is an isolation leak",
  async () => {
    const real = columnTenancy({ key: "workspaceId", type: "uuid" });
    const failure = await runLeak(
      columnSchema({
        ...real,
        predicate(input: Parameters<ColumnTenancy["predicate"]>[0]): boolean {
          if (
            input.scope !== undefined &&
            "value" in input.scope &&
            input.scope.value === tenantProbe
          ) {
            return real.predicate(input);
          }
          if (input.table === "projectNames") return false;
          return real.predicate(input);
        },
      }),
    );
    expect(failure.message).toContain("Isolation leak on projectNames.find");
  },
  60_000,
);

postgresTest(
  gate,
  "composite isolation reads a view that exposes every key",
  async () => {
    const report = await runIsolation(compositeSchema());
    expect(report.checked).toContain("documents");
    expect(report.views).toEqual(["documentTitles"]);
  },
  60_000,
);

postgresTest(
  gate,
  "path isolation reads a view over the child and its parent",
  async () => {
    const report = await runIsolation(pathSchema());
    expect(report.checked).toContain("projects");
    expect(report.views).toEqual(["projectNames"]);
  },
  60_000,
);

postgresTest(
  gate,
  "rls isolation reads a security_invoker view and an external table owned by another role",
  async () => {
    const notes = withOwner(
      table("notes", { id: id({ default: "none" }), title: text() }),
      "external",
    );
    const built = schema({
      casing: "snake",
      tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
      tables: [notes],
      views: [
        view("open_notes", {
          columns: [
            { name: "id", type: "uuid" },
            { name: "tenant_id", type: "uuid" },
            { name: "title", type: "text" },
          ],
          query: "select id, tenant_id, title from notes",
        }),
      ],
    });
    const database = await createIsolatedDatabase();
    const admin = postgres(database.url, { max: 1 });
    const appRole = `a_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const ownerRole = `o_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      for (const statement of renderCatalog(built.catalog, "public")) {
        await admin.unsafe(statement);
      }
      const options = await admin<{ options: string | null }[]>`
        select array_to_string(c.reloptions, ',') as options
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'open_notes'
      `;
      expect(options[0]?.options ?? "").toContain("security_invoker=true");
      await admin.unsafe(
        `create role ${appRole} login password '${PASSWORD}' nosuperuser nobypassrls`,
      );
      await admin.unsafe(
        `create role ${ownerRole} login password '${PASSWORD}' nosuperuser nobypassrls`,
      );
      const dbName = new URL(database.url).pathname.slice(1);
      for (const role of [appRole, ownerRole]) {
        await admin.unsafe(`grant connect on database ${dbName} to ${role}`);
        await admin.unsafe(`grant usage on schema public to ${role}`);
        await admin.unsafe(
          `grant select, insert, update, delete on all tables in schema public to ${role}`,
        );
      }
      await admin.unsafe(`alter table public.notes owner to ${ownerRole}`);
      const appUrl = roleUrl(database.url, appRole);
      const harness = await testing(built, { driver: open({ url: appUrl }), migrate: false });
      try {
        const report = await harness.isolation();
        expect(report.checked).toEqual(["notes"]);
        expect(report.views).toEqual(["openNotes"]);
      } finally {
        await harness.close();
      }
      const owner = connect(roleUrl(database.url, ownerRole), { schema: built, max: 1 });
      try {
        let thrown: unknown;
        try {
          await owner.for({ tenantId: crypto.randomUUID() }).notes.find({ limit: 1 });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(RlsRoleError);
        if (thrown instanceof RlsRoleError) expect(thrown.reason).toBe("owner");
      } finally {
        await owner.close();
      }
    } finally {
      await admin.unsafe(`reassign owned by ${ownerRole} to current_user`).catch(() => undefined);
      await admin.unsafe(`drop owned by ${ownerRole}`).catch(() => undefined);
      await admin.unsafe(`drop role if exists ${ownerRole}`).catch(() => undefined);
      await admin.unsafe(`drop role if exists ${appRole}`).catch(() => undefined);
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

function columnSchema(tenancy: ColumnTenancy) {
  return schema({
    casing: "snake",
    tenancy,
    tables: [table("projects", { id: id({ default: "none" }), name: text() })],
    views: [
      view("project_names", {
        columns: [
          { name: "workspace_id", type: "uuid" },
          { name: "name", type: "text" },
        ],
        query: "select workspace_id, name from projects",
      }),
      materializedView("project_directory", {
        columns: [
          { name: "workspace_id", type: "uuid" },
          { name: "name", type: "text" },
        ],
        query: "select workspace_id, name from projects",
      }),
      view("shared_titles", {
        columns: [{ name: "name", type: "text" }],
        query: "select name from projects",
        tenancy: global("shared titles"),
      }),
    ],
  });
}

function compositeSchema() {
  return schema({
    casing: "snake",
    tenancy: compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
    tables: [
      table(
        "documents",
        { id: id({ default: "none" }), title: text() },
        { indexes: (columns) => [index(...handles(columns, "organizationId", "workspaceId"))] },
      ),
    ],
    views: [
      view("document_titles", {
        columns: [
          { name: "organization_id", type: "uuid" },
          { name: "workspace_id", type: "uuid" },
          { name: "title", type: "text" },
        ],
        query: "select organization_id, workspace_id, title from documents",
      }),
    ],
  });
}

function pathSchema() {
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
  return schema({
    casing: "snake",
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
    tables: [organizations, projects],
    views: [
      view("project_names", {
        columns: [
          { name: "tenant_id", type: "uuid" },
          { name: "name", type: "text" },
        ],
        query:
          "select organizations.tenant_id, projects.name from projects join organizations on organizations.id = projects.organization_id",
      }),
    ],
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

async function runIsolation(app: Parameters<typeof testing>[0]) {
  const database = await createIsolatedDatabase();
  try {
    const harness = await testing(app, { driver: open({ url: database.url }) });
    try {
      return await harness.isolation();
    } finally {
      await harness.close();
    }
  } finally {
    await database.close();
  }
}

async function runLeak(app: Parameters<typeof testing>[0]): Promise<OkmError> {
  const database = await createIsolatedDatabase();
  try {
    const harness = await testing(app, { driver: open({ url: database.url }) });
    try {
      let failure: unknown;
      try {
        await harness.isolation();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OkmError);
      if (!(failure instanceof OkmError)) throw new Error("expected OkmError");
      return failure;
    } finally {
      await harness.close();
    }
  } finally {
    await database.close();
  }
}

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}
