/**
 * Search on Postgres: rank, an explicit order, count, include, tenancy, and page.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  id,
  many,
  matches,
  relevance,
  schema,
  table,
  text,
  tsvector,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const HIGH = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
const LOW = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";
const MISS = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c03";
const HIDDEN = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c04";
const COMMENT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c05";
const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c06";

const pages = table(
  "pages",
  {
    id: id({ default: "none" }),
    title: text(),
    body: tsvector(),
  },
  {
    relations: { comments: many("comments", "noteId") },
    presets: {
      titled: (q, title: string) => q.where({ title }),
    },
  },
);

const comments = table("comments", {
  id: id({ default: "none" }),
  noteId: uuid().references("pages"),
  body: text(),
});

const notes = table("notes", {
  id: id({ default: "none" }),
  body: tsvector(),
  titleDoc: tsvector(),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [pages, comments, notes],
});

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "search ranks matches, keeps the tenant, and refuses a page",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const a = db.for({ tenantId: TENANT_A });
        const b = db.for({ tenantId: TENANT_B });
        await a.pages.insert([
          { id: LOW, title: "a", body: "'deploy':1" },
          { id: HIGH, title: "b", body: "'deploy':1,2,3" },
          { id: MISS, title: "c", body: "'other':1" },
        ]);
        await b.pages.insert({ id: HIDDEN, title: "z", body: "'deploy':1,2,3,4" });
        await a.comments.insert({ id: COMMENT, noteId: HIGH, body: "seen" });
        await a.notes.insert({ id: NOTE, body: "'deploy':1", titleDoc: "'other':1" });

        const ranked = await a.pages.find({
          search: "deploy",
          include: { comments: { limit: 5 } },
          limit: 5,
        });
        expect(ranked.map((row) => row.id)).toEqual([HIGH, LOW]);
        expect(ranked[0]?.comments.map((comment) => comment.body)).toEqual(["seen"]);
        expect(ranked[1]?.comments).toEqual([]);

        const byTitle = await a.pages.find({
          search: "deploy",
          orderBy: { title: "asc" },
          limit: 5,
        });
        expect(byTitle.map((row) => row.id)).toEqual([LOW, HIGH]);

        expect(await a.pages.count({ search: "deploy" })).toBe(2);
        expect(await b.pages.count({ search: "deploy" })).toBe(1);
        const owned = await a.pages.find({
          search: "deploy",
          where: { title: "b" },
          limit: 5,
        });
        expect(owned.map((row) => row.id)).toEqual([HIGH]);
        const preset = await a.pages.titled("a").find({ search: "deploy", limit: 5 });
        expect(preset.map((row) => row.id)).toEqual([LOW]);

        const described = await a.pages.find({ search: "deploy", limit: 5 }).sql();
        const manual = await a.pages
          .find({
            where: { body: matches("deploy") },
            orderBy: { body: relevance("deploy"), id: "asc", tenantId: "asc" },
            limit: 5,
          })
          .sql();
        expect(described.text).toBe(manual.text);
        expect(described.params).toEqual(manual.params);
        expect(described.text).toContain(`"tenant_id" = `);
        expect(described.params[0]).toBe(TENANT_A);
        expect(described.text.includes(TENANT_A)).toBe(false);

        let multi: unknown;
        try {
          await a.notes.find({ search: "deploy", limit: 5 });
        } catch (error) {
          multi = error;
        }
        expect(multi).toBeInstanceOf(OkmError);
        if (multi instanceof OkmError) {
          expect(multi.message).toContain("body");
          expect(multi.message).toContain("titleDoc");
        }
        const oneColumn = await a.notes.find({
          search: { for: "deploy", in: "body" },
          limit: 5,
        });
        expect(oneColumn.map((row) => row.id)).toEqual([NOTE]);

        let page: unknown;
        try {
          await a.pages.page({ search: "deploy", limit: 1 } as { limit: number });
        } catch (error) {
          page = error;
        }
        expect(page).toBeInstanceOf(OkmError);
        if (page instanceof OkmError) {
          expect(page.code).toBe("OKM1120");
          expect(page.message).toContain("does not take search in this version");
        }
      } finally {
        await db.close();
      }
    });
  },
  20_000,
);
