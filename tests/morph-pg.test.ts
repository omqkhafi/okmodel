/**
 * Polymorphic include, the reverse many, and tenancy, on real Postgres.
 *
 * A comment points at a task or a list. The type column stores the table name.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import {
  has,
  id,
  morph,
  morphMany,
  morphTo,
  none,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d01";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d02";

const tasks = table(
  "tasks",
  { id: id({ default: "none" }), title: text() },
  {
    traits: [archivable()],
    presets: { kept: (q) => q.where({ title: "keep" }) },
    relations: { comments: morphMany("comments", "commentable") },
  },
);
const lists = table(
  "lists",
  { id: id({ default: "none" }), name: text() },
  { relations: { comments: morphMany("comments", "commentable") } },
);
const comments = table(
  "comments",
  {
    id: id({ default: "none" }),
    body: text(),
    commentableType: text(),
    commentableId: uuid(),
  },
  {
    traits: [archivable()],
    presets: { onTasks: (q) => q.where({ commentableType: "tasks" }) },
    relations: { commentable: morph("commentable", ["tasks", "lists"]) },
  },
);

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tasks, lists, comments],
});

const gate = await loadPostgresGate();
type Db = ReturnType<typeof connect<typeof app>>;

async function withApp(run: (db: Db) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      await run(db);
    } finally {
      await db.close();
    }
  });
}

postgresTest(
  gate,
  "a morph declaration that names a missing table fails before a query",
  async () => {
    const {
      schema: build,
      table: declare,
      id: key,
      text: words,
      uuid: idColumn,
      morph: link,
    } = { schema, table, id, text, uuid, morph };
    const error = (() => {
      try {
        build({
          tables: [
            declare("tasks", { id: key({ default: "none" }) }),
            declare(
              "comments",
              {
                id: key({ default: "none" }),
                commentableType: words(),
                commentableId: idColumn(),
              },
              { relations: { commentable: link("commentable", ["tasks", "missing"]) } },
            ),
          ],
        });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(OkmError);
    if (!(error instanceof OkmError)) return;
    expect(error.code).toBe("OKM1020");
    expect(error.message).toContain("missing");
    expect(error.message).toContain("comments.commentable");
  },
);

postgresTest(
  gate,
  "morph include returns each target, a missing row, and stays inside the tenant",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      const taskId = crypto.randomUUID();
      const listId = crypto.randomUUID();
      const gone = crypto.randomUUID();
      await a.tasks.insert([
        { id: taskId, title: "keep" },
        { id: crypto.randomUUID(), title: "drop" },
      ]);
      await a.lists.insert({ id: listId, name: "inbox" });
      await b.tasks.insert({ id: taskId, title: "other" });
      await a.comments.insert([
        { id: crypto.randomUUID(), body: "on task", ...morphTo("commentable", "tasks", taskId) },
        { id: crypto.randomUUID(), body: "on list", ...morphTo("commentable", "lists", listId) },
        { id: crypto.randomUUID(), body: "gone", ...morphTo("commentable", "tasks", gone) },
      ]);
      await b.comments.insert({
        id: crypto.randomUUID(),
        body: "b",
        ...morphTo("commentable", "tasks", taskId),
      });

      const rows = await a.comments.find({
        include: { commentable: true },
        orderBy: { body: "asc" },
        limit: 10,
      });
      const byBody = new Map(rows.map((row) => [row.body, row.commentable]));
      expect(byBody.get("gone")).toBeNull();
      expect(byBody.get("on list")).toMatchObject({ name: "inbox", commentableType: "lists" });
      expect(byBody.get("on task")).toMatchObject({ title: "keep", commentableType: "tasks" });

      const onlyTasks = await a.comments.onTasks().find({
        include: { commentable: true },
        limit: 10,
      });
      expect(onlyTasks.map((row) => row.body).sort()).toEqual(["gone", "on task"]);

      const other = await b.comments.find({ include: { commentable: true }, limit: 5 });
      expect(other[0]?.commentable).toMatchObject({ title: "other", commentableType: "tasks" });
      expect(other[0]?.body).toBe("b");

      const kept = await a.tasks.kept().find({
        include: { comments: { limit: 1, orderBy: { body: "asc" } } },
        limit: 10,
      });
      expect(kept.map((row) => row.title)).toEqual(["keep"]);
      expect(kept[0]?.comments.map((row) => row.body)).toEqual(["on task"]);

      expect(
        (await a.tasks.find({ where: { comments: has({ body: "on task" }) }, limit: 10 })).map(
          (row) => row.title,
        ),
      ).toEqual(["keep"]);
      expect(
        (await a.lists.find({ where: { comments: none({ body: "on list" }) }, limit: 10 })).map(
          (row) => row.id,
        ),
      ).toEqual([]);

      await a.tasks.archive({ where: { id: taskId } });
      const hidden = await a.comments.find({
        where: { body: "on task" },
        include: { commentable: true },
        limit: 1,
      });
      expect(hidden[0]?.commentable).toBeNull();
      const wide = await a.comments.withArchived().find({
        where: { body: "on task" },
        include: { commentable: true },
        limit: 1,
      });
      expect(wide[0]?.commentable).toMatchObject({ title: "keep" });

      const halfId = crypto.randomUUID();
      await a.comments.insert({
        id: halfId,
        body: "half",
        ...morphTo("commentable", "tasks", taskId),
      });
      const half = await a.comments
        .update({ where: { id: halfId }, set: { commentableType: "lists" } })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(half).toBeInstanceOf(OkmError);
      if (half instanceof OkmError) {
        expect(half.code).toBe("OKM1121");
        expect(half.message).toContain("commentableType");
        expect(half.message).toContain("commentableId");
      }

      const badType = await a.comments
        .insert({
          id: crypto.randomUUID(),
          body: "bad",
          commentableType: "nope",
          commentableId: taskId,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(badType).toBeInstanceOf(OkmError);
      if (badType instanceof OkmError)
        expect(badType.message).toContain("Accepted tables: tasks, lists");
    });
  },
  60_000,
);
