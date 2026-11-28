/**
 * pgvector on real Postgres.
 *
 * Declare, apply, introspect, and query. No driver mock stands in for the extension.
 */

import { expect, test } from "bun:test";
import type { Sql } from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { pgvector } from "../src/dialects/pg/ext/pgvector.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { ensurePgvector } from "../packages/harness/src/pgvector-install.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { EXTENSION_NOT_TRUSTED, extensionCreateDenied } from "../src/tooling/migrate/extensions.js";

const gate = await loadPostgresGate();
const vector = ensurePgvector();

const vec = pgvector();

function appOf(
  kind: "vector" | "halfvec",
  metric: "cosine" | "l2" | "ip",
  storage?: { m?: number; efConstruction?: number; lists?: number },
  method: "hnsw" | "ivfflat" = "hnsw",
) {
  const column = kind === "vector" ? vec.vector(3) : vec.halfvec(3);
  const index =
    method === "hnsw"
      ? vec.hnsw("embedding", { metric, ...storage })
      : vec.ivfflat("embedding", { metric, lists: storage?.lists ?? 8 });
  const docs = table(
    "docs",
    { id: t.id(), body: t.text(), embedding: column },
    { indexes: () => [index] },
  );
  return schema({ tables: [docs], extensions: [vec] });
}

