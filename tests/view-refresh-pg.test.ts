/**
 * `refresh()` on a materialized view, against real Postgres.
 *
 * A plain view throws OKM1120. A concurrent refresh does not block a reader.
 * A replica client sends the statement to the primary. A missing unique index
 * is the mapped driver error.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl, replicaUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d01";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d02";
const ROW_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d11";
const ROW_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d12";
const ROW_DURING = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d13";

const notes = table("notes", {
  id: uuid().primaryKey(),
  title: text(),
});

const columns = [
  { name: "tenant_id", type: "uuid" },
  { name: "id", type: "uuid" },
  { name: "title", type: "text" },
] as const;

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
  views: [
    view("note_titles", {
      columns: [{ name: "title", type: "text" }],
      query: "select title from notes",
      tenancy: global("titles are shared"),
    }),
    materializedView("daily_totals", {
      columns,
      query: "select tenant_id, id, title from notes",
    }),
    materializedView("slow_totals", {
      columns,
      indexes: [{ columns: ["id"], unique: true }],
      refresh: "concurrently",
      query: "select tenant_id, id, title from notes cross join lateral (select pg_sleep(1)) s",
    }),
    materializedView("open_counts", {
      columns,
      indexes: [{ name: "open_id", columns: ["id"], unique: true }],
      refresh: "concurrently",
      query: "select tenant_id, id, title from notes",
    }),
  ],
});

const gate = await loadPostgresGate();

postgresTest(gate, "refresh() shows new rows and is not tenant-scoped", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
    try {
      await db.connected;
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await a.notes.insert({ id: ROW_A, title: "a" });
      await a.views.dailyTotals.refresh();
      const first = await a.views.dailyTotals.find({ limit: 5, orderBy: { id: "asc" } });
      expect(first.map((row) => row.id)).toEqual([ROW_A]);
      await b.notes.insert({ id: ROW_B, title: "b" });
      await a.views.dailyTotals.refresh();
      const both = await db.unscoped("both tenants").views.dailyTotals.find({
        limit: 5,
        orderBy: { id: "asc" },
      });
      expect(both.map((row) => row.id)).toEqual([ROW_A, ROW_B]);
      expect((await a.views.dailyTotals.find({ limit: 5 })).map((row) => row.id)).toEqual([ROW_A]);

      const plain = a.views.noteTitles as unknown as { refresh(): Promise<void> };
      try {
        await plain.refresh();
        throw new Error("expected OKM1120");
      } catch (error) {
        expect(error).toBeInstanceOf(OkmError);
        if (error instanceof OkmError) {
          expect(error.code).toBe("OKM1120");
          expect(error.kind).toBe("invalid");
          expect(error.fix.summary).toContain("materialized view");
        }
      }
    } finally {
      await db.close();
    }
  });
});

postgresTest(
  gate,
  "a concurrent refresh leaves readers on the old rows and a missing unique index is mapped",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
      try {
        await db.connected;
        const a = db.for({ tenantId: TENANT_A });
        await a.notes.insert({ id: ROW_A, title: "a" });
        try {
          await a.views.slowTotals.refresh();
          throw new Error("expected not_populated");
        } catch (error) {
          expect(error).toBeInstanceOf(OkmError);
          if (error instanceof OkmError) {
            expect(error.sqlstate).toBe("0A000");
            expect(error.kind).toBe("driver");
            expect(error.fieldReason).toBe("not_populated");
            expect(error.fix.summary).toContain("without CONCURRENTLY");
          }
        }
        await sql.unsafe("refresh materialized view slow_totals");
        await a.notes.insert({ id: ROW_B, title: "b" });
        const started = Date.now();
        const refreshing = a.views.slowTotals.refresh();
        const during = await a.views.slowTotals.find({ limit: 5, orderBy: { id: "asc" } });
        expect(Date.now() - started).toBeLessThan(800);
        expect(during.map((row) => row.id)).toEqual([ROW_A]);
        const wrote = Date.now();
        await a.notes.insert({ id: ROW_DURING, title: "during" });
        expect(Date.now() - wrote).toBeLessThan(800);
        await refreshing;
        const after = await a.views.slowTotals.find({ limit: 5, orderBy: { id: "asc" } });
        const ids = after.map((row) => row.id);
        expect(ids).toContain(ROW_A);
        expect(ids).toContain(ROW_B);
        if (!ids.includes(ROW_DURING)) {
          await a.views.slowTotals.refresh();
          const later = await a.views.slowTotals.find({ limit: 5, orderBy: { id: "asc" } });
          expect(later.map((row) => row.id)).toEqual([ROW_A, ROW_B, ROW_DURING]);
        }

        await sql.unsafe("refresh materialized view open_counts");
        await sql.unsafe("drop index open_id");
        try {
          await a.views.openCounts.refresh();
          throw new Error("expected no_unique_index");
        } catch (error) {
          expect(error).toBeInstanceOf(OkmError);
          if (error instanceof OkmError) {
            expect(error.sqlstate).toBe("55000");
            expect(error.kind).toBe("driver");
            expect(error.fieldReason).toBe("no_unique_index");
            expect(error.fix.summary).toContain("unique index");
          }
        }
      } finally {
        await db.close();
      }
    });
  },
  20_000,
);

postgresTest(gate, "refresh() on a replica client runs on the primary", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const events: { op: string; endpoint: string }[] = [];
    const db = await connect(
      {
        primary: primaryUrl(),
        replicas: [{ url: replicaUrl("a"), name: "a" }],
      },
      {
        schema: app,
        searchPath: schemaName,
        max: 2,
        onRoute(event) {
          events.push({ op: event.op, endpoint: event.endpoint });
        },
      },
    );
    try {
      await db.connected;
      events.length = 0;
      await db.views.dailyTotals.refresh();
      expect(events.some((event) => event.op === "write" && event.endpoint === "primary")).toBe(
        true,
      );
      expect(events.some((event) => event.op === "write" && event.endpoint !== "primary")).toBe(
        false,
      );
    } finally {
      await db.close();
    }
  });
});
