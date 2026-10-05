/**
 * Presets on real Postgres: every preset kind, chaining, every read, update,
 * delete, archive and restore, and the tenant and active-set predicates that
 * stay around all of them.
 */

import { expect } from "bun:test";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { ADA, GRACE, TENANT_A, TENANT_B, app, rowId, tenantApp } from "./presets-schema.js";

const gate = await loadPostgresGate();

type Seed = {
  readonly n: number;
  readonly title: string;
  readonly status: string;
  readonly ownerId: string;
  readonly priority: number;
  readonly flagged?: boolean;
};

const SEEDS: readonly Seed[] = [
  { n: 1, title: "a", status: "pending", ownerId: ADA, priority: 1 },
  { n: 2, title: "b", status: "pending", ownerId: GRACE, priority: 4 },
  { n: 3, title: "c", status: "open", ownerId: ADA, priority: 5, flagged: true },
  { n: 4, title: "d", status: "done", ownerId: GRACE, priority: 3 },
  { n: 5, title: "e", status: "pending", ownerId: ADA, priority: 3, flagged: true },
];

function titles(rows: readonly { readonly title: string }[]): string[] {
  return rows.map((row) => row.title).toSorted();
}

postgresTest(gate, "each preset kind narrows reads, and chains compose", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      for (const seed of SEEDS) {
        await db.tasks.insert({
          id: rowId(seed.n),
          title: seed.title,
          status: seed.status,
          ownerId: seed.ownerId,
          priority: seed.priority,
          ...(seed.flagged === undefined ? {} : { flagged: seed.flagged }),
        });
      }
      const all = { orderBy: { title: "asc" as const }, limit: 20 };

      expect(titles(await db.tasks.pending().find(all))).toEqual(["a", "b", "e"]);
      expect(titles(await db.tasks.ownedBy(ADA).find(all))).toEqual(["a", "c", "e"]);
      expect(titles(await db.tasks.urgent().find(all))).toEqual(["b", "c", "d", "e"]);
      expect(titles(await db.tasks.inState("open", "done").find(all))).toEqual(["c", "d"]);
      expect(titles(await db.tasks.mineOrOpen(GRACE).find(all))).toEqual(["b", "c", "d"]);
      expect(titles(await db.tasks.stale().find(all))).toEqual(["b", "e"]);
      expect(titles(await db.tasks.flagged().find(all))).toEqual(["c", "e"]);

      expect(titles(await db.tasks.pending().ownedBy(ADA).find(all))).toEqual(["a", "e"]);
      expect(titles(await db.tasks.pending().ownedBy(ADA).urgent().find(all))).toEqual(["e"]);
      expect(titles(await db.tasks.pending().find({ ...all, where: { ownerId: GRACE } }))).toEqual([
        "b",
      ]);
      // The caller's where and a preset on the same field both hold.
      expect(await db.tasks.pending().find({ ...all, where: { status: "open" } })).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

postgresTest(gate, "a preset works on one, count, exists, aggregate, and page", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      for (const seed of SEEDS) {
        await db.tasks.insert({
          id: rowId(seed.n),
          title: seed.title,
          status: seed.status,
          ownerId: seed.ownerId,
          priority: seed.priority,
        });
      }
      const mine = db.tasks.pending().ownedBy(ADA);

      expect((await mine.one({ where: { title: "e" } }))?.title).toBe("e");
      expect(await mine.one({ where: { title: "c" } })).toBeNull();
      expect(await mine.count()).toBe(2);
      expect(await db.tasks.count()).toBe(5);
      expect(await mine.exists({ where: { title: "a" } })).toBe(true);
      expect(await mine.exists({ where: { title: "d" } })).toBe(false);

      const groups = await db.tasks
        .pending()
        .aggregate({ count: true, groupBy: ["ownerId"], orderBy: { ownerId: "asc" }, limit: 10 });
      expect(groups).toHaveLength(2);
      const sum = Object.fromEntries(groups.map((group) => [group.ownerId, group.count]));
      expect(sum[ADA]).toBe(2);
      expect(sum[GRACE]).toBe(1);
      expect((await db.tasks.pending().aggregate({ count: true })).at(0)?.count).toBe(3);

      const first = await db.tasks
        .pending()
        .page({ orderBy: { title: "asc" }, limit: 2, select: ["title"] });
      expect(first.items.map((row) => row.title)).toEqual(["a", "b"]);
      expect(first.next).not.toBeNull();
      const second = await db.tasks
        .pending()
        .page({ orderBy: { title: "asc" }, limit: 2, select: ["title"], after: first.next });
      expect(second.items.map((row) => row.title)).toEqual(["e"]);
      expect(second.next).toBeNull();
    } finally {
      await db.close();
    }
  });
});

