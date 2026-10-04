/**
 * Archive, restore, cascade, and tenant isolation on real Postgres.
 */

import { expect } from "bun:test";
import fc from "fast-check";

import { OkmError } from "../src/contracts/error.js";
import { every, has, id, none, schema, table, text } from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { archivable } from "../src/runtime/traits/index.js";
import {
  LIST,
  REMINDER,
  TASK,
  TASK_B,
  TENANT_A,
  TENANT_B,
  USER,
  app,
  tenantApp,
} from "./archive-schema.js";

const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c16";
const OTHER_ORG = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c17";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "archive and restore keep the active set, cascade, and partial uniques",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.users.insert({ id: USER, name: "Ada" });
        await db.lists.insert({ id: LIST, name: "Inbox" });
        await db.tasks.insert({ id: TASK, title: "ship", listId: LIST, ownerId: USER });
        await db.reminders.insert({ id: REMINDER, taskId: TASK, note: "ping" });
        await db.notes.insert({ id: NOTE, body: "hello" });

        const activeSql = await db.tasks.find({ where: { id: TASK }, limit: 1 }).sql();
        expect(activeSql.text).toContain('"archived_at" is null');
        const wideSql = await db.tasks
          .withArchived()
          .find({ where: { id: TASK }, limit: 1 })
          .sql();
        expect(wideSql.text.includes('"archived_at" is null')).toBe(false);
        expect(wideSql.text.includes('"archived_at" is not null')).toBe(false);
        const onlySql = await db.tasks
          .onlyArchived()
          .find({ where: { id: TASK }, limit: 1 })
          .sql();
        expect(onlySql.text).toContain('"archived_at" is not null');
        const hasSql = await db.lists
          .find({ where: { tasks: has({ title: "ship" }) }, limit: 5 })
          .sql();
        expect(hasSql.text).toContain('"archived_at" is null');

        await db.users.archive({ where: { id: USER } });
        const hiddenOwner = await db.tasks.find({
          where: { id: TASK },
          limit: 1,
          include: { owner: true },
        });
        expect(hiddenOwner[0]?.owner).toBeNull();
        const shownOwner = await db.tasks.withArchived().find({
          where: { id: TASK },
          limit: 1,
          include: { owner: true },
        });
        expect(shownOwner[0]?.owner).toMatchObject({ id: USER, name: "Ada" });
        expect(await db.users.find({ where: { id: USER }, limit: 1 })).toEqual([]);
        await db.users.restore({ where: { id: USER } });

        await db.tasks.insert({ id: TASK_B, title: "secret", listId: LIST, ownerId: USER });
        await db.tasks.archive({ where: { id: TASK_B } });
        const visible = await db.lists.find({
          where: { id: LIST },
          limit: 1,
          include: { tasks: { limit: 5 } },
        });
        expect(visible[0]?.tasks.map((row) => row.title)).toEqual(["ship"]);
        expect(
          (await db.lists.find({ where: { tasks: has({ title: "secret" }) }, limit: 5 })).map(
            (row) => row.id,
          ),
        ).toEqual([]);
        expect(
          (await db.lists.find({ where: { tasks: none({ title: "secret" }) }, limit: 5 })).map(
            (row) => row.id,
          ),
        ).toEqual([LIST]);
        expect(
          (await db.lists.find({ where: { tasks: every({ title: "ship" }) }, limit: 5 })).map(
            (row) => row.id,
          ),
        ).toEqual([LIST]);
        expect(await db.tasks.count({ where: { id: TASK_B } })).toBe(0);
        expect(await db.tasks.exists({ where: { id: TASK_B } })).toBe(false);
        expect(await db.tasks.update({ where: { id: TASK_B }, set: { title: "nope" } })).toEqual({
          count: 0,
        });
        expect(
          (await db.tasks.onlyArchived().find({ where: { id: TASK_B }, limit: 1 }))[0]?.title,
        ).toBe("secret");
        expect(await db.tasks.delete({ where: { id: TASK_B } })).toEqual({ count: 0 });
        expect(await db.tasks.onlyArchived().delete({ where: { id: TASK_B } })).toEqual({
          count: 1,
        });
        expect(await db.tasks.onlyArchived().find({ where: { id: TASK_B }, limit: 1 })).toEqual([]);

        const first = await db.lists.archive({ where: { id: LIST } });
        expect(first.count).toBe(1);
        expect(
          (await db.tasks.onlyArchived().find({ where: { id: TASK }, limit: 1 }))[0]?.archiveId,
        ).toBe(first.archiveId);
        expect(await db.reminders.find({ where: { id: REMINDER }, limit: 1 })).toHaveLength(1);
        const parent = await catchError(db.tasks.restore({ where: { id: TASK } }));
        expect(parent.category).toBe("input");
        expect(parent.kind).toBe("invalid");
        expect(parent.message).toContain("lists");
        expect(await db.tasks.onlyArchived().find({ where: { id: TASK }, limit: 1 })).toHaveLength(
          1,
        );
        expect(await db.lists.restore({ archiveId: first.archiveId })).toEqual({ count: 1 });
        expect(await db.tasks.find({ where: { id: TASK }, limit: 1 })).toHaveLength(1);

        const second = await db.lists.archive({ where: { id: LIST } });
        expect(second.archiveId).not.toBe(first.archiveId);
        expect(await db.lists.archive({ where: { id: LIST } })).toMatchObject({ count: 0 });
        expect((await catchError(db.lists.archive({ where: { id: LIST } }).expect(1))).kind).toBe(
          "not_found",
        );
        expect(await db.lists.restore({ where: { id: LIST } })).toEqual({ count: 1 });
        expect((await db.tasks.find({ where: { id: TASK }, limit: 1 }))[0]?.archiveId).toBeNull();

        const own = await db.reminders.archive({ where: { id: REMINDER } });
        const taskArchive = await db.tasks.archive({ where: { id: TASK } });
        expect(
          (await db.reminders.onlyArchived().find({ where: { id: REMINDER }, limit: 1 }))[0]
            ?.archiveId,
        ).toBe(own.archiveId);
        expect(own.archiveId).not.toBe(taskArchive.archiveId);
        expect(await db.tasks.restore({ where: { id: TASK } })).toEqual({ count: 1 });
        expect(
          await db.reminders.onlyArchived().find({ where: { id: REMINDER }, limit: 1 }),
        ).toHaveLength(1);
        expect(await db.reminders.restore({ archiveId: own.archiveId })).toEqual({ count: 1 });

        await db.tasks.archive({ where: { id: TASK } });
        await db.tasks.insert({ id: TASK_B, title: "ship", listId: LIST, ownerId: USER });
        const conflict = await catchError(db.tasks.restore({ where: { id: TASK } }));
        expect(conflict.category).toBe("conflict");
        expect(conflict.kind).toBe("unique");
        expect(Object.keys(conflict.fields()).length).toBeGreaterThan(0);
        expect(await db.tasks.onlyArchived().find({ where: { id: TASK }, limit: 1 })).toHaveLength(
          1,
        );
        expect(await db.tasks.delete({ where: { id: TASK_B } })).toEqual({ count: 1 });
        expect(await db.tasks.restore({ where: { id: TASK } })).toEqual({ count: 1 });

        let thrown: unknown;
        try {
          (db.notes as unknown as { archive(input: object): unknown }).archive({
            where: { id: NOTE },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(OkmError);
        expect((thrown as OkmError).code).toBe("OKM1052");
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "archive and restore stay inside the tenant",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(tenantApp.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const indexes = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where schemaname = ${schemaName} and tablename = 'orgs'
      `;
      const defs = indexes.map((row) => row.indexdef.toLowerCase());
      expect(
        defs.some(
          (def) =>
            def.includes("unique") &&
            def.includes("tenant_id") &&
            def.includes("name") &&
            def.includes("archived_at") &&
            def.includes("is null"),
        ),
      ).toBe(true);

      const db = connect(primaryUrl(), { schema: tenantApp, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const a = db.for({ tenantId: TENANT_A });
        const b = db.for({ tenantId: TENANT_B });
        await a.orgs.insert({ id: LIST, name: "Acme" });
        await b.orgs.insert({ id: LIST, name: "Acme" });
        await a.tasks.insert({ id: TASK, title: "ship", orgId: LIST });
        await b.tasks.insert({ id: TASK, title: "ship", orgId: LIST });

        const archived = await a.orgs.archive({ where: { id: LIST } });
        expect(archived.count).toBe(1);
        expect(await a.orgs.find({ where: { id: LIST }, limit: 1 })).toEqual([]);
        expect(await b.orgs.find({ where: { id: LIST }, limit: 1 })).toHaveLength(1);
        expect(
          (await a.tasks.onlyArchived().find({ where: { id: TASK }, limit: 1 }))[0]?.archiveId,
        ).toBe(archived.archiveId);
        expect(await b.tasks.find({ where: { id: TASK }, limit: 1 })).toHaveLength(1);
        expect(await b.orgs.restore({ archiveId: archived.archiveId })).toEqual({ count: 0 });
        expect(await b.tasks.restore({ where: { id: TASK } })).toEqual({ count: 0 });
        expect(await a.orgs.onlyArchived().find({ where: { id: LIST }, limit: 1 })).toHaveLength(1);
        expect(await a.orgs.restore({ archiveId: archived.archiveId })).toEqual({ count: 1 });
        expect(await a.tasks.find({ where: { id: TASK }, limit: 1 })).toHaveLength(1);
        expect(await b.orgs.find({ where: { id: LIST }, limit: 1 })).toHaveLength(1);

        const again = await a.orgs.archive({ where: { id: LIST } });
        await a.orgs.insert({ id: OTHER_ORG, name: "Acme" });
        expect(await b.orgs.find({ where: { id: LIST }, limit: 1 })).toHaveLength(1);
        expect(await a.orgs.find({ where: { id: OTHER_ORG }, limit: 1 })).toHaveLength(1);
        expect(again.archiveId).not.toBe(archived.archiveId);
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

const items = table(
  "items",
  { id: id({ default: "none" }), title: text() },
  { traits: [archivable()] },
);
const propertyApp = schema({ casing: "snake", tables: [items] });

postgresTest(
  gate,
  "random archive and restore sequences match the active set",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(propertyApp.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: propertyApp, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await fc.assert(
          fc.asyncProperty(
            fc.array(
              fc.constantFrom("insert", "archive", "archiveAll", "restore", "restoreGroup"),
              { minLength: 4, maxLength: 8 },
            ),
            async (steps) => {
              await db.items.delete({}).all("reset active rows");
              await db.items.onlyArchived().delete({}).all("reset archived rows");
              const rows: { id: string; archived: boolean; archiveId: string | undefined }[] = [];
              let next = 0;
              for (const step of steps) {
                if (step === "insert") {
                  next += 1;
                  const id = crypto.randomUUID();
                  await db.items.insert({ id, title: `t${String(next)}` });
                  rows.push({ id, archived: false, archiveId: undefined });
                } else if (step === "archive" || step === "archiveAll") {
                  const active = rows.filter((row) => !row.archived);
                  const chosen = active[next % active.length];
                  if (chosen !== undefined) {
                    const result =
                      step === "archiveAll"
                        ? await db.items.archive({}).all("property")
                        : await db.items.archive({ where: { id: chosen.id } });
                    for (const row of step === "archiveAll" ? active : [chosen]) {
                      row.archived = true;
                      row.archiveId = result.archiveId;
                    }
                  }
                } else {
                  const archived = rows.filter((row) => row.archived);
                  const row = archived[next % archived.length];
                  if (row !== undefined && step === "restoreGroup" && row.archiveId !== undefined) {
                    const id = row.archiveId;
                    await db.items.restore({ archiveId: id });
                    for (const item of rows) {
                      if (item.archiveId !== id) continue;
                      item.archived = false;
                      item.archiveId = undefined;
                    }
                  } else if (row !== undefined) {
                    await db.items.restore({ where: { id: row.id } });
                    row.archived = false;
                    row.archiveId = undefined;
                  }
                }
                const storedActive = (await db.items.find({ limit: 20 })).map((item) => item.id);
                const storedArchived = (await db.items.onlyArchived().find({ limit: 20 })).map(
                  (item) => item.id,
                );
                expect(storedActive.sort()).toEqual(
                  rows
                    .filter((item) => !item.archived)
                    .map((item) => item.id)
                    .sort(),
                );
                expect(storedArchived.sort()).toEqual(
                  rows
                    .filter((item) => item.archived)
                    .map((item) => item.id)
                    .sort(),
                );
              }
            },
          ),
          { numRuns: 5 },
        );
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

async function catchError(pending: Promise<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
