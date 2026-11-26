/**
 * View and materialized view declarations, and the plan that applies them.
 *
 * Postgres execution, scratch verification, and introspection are in
 * `views-pg.test.ts`.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { viewObject } from "../src/contracts/catalog/view.js";
import { OkmError } from "../src/contracts/error.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { open } from "../src/adapters/pg/pglite.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";
import { repoRoot } from "../scripts/root.js";
import { checkProject } from "../src/tooling/migrate/project.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });

test("appending a column is create or replace, and removing one drops and recreates", () => {
  const before = schema({
    tables: [tasks],
    views: [
      view("active_tasks", { tables: [] }, (q) =>
        q.sql({
          columns: [{ name: "id", type: t.text() }],
          query: "select id from tasks",
        }),
      ),
    ],
  });
  const appended = schema({
    tables: [tasks],
    views: [
      view("active_tasks", { tables: [] }, (q) =>
        q.sql({
          columns: [
            { name: "id", type: t.text() },
            { name: "title", type: t.text() },
          ],
          query: "select id, title from tasks",
        }),
      ),
    ],
  });
  const compatible = planMigration({
    before: before.catalog,
    after: appended.catalog,
    name: "append",
  });
  const compatibleSql = compatible.steps.map((step) => step.sql).join("\n");
  expect(compatibleSql).toContain("create or replace view");
  expect(compatible.steps.some((step) => step.behavior === "change")).toBe(true);
  expect(compatibleSql.toLowerCase()).not.toContain("cascade");
  expect(compatible.steps.some((step) => step.sql.startsWith("drop "))).toBe(false);

  const removed = schema({
    tables: [tasks],
    views: [
      view("active_tasks", { tables: [] }, (q) =>
        q.sql({
          columns: [{ name: "title", type: t.text() }],
          query: "select title from tasks",
        }),
      ),
    ],
  });
  const incompatible = planMigration({
    before: appended.catalog,
    after: removed.catalog,
    name: "remove",
  });
  const sql = incompatible.steps.map((step) => step.sql);
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
  expect(sql.some((step) => step.startsWith("create or replace"))).toBe(false);
  expect(indexOf(sql, "drop view")).toBeLessThan(indexOf(sql, "create view"));
});

test("a column type change drops the view, alters, and recreates it", () => {
  const before = dependOnTitle(
    schema({
      tables: [tasks],
      views: [
        view("active_tasks", { tables: [] }, (q) =>
          q.sql({
            columns: [
              { name: "id", type: t.text() },
              { name: "title", type: t.text() },
            ],
            query: "select id, title from tasks",
          }),
        ),
      ],
    }).catalog,
  );
  const after = schema({
    tables: [table("tasks", { id: t.text().primaryKey(), title: t.integer() })],
    views: [
      view("active_tasks", { tables: [] }, (q) =>
        q.sql({
          columns: [
            { name: "id", type: t.text() },
            { name: "title", type: t.integer() },
          ],
          query: "select id, title from tasks",
        }),
      ),
    ],
  });
  const plan = planMigration({ before, after: after.catalog, name: "type" });
  const sql = plan.steps.map((step) => step.sql);
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
  expect(sql.some((step) => step.startsWith("create or replace"))).toBe(false);
  expect(indexOf(sql, "drop view")).toBeLessThan(indexOf(sql, "alter table"));
  expect(indexOf(sql, "alter table")).toBeLessThan(indexOf(sql, "create view"));
  expect(sql.some((step) => step.includes("set data type"))).toBe(true);
});

test("drop goes view then table, and a leftover dependent is OKM1821", () => {
  const before = dependOnTitle(
    schema({
      tables: [tasks],
      views: [
        view("active_tasks", { tables: [] }, (q) =>
          q.sql({
            columns: [{ name: "title", type: t.text() }],
            query: "select title from tasks",
          }),
        ),
      ],
    }).catalog,
  );
  const sql = planMigration({ before, after: catalog([]), name: "drop" }).steps.map(
    (step) => step.sql,
  );
  expect(indexOf(sql, "drop view")).toBeLessThan(indexOf(sql, "drop table"));
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");

  const after = {
    version: before.version,
    objects: before.objects.filter(
      (object) => !(object.kind === "column" && object.identity.name === "title"),
    ),
  };
  expect(capture(() => planMigration({ before, after, name: "stuck" })).code).toBe("OKM1821");
});

test("a materialized view is created with no data, populated, and refreshes concurrently", () => {
  const app = schema({
    tables: [tasks],
    views: [
      materializedView(
        "task_titles",
        {
          tables: [],
          indexes: (columns) => [index(columns.id).unique().name("task_titles_id")],
          refresh: "concurrently",
        },
        (q) =>
          q.sql({
            columns: [
              { name: "id", type: t.text() },
              { name: "title", type: t.text() },
            ],
            query: "select id, title from tasks",
          }),
      ),
    ],
  });
  const plan = planMigration({ before: catalog([]), after: app.catalog, name: "create" });
  const sql = plan.steps.map((step) => step.sql);
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
  expect(sql.some((step) => step.includes("with no data"))).toBe(true);
  expect(indexOf(sql, "create materialized view")).toBeLessThan(
    indexOf(sql, "create unique index"),
  );
  expect(indexOf(sql, "create unique index")).toBeLessThan(
    indexOf(sql, "refresh materialized view"),
  );
  expect(sql.some((step) => step.startsWith("refresh materialized view concurrently"))).toBe(false);
  const refresh = plan.steps.find((step) => step.sql.startsWith("refresh"));
  expect(refresh?.action).toBe("backfill");

  const changed = schema({
    tables: [tasks],
    views: [
      materializedView(
        "task_titles",
        {
          tables: [],
          indexes: (columns) => [index(columns.title).unique().name("task_titles_title")],
          refresh: "concurrently",
        },
        (q) =>
          q.sql({
            columns: [{ name: "title", type: t.text() }],
            query: "select title from tasks",
          }),
      ),
    ],
  });
  const replace = planMigration({
    before: app.catalog,
    after: changed.catalog,
    name: "change",
  });
  const replaced = replace.steps.map((step) => step.sql);
  expect(replaced.some((step) => step.startsWith("create or replace"))).toBe(false);
  expect(indexOf(replaced, "drop index")).toBeLessThan(indexOf(replaced, "drop materialized view"));
  expect(indexOf(replaced, "drop materialized view")).toBeLessThan(
    indexOf(replaced, "create materialized view"),
  );
});

test("concurrent refresh without a unique index is OKM1822", () => {
  const error = capture(() =>
    materializedView("task_titles", { tables: [], refresh: "concurrently" }, (q) =>
      q.sql({
        columns: [{ name: "title", type: t.text() }],
        query: "select title from tasks",
      }),
    ),
  );
  expect(error.code).toBe("OKM1822");
});

test("a view over a tenant table is OKM1820 unless it exposes the key or is global", () => {
  const tenant = columnTenancy({ key: "tenantId", type: "uuid" });
  const hidden = () =>
    schema({
      casing: "snake",
      tenancy: tenant,
      tables: [tasks],
      views: [
        view("titles", { tables: [] }, (q) =>
          q.sql({
            columns: [{ name: "title", type: t.text() }],
            query: "select title from tasks",
          }),
        ),
      ],
    });
  expect(capture(hidden).code).toBe("OKM1820");

  const opened = schema({
    casing: "snake",
    tenancy: tenant,
    tables: [tasks],
    views: [
      view("titles", { tables: [] }, (q) =>
        q.sql({
          columns: [
            { name: "tenant_id", type: t.uuid() },
            { name: "title", type: t.text() },
          ],
          query: "select tenant_id, title from tasks",
        }),
      ),
    ],
  });
  expect(Object.hasOwn(opened.model, "titles")).toBe(true);

  const shared = schema({
    casing: "snake",
    tenancy: tenant,
    tables: [tasks],
    views: [
      view("titles", { tables: [], tenancy: global("shared titles") }, (q) =>
        q.sql({
          columns: [{ name: "title", type: t.text() }],
          query: "select title from tasks",
        }),
      ),
    ],
  });
  expect(Object.hasOwn(shared.model, "titles")).toBe(true);

  const countries = table(
    "countries",
    { id: t.text().primaryKey() },
    { tenancy: global("shared") },
  );
  const reference = schema({
    casing: "snake",
    tenancy: tenant,
    tables: [countries],
    views: [
      view("country_ids", { tables: [] }, (q) =>
        q.sql({
          columns: [{ name: "id", type: t.text() }],
          query: "select id from countries",
        }),
      ),
    ],
  });
  expect(Object.hasOwn(reference.model, "countryIds")).toBe(true);
});

test("okm check fails with OKM1820 for a view that hides the tenant key", async () => {
  const root = repoRoot();
  const cwd = mkdtempSync(join(tmpdir(), "okm-view-"));
  const header = [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    `import { view } from ${JSON.stringify(join(root, "src/dialects/pg/view/index.ts"))};`,
    `import { columnTenancy } from ${JSON.stringify(join(root, "src/runtime/tenancy/index.ts"))};`,
  ].join("\n");
  writeFileSync(
    join(cwd, "schema.ts"),
    `${header}
const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
export const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tasks],
  views: [view("titles", { tables: [] }, (q) => q.sql({ columns: [{ name: "title", type: t.text() }], query: "select title from tasks" }))],
});
`,
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};
export default defineConfig({ schema: "./schema.ts" });
`,
  );
  let failed: OkmError | undefined;
  try {
    await checkProject(cwd);
  } catch (error) {
    if (error instanceof OkmError) failed = error;
    else throw error;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  expect(failed?.code).toBe("OKM1820");
});

function dependOnTitle(source: Catalog): Catalog {
  const title = source.objects.find(
    (object) =>
      object.kind === "column" &&
      object.identity.name === "title" &&
      object.identity.parent.name === "tasks",
  );
  if (title === undefined) throw new Error("title column missing");
  const objects = source.objects.map((object) => {
    if (object.kind !== "view") return object;
    return viewObject({
      namespace: object.identity.namespace,
      name: object.identity.name,
      columns: object.definition.columns,
      query: object.definition.query,
      provenance: object.provenance,
      dependencies: [title.identity],
      ...(object.definition.securityInvoker === true ? { securityInvoker: true as const } : {}),
      ...(object.definition.securityBarrier === true ? { securityBarrier: true as const } : {}),
      ...(object.definition.checkOption !== undefined
        ? { checkOption: object.definition.checkOption }
        : {}),
    });
  });
  return catalog(objects);
}

test("a plain view has no refresh at runtime", async () => {
  const app = schema({
    tables: [tasks],
    views: [
      view("active_tasks", { tables: [] }, (q) =>
        q.sql({
          columns: [{ name: "id", type: t.text() }],
          query: "select id from tasks",
        }),
      ),
      materializedView("task_titles", { tables: [] }, (q) =>
        q.sql({
          columns: [{ name: "title", type: t.text() }],
          query: "select title from tasks",
        }),
      ),
    ],
  });
  const db = await connect(await open(), { schema: app });
  try {
    expect(Reflect.get(db.views.activeTasks, "refresh")).toBeUndefined();
    expect(typeof db.views.taskTitles.refresh).toBe("function");
  } finally {
    await db.close();
  }
});

test("views that read each other in a cycle are OKM1900", () => {
  const peers: { readonly name: string }[] = [];
  const first = view("first_view", { tables: peers as never }, ((q: {
    readonly second_view: { find: () => unknown };
  }) => q.second_view.find()) as never);
  const second = view("second_view", { tables: peers as never }, ((q: {
    readonly first_view: { find: () => unknown };
  }) => q.first_view.find()) as never);
  peers.push(first, second);
  const error = capture(() => schema({ tables: [], views: [first, second] }).catalog);
  expect(error.code).toBe("OKM1900");
  expect(error.message).toContain("first_view");
  expect(error.message).toContain("second_view");
});

test("materializedView refuses a refresh value other than concurrently", () => {
  const error = capture(() =>
    materializedView("daily", { tables: [], refresh: "blocking" as "concurrently" }, (q) =>
      q.sql({
        columns: [{ name: "id", type: t.text() }],
        query: "select id from tasks",
      }),
    ),
  );
  expect(error.code).toBe("OKM1120");
  expect(error.kind).toBe("invalid");
  expect(error.message).toContain('must be "concurrently"');
});

test("a view over a tenant table can select the tenant key", () => {
  const notes = table("notes", { id: t.text().primaryKey(), title: t.text() });
  const app = schema({
    casing: "snake",
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
    tables: [notes],
    views: [
      view("open_notes", { tables: [notes] }, (q) =>
        q.notes.find({ select: ["tenantId", "title"] }),
      ),
    ],
  });
  const found = app.catalog.objects.find(
    (object) => object.kind === "view" && object.identity.name === "open_notes",
  );
  expect(found?.kind === "view" ? found.definition.query : "").toBe(
    'select t."tenant_id" as "tenant_id", t."title" as "title" from "notes" t',
  );
});

function indexOf(sql: readonly string[], prefix: string): number {
  const found = sql.findIndex((step) => step.startsWith(prefix));
  if (found < 0) throw new Error(`missing ${prefix} in ${sql.join(" | ")}`);
  return found;
}

function capture(runBody: () => unknown): OkmError {
  try {
    runBody();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}