async function withDatabase<T>(run: (sql: Sql, url: string) => Promise<T>): Promise<T> {
  if (!vector.ok) throw new Error(vector.reason);
  const database = await createIsolatedDatabase(vector.url);
  const sql = openPostgres(database.url);
  try {
    return await run(sql, database.url);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

async function apply(
  sql: Sql,
  source: { readonly catalog: Parameters<typeof renderCatalog>[0] },
): Promise<void> {
  for (const statement of renderCatalog(source.catalog, "public")) await sql.unsafe(statement);
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

async function expectRoundTrip(
  sql: Sql,
  source: { readonly catalog: Parameters<typeof planMigration>[0]["after"] },
): Promise<void> {
  const live = await introspectSchema(queryOf(sql), "public", "public");
  const back = planMigration({ before: live, after: source.catalog, name: "check" }).steps.map(
    (step) => step.sql,
  );
  expect(back).toEqual([]);
}

if (!vector.ok) test.skip("proof:ext.pgvector", () => {});
else
  postgresTest(
    gate,
    "proof:ext.pgvector",
    async () => {
      await withDatabase(async (sql) => {
        const app = appOf("vector", "cosine", { m: 16, efConstruction: 64 });
        await apply(sql, app);
        await expectRoundTrip(sql, app);
        const installed = await sql<
          { extname: string }[]
        >`select extname from pg_extension where extname = 'vector'`;
        expect(installed.map((row) => row.extname)).toEqual(["vector"]);
        const version = await sql<{ version: string }[]>`select version()`;
        console.log(`pgvector proof server: ${version[0]?.version ?? ""}`);
      });
    },
    120_000,
  );

if (!vector.ok) test.skip("proof:type.vector", () => {});
else
  postgresTest(
    gate,
    "proof:type.vector",
    async () => {
      await withDatabase(async (sql, url) => {
        const app = appOf("vector", "cosine");
        await apply(sql, app);
        const db = connect(url, { schema: app, max: 1 });
        try {
          await db.connected;
          const column = vec.vector(3);
          expect(column.encode([1, 2, 3])).toBe("[1,2,3]");
          await db.docs.insert({ body: "a", embedding: [1, 2, 3] });
          const row = await db.docs.one({ select: ["embedding"] });
          expect(row?.embedding).toEqual([1, 2, 3]);
          for (const embedding of [[1, 2], [1, Number.NaN, 3], []] as const) {
            let caught: unknown;
            try {
              await db.docs.insert({ body: "bad", embedding: embedding as unknown as number[] });
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeInstanceOf(OkmError);
            expect((caught as OkmError).code).toBe("OKM1210");
          }
        } finally {
          await db.close();
        }
      });
    },
    120_000,
  );

if (!vector.ok) test.skip("proof:type.halfvec", () => {});
else
  postgresTest(
    gate,
    "proof:type.halfvec",
    async () => {
      await withDatabase(async (sql, url) => {
        const app = appOf("halfvec", "l2");
        await apply(sql, app);
        await expectRoundTrip(sql, app);
        const db = connect(url, { schema: app, max: 1 });
        try {
          await db.connected;
          await db.docs.insert({ body: "a", embedding: [0.5, -1, 2] });
          const row = await db.docs.one({ select: ["embedding"] });
          expect(row?.embedding?.[0]).toBeCloseTo(0.5, 3);
          expect(row?.embedding?.[1]).toBeCloseTo(-1, 3);
          expect(row?.embedding?.[2]).toBeCloseTo(2, 3);
        } finally {
          await db.close();
        }
      });
    },
    120_000,
  );

if (!vector.ok) test.skip("proof:index.hnsw", () => {});
else
  postgresTest(
    gate,
    "proof:index.hnsw",
    async () => {
      await withDatabase(async (sql, url) => {
        const app = appOf("vector", "cosine", { m: 8, efConstruction: 32 });
        await apply(sql, app);
        await expectRoundTrip(sql, app);
        const db = connect(url, { schema: app, max: 1 });
        try {
          await db.connected;
          await db.docs.insert({ body: "same", embedding: [1, 0, 0] });
          await db.docs.insert({ body: "right", embedding: [0, 1, 0] });
          await db.docs.insert({ body: "flip", embedding: [-1, 0, 0] });
          const rows = await db.docs.find({
            select: ["body", vec.distance("embedding", [1, 0, 0], "cosine").as("distance")],
            orderBy: { embedding: vec.nearest([1, 0, 0], "cosine") },
            limit: 3,
          });
          expect(rows.map((row) => row.body)).toEqual(["same", "right", "flip"]);
          expect(rows[0]?.distance).toBeCloseTo(0, 5);
          expect(rows[1]?.distance).toBeCloseTo(1, 5);
          expect(rows[2]?.distance).toBeCloseTo(2, 5);
          await sql.unsafe("set enable_seqscan = off");
          const explained = await sql.unsafe(
            "explain select body from docs order by embedding operator(public.<=>) '[1,0,0]' limit 3",
          );
          const plan = explained.map((row) => Object.values(row).join(" ")).join("\n");
          expect(plan.toLowerCase()).toContain("index");
        } finally {
          await db.close();
        }
      });
    },
    120_000,
  );

if (!vector.ok) test.skip("proof:index.ivfflat", () => {});
else
  postgresTest(
    gate,
    "proof:index.ivfflat",
    async () => {
      await withDatabase(async (sql) => {
        const app = appOf("vector", "l2", { lists: 4 }, "ivfflat");
        await apply(sql, app);
        await expectRoundTrip(sql, app);
        const defs = await sql<{ def: string }[]>`
      select pg_get_indexdef(indexrelid) as def
      from pg_index
      join pg_class on pg_class.oid = indexrelid
      where pg_class.relname like '%embedding%'
    `;
        expect(
          defs.some(
            (row) => row.def.toLowerCase().includes("ivfflat") && row.def.includes("lists"),
          ),
        ).toBe(true);
        const live = await introspectSchema(queryOf(sql), "public", "public");
        const expression = live.objects.find((object) => object.kind === "index")?.definition;
        expect(expression && "expression" in expression ? expression.expression : "").toContain(
          "vector_l2_ops",
        );
      });
    },
    120_000,
  );

if (!vector.ok) test.skip("proof:query.vectorDistance", () => {});
else
  postgresTest(
    gate,
    "proof:query.vectorDistance",
    async () => {
      await withDatabase(async (sql, url) => {
        const app = appOf("vector", "ip");
        await apply(sql, app);
        const db = connect(url, { schema: app, max: 1 });
        try {
          await db.connected;
          await db.docs.insert({ body: "a", embedding: [2, 0, 0] });
          const rows = await db.docs.find({
            select: [vec.distance("embedding", [3, 0, 0], "ip").as("distance")],
            limit: 1,
          });
          expect(rows[0]?.distance).toBeCloseTo(-6, 5);
          const nan = await sql<
            { distance: string }[]
          >`select ('[0,0,0]'::vector <=> '[0,0,0]'::vector)::text as distance`;
          expect(nan[0]?.distance).toBe("NaN");
        } finally {
          await db.close();
        }
      });
    },
    120_000,
  );

if (!vector.ok) test.skip("proof:query.vectorWithin", () => {});
else
  postgresTest(
    gate,
    "proof:query.vectorWithin",
    async () => {
      await withDatabase(async (sql, url) => {
        const app = appOf("vector", "cosine");
        await apply(sql, app);
        const db = connect(url, { schema: app, max: 1 });
        try {
          await db.connected;
          await db.docs.insert({ body: "near", embedding: [1, 0, 0] });
          await db.docs.insert({ body: "far", embedding: [-1, 0, 0] });
          const rows = await db.docs.find({
            select: ["body"],
            where: { embedding: vec.within([1, 0, 0], { metric: "cosine", max: 0.35 }) },
            orderBy: { embedding: vec.nearest([1, 0, 0], "cosine") },
            limit: 10,
          });
          expect(rows.map((row) => row.body)).toEqual(["near"]);
        } finally {
          await db.close();
        }
      });
    },
    120_000,
  );

if (!vector.ok) test.skip("proof:query.vectorNearest", () => {});
else
  postgresTest(
    gate,
    "proof:query.vectorNearest",
    async () => {
      await withDatabase(async (sql, url) => {
        const app = appOf("vector", "cosine");
        await apply(sql, app);
        const db = connect(url, { schema: app, max: 1 });
        try {
          await db.connected;
          await db.docs.insert({ body: "far", embedding: [-1, 0, 0] });
          await db.docs.insert({ body: "near", embedding: [1, 0, 0] });
          const rows = await db.docs.find({
            select: ["body"],
            orderBy: { embedding: vec.nearest([1, 0, 0], "cosine") },
            limit: 1,
          });
          expect(rows.map((row) => row.body)).toEqual(["near"]);
        } finally {
          await db.close();
        }
      });
    },
    120_000,
  );

if (!vector.ok)
  test.skip("pgvector: a non-superuser 42501 says the extension is not trusted", () => {});
else
  postgresTest(
    gate,
    "pgvector: a non-superuser 42501 says the extension is not trusted",
    async () => {
      await withDatabase(async (sql, url) => {
        const existing = await sql<
          { ok: number }[]
        >`select 1 as ok from pg_roles where rolname = 'okm_vec'`;
        if (existing.length === 0)
          await sql.unsafe("create role okm_vec nosuperuser login password 'okm'");
        else await sql.unsafe("alter role okm_vec nosuperuser login password 'okm'");
        const database = new URL(url).pathname.slice(1);
        await sql.unsafe(`grant create on database ${database} to okm_vec`);
        await sql.unsafe("grant create on schema public to okm_vec");
        const trusted = await sql<{ trusted: boolean }[]>`
      select trusted from pg_available_extension_versions
      where name = 'vector'
      order by version desc
      limit 1
    `;
        const owner = new URL(url);
        owner.username = "okm_vec";
        owner.password = "okm";
        const asRole = openPostgres(owner.href);
        try {
          if (trusted[0]?.trusted === true) {
            await asRole.unsafe("create extension vector");
            const installed = await sql<
              { extname: string }[]
            >`select extname from pg_extension where extname = 'vector'`;
            expect(installed).toHaveLength(1);
          } else {
            let caught: unknown;
            try {
              await asRole.unsafe("create extension vector");
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeDefined();
            const sqlstate = (caught as { code?: string }).code;
            expect(sqlstate).toBe("42501");
            expect(extensionCreateDenied(sqlstate, "create extension vector")).toBe(
              EXTENSION_NOT_TRUSTED,
            );
          }
          let denied: unknown;
          try {
            await asRole.unsafe("create extension amcheck");
          } catch (error) {
            denied = error;
          }
          const amcheckState = (denied as { code?: string } | undefined)?.code;
          if (amcheckState === "42501") {
            expect(extensionCreateDenied(amcheckState, "create extension amcheck")).toBe(
              EXTENSION_NOT_TRUSTED,
            );
          }
        } finally {
          await asRole.end({ timeout: 5 });
        }
      });
    },
    120_000,
  );

if (!vector.ok)
  test.skip("pgvector: vector to halfvec drops and recreates the index in one plan", () => {});
else
  postgresTest(
    gate,
    "pgvector: vector to halfvec drops and recreates the index in one plan",
    async () => {
      await withDatabase(async (sql) => {
        const before = appOf("vector", "cosine", { m: 16, efConstruction: 64 });
        const after = appOf("halfvec", "cosine", { m: 16, efConstruction: 64 });
        await apply(sql, before);
        const plan = planMigration({ before: before.catalog, after: after.catalog, name: "widen" });
        const text = plan.steps.map((step) => step.sql).join("\n");
        expect(text).toContain("drop index");
        expect(text).toContain("halfvec(3)");
        expect(text).toContain("halfvec_cosine_ops");
        const dropAt = text.indexOf("drop index");
        const alterAt = text.indexOf("halfvec(3)");
        const createAt = text.lastIndexOf("create");
        expect(dropAt).toBeGreaterThanOrEqual(0);
        expect(alterAt).toBeGreaterThan(dropAt);
        expect(createAt).toBeGreaterThan(alterAt);
      });
    },
    120_000,
  );

if (!vector.ok) test.skip("pgvector: a storage parameter change replaces the index", () => {});
else
  postgresTest(
    gate,
    "pgvector: a storage parameter change replaces the index",
    async () => {
      await withDatabase(async (sql) => {
        const before = appOf("vector", "cosine", { m: 16, efConstruction: 64 });
        const after = appOf("vector", "cosine", { m: 32, efConstruction: 64 });
        await apply(sql, before);
        const plan = planMigration({
          before: before.catalog,
          after: after.catalog,
          name: "storage",
        });
        const text = plan.steps.map((step) => step.sql).join("\n");
        expect(text.toLowerCase()).toContain("concurrently");
        expect(text).toContain("m=32");
        expect(text.toLowerCase()).toContain("rename to");
        expect(text.toLowerCase()).not.toContain("set (");
      });
    },
    120_000,
  );

if (!vector.ok)
  test.skip("pgvector: hnsw recall at three ef_search settings is measured", () => {});
else
  postgresTest(
    gate,
    "pgvector: hnsw recall at three ef_search settings is measured",
    async () => {
      await withDatabase(async (sql) => {
        await sql.unsafe("create extension vector");
        await sql.unsafe("create table sample (id int primary key, embedding vector(128))");
        await sql.unsafe(
          "insert into sample (id, embedding) select i, array(select random() from generate_series(1, 128))::vector from generate_series(1, 200) as i",
        );
        await sql.unsafe("set maintenance_work_mem = '64MB'");
        await sql.unsafe(
          "create index sample_embedding_idx on sample using hnsw (embedding vector_l2_ops) with (m = 16, ef_construction = 64)",
        );
        const queries = await sql<
          { embedding: string }[]
        >`select embedding::text from sample order by id limit 20`;
        const recalls: Record<string, number> = {};
        for (const ef of [40, 100, 400]) {
          let hit = 0;
          let total = 0;
          await sql.unsafe(`set hnsw.ef_search = ${String(ef)}`);
          for (const query of queries) {
            await sql.unsafe("set enable_indexscan = off");
            await sql.unsafe("set enable_indexonlyscan = off");
            await sql.unsafe("set enable_bitmapscan = off");
            const exact = await sql<{ id: number }[]>`
          select id from sample order by embedding <-> ${query.embedding}::vector limit 10
        `;
            await sql.unsafe("set enable_indexscan = on");
            await sql.unsafe("set enable_indexonlyscan = on");
            await sql.unsafe("set enable_bitmapscan = on");
            await sql.unsafe("set enable_seqscan = off");
            const approx = await sql<{ id: number }[]>`
          select id from sample order by embedding <-> ${query.embedding}::vector limit 10
        `;
            await sql.unsafe("set enable_seqscan = on");
            const truth = new Set(exact.map((row) => row.id));
            total += truth.size;
            hit += approx.filter((row) => truth.has(row.id)).length;
          }
          recalls[String(ef)] = total === 0 ? 0 : hit / total;
        }
        console.log(`pgvector recall n=200 d=128 q=20 k=10 ${JSON.stringify(recalls)}`);
        expect(recalls["40"]).toBeGreaterThan(0);
        expect(recalls["400"]).toBeGreaterThanOrEqual(recalls["40"] ?? 0);
      });
    },
    180_000,
  );
