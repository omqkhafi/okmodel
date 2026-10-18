/**
 * Factories, `expectQueries`, and the isolation check on PGlite (D199).
 *
 * The database is the real driver. Nothing here mocks a pool.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import {
  boolean,
  id,
  identity,
  integer,
  many,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { columnTenancy, compositeTenancy, global } from "../src/runtime/tenancy/index.js";
import { tenantProbe } from "../src/tooling/testing/facts.js";
import { testing } from "../src/tooling/testing/index.js";
import { gateApp, TENANT_TABLES } from "./gate-schema.js";
import { app as relationsApp } from "./relations-schema.js";

const lists = table(
  "lists",
  { id: id({ default: "none" }), name: text() },
  { relations: { tasks: many("tasks", "listId") } },
);

const tasks = table("tasks", {
  id: id({ default: "none" }),
  title: text(),
  listId: uuid().references("lists"),
  done: boolean().default(false),
  rank: integer().default(0),
});

const notes = table("notes", {
  id: id({ default: "none" }),
  body: text(),
});

const plain = schema({ tables: [lists, tasks, notes] });

test("factories create, reuse a ref, fill defaults, and replay a seed", async () => {
  const first = await testing(plain, { driver: openPglite(), seed: 4 });
  const second = await testing(plain, { driver: openPglite(), seed: 4 });
  try {
    const factories = first.factories({
      lists: (x) => ({ name: x.words(2) }),
      tasks: (x) => ({ title: x.words(3), listId: x.ref("lists") }),
      notes: () => ({}),
    });
    const again = second.factories({
      lists: (x) => ({ name: x.words(2) }),
      tasks: (x) => ({ title: x.words(3), listId: x.ref("lists") }),
      notes: () => ({}),
    });

    const created = await factories.notes.createMany(3);
    expect(created).toHaveLength(3);
    const bodies = created.map((row) => row.body);
    expect(bodies.every((body) => typeof body === "string" && body.length > 0)).toBe(true);
    expect(new Set(bodies).size).toBe(3);
    expect((await again.notes.create()).body).toBe(bodies[0]);

    const parent = await factories.lists.with({ tasks: 2 }).create();
    const children = await first.db.tasks.find({ limit: 10 });
    expect(children).toHaveLength(2);
    expect(children.every((row) => row.listId === parent.id)).toBe(true);

    const left = await factories.tasks.create();
    const right = await factories.tasks.create();
    expect(left.listId).toBe(parent.id);
    expect(right.listId).toBe(parent.id);
    expect(await first.db.lists.find({ limit: 10 })).toHaveLength(1);
  } finally {
    await first.close();
    await second.close();
  }
});

test("expectQueries counts data statements and shows them on a miss", async () => {
  const harness = await testing(plain, { driver: openPglite() });
  try {
    await harness.expectQueries(1, () => harness.db.notes.find({ limit: 1 }));
    await harness.expectQueries(1, () => harness.db.tx((tx) => tx.notes.find({ limit: 1 })));
    let failure: unknown;
    try {
      await harness.expectQueries(0, () => harness.db.notes.find({ limit: 1 }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OkmError);
    if (!(failure instanceof OkmError)) return;
    expect(failure.message).toContain("expected 0 queries, ran 1");
    expect(failure.message.toLowerCase()).toContain("select");
  } finally {
    await harness.close();
  }
});

test("isolation passes on the fixture schemas and fails when the predicate is dropped", async () => {
  const gate = await testing(gateApp, { driver: openPglite() });
  try {
    const report = await gate.isolation();
    expect([...report.checked]).toEqual([...TENANT_TABLES]);
    expect(report.skipped).toEqual([{ table: "countries", reason: "shared reference data" }]);
  } finally {
    await gate.close();
  }

  const related = await testing(relationsApp, { driver: openPglite() });
  try {
    const report = await related.isolation();
    expect([...report.checked]).toEqual(["labels", "tasks", "taskLabels", "ledger"]);
    expect(report.skipped).toEqual([]);
  } finally {
    await related.close();
  }

  const secret = table("notes", { id: id({ default: "none" }), body: text() });
  const leak = schema({ tenancy: leakingTenancy("tenantId"), tables: [secret] });
  const harness = await testing(leak, { driver: openPglite() });
  try {
    let failure: unknown;
    try {
      await harness.isolation();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OkmError);
    if (!(failure instanceof OkmError)) return;
    expect(failure.message).toContain("Isolation leak on notes.find");
    expect(failure.message).toContain("body");
  } finally {
    await harness.close();
  }
}, 30_000);

test("B-34: testing populates concurrent matviews so refresh() works", async () => {
  const app = schema({
    casing: "snake",
    tenancy: columnTenancy({ key: "workspaceId", type: "uuid" }),
    tables: [table("projects", { id: id({ default: "none" }), name: text() })],
    views: [
      materializedView("project_titles", {
        columns: [
          { name: "workspace_id", type: "uuid" },
          { name: "name", type: "text" },
        ],
        query: "select workspace_id, name from projects",
        refresh: "concurrently",
        indexes: [{ columns: ["workspace_id"], unique: true }],
      }),
    ],
  });
  const harness = await testing(app, { driver: openPglite() });
  try {
    const factories = harness.factories({
      projects: (x) => ({ name: x.words(2) }),
    });
    await factories.projects.create();
    // Without the setup populate this is "not populated" (B-34).
    await harness.db.views.projectTitles.refresh();
    const report = await harness.isolation();
    expect([...report.views]).toEqual(["projectTitles"]);
  } finally {
    await harness.close();
  }
}, 30_000);

test("isolation reads a tenant view and a materialized view, and skips a global view", async () => {
  const withView = (tenancy: ReturnType<typeof columnTenancy>) =>
    schema({
      casing: "snake",
      tenancy,
      tables: [table("projects", { id: id({ default: "none" }), name: text() })],
      views: [
        view("project_names", {
          columns: [
            { name: "workspace_id", type: "uuid" },
            { name: "name", type: "text" },
          ],
          query: " SELECT workspace_id,\n    name\n   FROM projects;",
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
  const harness = await testing(withView(columnTenancy({ key: "workspaceId", type: "uuid" })), {
    driver: openPglite(),
  });
  try {
    const report = await harness.isolation();
    expect([...report.checked]).toEqual(["projects"]);
    expect([...report.views]).toEqual(["projectNames", "projectDirectory"]);
    expect(report.skipped).toEqual([{ table: "sharedTitles", reason: "shared titles" }]);
  } finally {
    await harness.close();
  }

  const leaking = await testing(withView(leakingTenancy("workspaceId")), { driver: openPglite() });
  try {
    let failure: unknown;
    try {
      await leaking.isolation();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OkmError);
    expect(failure instanceof OkmError ? failure.message : "").toContain(
      "Isolation leak on projects.find",
    );
  } finally {
    await leaking.close();
  }

  const real = columnTenancy({ key: "workspaceId", type: "uuid" });
  const viewLeak = {
    ...real,
    predicate(input: Parameters<typeof real.predicate>[0]): boolean {
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
  };
  const viewsOnly = await testing(withView(viewLeak), { driver: openPglite() });
  try {
    let failure: unknown;
    try {
      await viewsOnly.isolation();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OkmError);
    expect(failure instanceof OkmError ? failure.message : "").toContain(
      "Isolation leak on projectNames.find",
    );
  } finally {
    await viewsOnly.close();
  }
}, 30_000);

/** Column tenancy that answers the probe and drops the predicate on real queries. */
function leakingTenancy(key: string): ReturnType<typeof columnTenancy> {
  const real = columnTenancy({ key, type: "uuid" });
  return {
    ...real,
    predicate(input: Parameters<typeof real.predicate>[0]): boolean {
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

const directory = table(
  "tenants",
  { id: id({ default: "none" }), name: text() },
  { tenancy: global("tenant directory") },
);

const users = table(
  "users",
  { id: id({ default: "none" }), email: text(), name: text() },
  { relations: { tasks: many("tasks", "userId") } },
);

const listsForSpec = table("lists", { id: id({ default: "none" }), name: text() });

const ownedTasks = table("tasks", {
  id: id({ default: "none" }),
  title: text(),
  listId: uuid().references("lists"),
  userId: uuid().references("users"),
});

const appSchema = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [directory, users, listsForSpec, ownedTasks],
});

test("the section 20 example keeps tenant B's rows out of tenant A", async () => {
  const harness = await testing(appSchema, { driver: openPglite(), seed: 1 });
  try {
    const factories = harness.factories({
      tenants: (x) => ({ name: x.words(2) }),
      users: (x) => ({ email: x.email(), name: x.name() }),
      lists: (x) => ({ name: x.words(2) }),
      tasks: (x) => ({ title: x.words(3), listId: x.ref("lists") }),
    });
    const created = await factories.tenants.createMany(2);
    const a = created[0];
    const b = created[1];
    if (a === undefined || b === undefined) throw new Error("createMany(2) returned fewer rows");
    const tenantA = idOf(a);
    const tenantB = idOf(b);
    await factories.tasks.create({ tenantId: tenantB });
    expect(await harness.db.for({ tenantId: tenantA }).tasks.count()).toBe(0);
    const tenant = idOf(await factories.tenants.create());
    const user = await factories.users.with({ tasks: 20 }).create({ tenantId: tenant });
    await harness.expectQueries(1, () =>
      loadToday(harness.db.for({ tenantId: tenant }), idOf(user)),
    );
  } finally {
    await harness.close();
  }
});

test("QA-M8: isolation passes twice, after existing rows, and names a missing factory", async () => {
  const harness = await testing(appSchema, { driver: openPglite() });
  try {
    const factories = harness.factories({
      users: (x) => ({ email: x.email(), name: x.name() }),
      lists: (x) => ({ name: x.words(2) }),
      tasks: (x) => ({ title: x.words(3), listId: x.ref("lists"), userId: x.ref("users") }),
    });
    await factories.tasks.create();
    const first = await harness.isolation();
    const second = await harness.isolation();
    expect([...first.checked].sort()).toEqual(["lists", "tasks", "users"]);
    expect([...second.checked].sort()).toEqual(["lists", "tasks", "users"]);
    expect(first.skipped).toEqual([{ table: "tenants", reason: "tenant directory" }]);
  } finally {
    await harness.close();
  }

  const partial = await testing(appSchema, { driver: openPglite() });
  try {
    partial.factories({
      users: (x) => ({ email: x.email(), name: x.name() }),
    });
    let failure: unknown;
    try {
      await partial.isolation();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OkmError);
    expect(failure instanceof OkmError ? failure.message : "").toContain("Factory lists");
  } finally {
    await partial.close();
  }
});

test("factories and isolation work under compositeTenancy", async () => {
  const notes = table(
    "notes",
    { id: id({ default: "none" }), body: text() },
    { relations: { items: many("items", "noteId") } },
  );
  const items = table("items", {
    id: id({ default: "none" }),
    noteId: uuid().references("notes"),
    title: text(),
  });
  const composite = schema({
    tables: [notes, items],
    tenancy: compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
  });
  const harness = await testing(composite, { driver: openPglite() });
  try {
    const factories = harness.factories({
      notes: (x) => ({ body: x.words(2) }),
      items: (x) => ({ title: x.words(2), noteId: x.ref("notes") }),
    });
    const parent = await factories.notes.create();
    expect(typeof parent.organizationId).toBe("string");
    expect(typeof parent.workspaceId).toBe("string");
    // B-32: each composite key gets its own generated uuid.
    expect(parent.workspaceId).not.toBe(parent.organizationId);
    const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ws = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const explicit = await factories.notes.create({ organizationId: org, workspaceId: ws });
    expect(explicit.organizationId).toBe(org);
    expect(explicit.workspaceId).toBe(ws);
    let partial: unknown;
    try {
      await factories.notes.create({ organizationId: org });
    } catch (error) {
      partial = error;
    }
    expect(partial).toBeInstanceOf(OkmError);
    expect(partial instanceof OkmError ? partial.message : "").toContain("Missing workspaceId");
    const scope = {
      organizationId: parent.organizationId as string,
      workspaceId: parent.workspaceId as string,
    };
    const child = await factories.items.create(scope);
    expect(child.noteId).toBe(parent.id);
    expect(child.organizationId).toBe(parent.organizationId);
    expect(child.workspaceId).toBe(parent.workspaceId);
    const report = await harness.isolation();
    expect([...report.checked].sort()).toEqual(["items", "notes"]);
    await Promise.all(Array.from({ length: 20 }, () => factories.items.create(scope)));
  } finally {
    await harness.close();
  }
});

test("B-32: isolation under compositeTenancy with identity primary keys", async () => {
  const lists = table("lists", { id: identity() });
  const app = schema({
    tables: [lists],
    tenancy: compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
  });
  const harness = await testing(app, { driver: openPglite() });
  try {
    harness.factories({ lists: () => ({}) });
    const report = await harness.isolation();
    expect([...report.checked]).toEqual(["lists"]);
  } finally {
    await harness.close();
  }
}, 30_000);

test("concurrent factory creates of related rows do not report a factory cycle", async () => {
  const harness = await testing(plain, { driver: openPglite() });
  try {
    const factories = harness.factories({
      lists: (x) => ({ name: x.words(2) }),
      tasks: (x) => ({ title: x.words(3), listId: x.ref("lists") }),
      notes: () => ({}),
    });
    await Promise.all(Array.from({ length: 20 }, () => factories.tasks.create()));
    expect(await harness.db.tasks.count()).toBe(20);
  } finally {
    await harness.close();
  }
});

function loadToday(
  db: { tasks: { find(options: object): Promise<unknown> } },
  userId: string,
): Promise<unknown> {
  return db.tasks.find({ where: { userId }, limit: 20 });
}

function idOf(row: Record<string, unknown>): string {
  const id = row.id;
  if (typeof id !== "string") throw new Error("row.id is not a string");
  return id;
}