postgresTest(
  gate,
  "update, delete, archive, and restore touch only the preset's rows",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const seed = async () => {
          await sql.unsafe(`truncate "${schemaName}"."tasks"`);
          for (const item of SEEDS) {
            await db.tasks.insert({
              id: rowId(item.n),
              title: item.title,
              status: item.status,
              ownerId: item.ownerId,
              priority: item.priority,
            });
          }
        };
        const all = { orderBy: { title: "asc" as const }, limit: 20 };

        await seed();
        const byId = await db.tasks
          .pending()
          .update({ where: { id: rowId(3) }, set: { title: "changed" } });
        expect(byId.count).toBe(0);
        expect(titles(await db.tasks.find(all))).toEqual(["a", "b", "c", "d", "e"]);

        const hit = await db.tasks
          .pending()
          .update({ where: { id: rowId(1) }, set: { title: "A" } });
        expect(hit.count).toBe(1);
        const many = await db.tasks.ownedBy(GRACE).update([
          { where: { id: rowId(2) }, set: { title: "B" } },
          { where: { id: rowId(3) }, set: { title: "C" } },
          { where: { id: rowId(4) }, set: { title: "D" } },
        ]);
        expect(many.count).toBe(2);
        expect(titles(await db.tasks.find(all))).toEqual(["A", "B", "D", "c", "e"].toSorted());

        await seed();
        const gone = await db.tasks.pending().delete({ where: { ownerId: ADA } });
        expect(gone.count).toBe(2);
        expect(titles(await db.tasks.find(all))).toEqual(["b", "c", "d"]);
        await seed();
        const deleted = await db.tasks.pending().delete({ where: { id: rowId(2) } });
        expect(deleted.count).toBe(1);
        const kept = await db.tasks.pending().delete({ where: { id: rowId(3) } });
        expect(kept.count).toBe(0);
        expect(titles(await db.tasks.find(all))).toEqual(["a", "c", "d", "e"]);

        await seed();
        const one = await db.tasks.ownedBy(ADA).archive({ where: { id: rowId(2) } });
        expect(one.count).toBe(0);
        const two = await db.tasks
          .ownedBy(ADA)
          .pending()
          .archive({ where: { id: rowId(1) } });
        expect(two.count).toBe(1);
        expect(titles(await db.tasks.find(all))).toEqual(["b", "c", "d", "e"]);
        expect(titles(await db.tasks.onlyArchived().find(all))).toEqual(["a"]);
        const back = await db.tasks
          .onlyArchived()
          .ownedBy(GRACE)
          .restore({ where: { id: rowId(1) } });
        expect(back.count).toBe(0);
        const restored = await db.tasks
          .onlyArchived()
          .ownedBy(ADA)
          .restore({ where: { id: rowId(1) } });
        expect(restored.count).toBe(1);
        expect(titles(await db.tasks.find(all))).toEqual(["a", "b", "c", "d", "e"]);
      } finally {
        await db.close();
      }
    });
  },
);

postgresTest(gate, "the tenant predicate and the active set hold around every preset", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(tenantApp.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: tenantApp, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      for (const seed of SEEDS) {
        const row = {
          id: rowId(seed.n),
          title: seed.title,
          status: seed.status,
          ownerId: seed.ownerId,
          priority: seed.priority,
        };
        await a.tasks.insert(row);
        await b.tasks.insert({ ...row, title: `${seed.title}-b` });
      }
      const all = { orderBy: { title: "asc" as const }, limit: 20 };

      expect(titles(await a.tasks.pending().find(all))).toEqual(["a", "b", "e"]);
      expect(titles(await b.tasks.pending().find(all))).toEqual(["a-b", "b-b", "e-b"]);
      expect(titles(await a.tasks.pending().ownedBy(ADA).urgent().find(all))).toEqual(["e"]);
      expect(await a.tasks.mineOrOpen(ADA).count()).toBe(3);
      expect(await b.tasks.mineOrOpen(ADA).count()).toBe(3);

      const text = (await a.tasks.pending().mineOrOpen(ADA).find({ limit: 3 }).sql()).text;
      expect(text).toContain('t."tenant_id" = $1');
      expect(text).toContain('t."archived_at" is null');
      expect(text.indexOf('t."tenant_id" = $1')).toBeLessThan(text.indexOf('t."status" = $'));
      expect(text).toContain('((t."owner_id" = $');

      const writes = [
        (
          await a.tasks
            .pending()
            .update({ where: { id: rowId(1) }, set: { title: "x" } })
            .sql()
        ).statements[0]?.text,
        (
          await a.tasks
            .pending()
            .delete({ where: { id: rowId(1) } })
            .sql()
        ).statements[0]?.text,
        (
          await a.tasks
            .pending()
            .archive({ where: { id: rowId(1) } })
            .sql()
        ).statements[0]?.text,
      ];
      for (const statement of writes) {
        expect(statement).toContain('t."tenant_id" = $');
        expect(statement).toContain('t."archived_at" is null');
        expect(statement).toContain('t."status" = $');
      }

      // A write through a preset in tenant A leaves tenant B's rows alone.
      const hit = await a.tasks.pending().delete({ where: { id: rowId(2) } });
      expect(hit.count).toBe(1);
      expect(titles(await b.tasks.find(all))).toEqual(["a-b", "b-b", "c-b", "d-b", "e-b"]);

      // Archived rows stay out of a preset's reach until the view widens.
      await a.tasks.ownedBy(ADA).archive({ where: { id: rowId(1) } });
      expect(titles(await a.tasks.pending().find(all))).toEqual(["e"]);
      expect(titles(await a.tasks.withArchived().pending().find(all))).toEqual(["a", "e"]);
      expect(titles(await a.tasks.onlyArchived().pending().find(all))).toEqual(["a"]);
      expect(await b.tasks.onlyArchived().pending().count()).toBe(0);
    } finally {
      await db.close();
    }
  });
});
