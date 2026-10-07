/**
 * Factories, `expectQueries`, and the isolation check on PGlite (D199).
 *
 * The database is the real driver. Nothing here mocks a pool.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { boolean, id, integer, many, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { view } from "../src/dialects/pg/view/index.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";
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
});

test("isolation checks the tables of a schema with a tenant view and leaves the view out", async () => {
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
      ],
    });
  const harness = await testing(withView(columnTenancy({ key: "workspaceId", type: "uuid" })), {
    driver: openPglite(),
  });
  try {
    const report = await harness.isolation();
    expect([...report.checked]).toEqual(["projects"]);
    expect(report.skipped).toEqual([]);
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
});

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
