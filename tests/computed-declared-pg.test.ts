/**
 * `schema({ computed })` on real Postgres.
 *
 * A declared value selected with `true` must return what the same callback
 * returns ad hoc, and both must equal a loop over the seeded rows: two tenants
 * with the same ids, archived rows, parents without children, nulls, and ties.
 */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  withPostgresSchema,
} from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "../scripts/root.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { OkmError } from "../src/contracts/error.js";
import { gt, gte } from "../src/dialects/pg/index.js";
import { applyProject } from "../src/tooling/migrate/apply.js";
import { checkProject, generateProject } from "../src/tooling/migrate/project.js";
import { pullProject } from "../src/tooling/migrate/pull.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { app, TENANT_A, TENANT_B } from "./computed-declared-schema.js";

const gate = await loadPostgresGate();

type Db = ReturnType<typeof connect<typeof app>>;
type Scoped = ReturnType<Db["for"]>;

type PostSeed = {
  readonly id: string;
  readonly authorId: string;
  readonly views: number | null;
  readonly draft: string | null;
  readonly createdAt: string | null;
  readonly archived: boolean;
  readonly comments: number;
};

type World = { readonly users: readonly string[]; readonly posts: readonly PostSeed[] };

const DATES = ["2023-06-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z", "2024-09-01T00:00:00.000Z"];
const SINCE = "2024-01-01T00:00:00.000Z";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same ids repeat in both tenants, so a leak between tenants changes a value. */
function world(seed: number): World {
  const rng = mulberry32(seed);
  const users = Array.from({ length: 16 }, (_, n) => `u${String(n).padStart(2, "0")}`);
  const posts: PostSeed[] = [];
  for (const authorId of users) {
    const count = rng() < 0.25 ? 0 : Math.floor(rng() * 7);
    for (let n = 0; n < count; n += 1) {
      posts.push({
        id: `${authorId}-p${String(n)}`,
        authorId,
        views: rng() < 0.25 ? null : 1 + Math.floor(rng() * 4),
        draft: rng() < 0.3 ? null : rng() < 0.5 ? "yes" : "no",
        createdAt: rng() < 0.2 ? null : (DATES[Math.floor(rng() * 3)] ?? null),
        archived: rng() < 0.2,
        comments: Math.floor(rng() * 3),
      });
    }
  }
  return { users, posts };
}

async function withApp(run: (db: Db) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
    try {
      await db.connected;
      await run(db);
    } finally {
      await db.close();
    }
  });
}

async function seed(scope: Scoped, data: World): Promise<void> {
  await scope.users.insert(data.users.map((id) => ({ id, name: `n-${id}` })));
  if (data.posts.length > 0) {
    await scope.posts.insert(
      data.posts.map((post) => ({
        id: post.id,
        authorId: post.authorId,
        title: "t",
        views: post.views,
        draft: post.draft,
        secret: "s",
        createdAt: post.createdAt,
      })),
    );
  }
  const comments = data.posts.flatMap((post) =>
    Array.from({ length: post.comments }, (_, n) => ({
      id: `${post.id}-c${String(n)}`,
      postId: post.id,
      body: "b",
    })),
  );
  if (comments.length > 0) await scope.comments.insert(comments);
  for (const post of data.posts) {
    if (post.archived) await scope.posts.archive({ where: { id: post.id } });
  }
}

type Truth = {
  readonly postCount: number;
  readonly recent: number;
  readonly kinds: number;
  readonly hasDraft: boolean;
  readonly totalViews: number | null;
  readonly meanViews: number | null;
  readonly minViews: number | null;
  readonly maxViews: number | null;
  readonly weight: number | null;
};

/** What the database must return for one user, counted in JavaScript. */
function truth(data: World, userId: string): Truth {
  const live = data.posts.filter((post) => post.authorId === userId && !post.archived);
  const views = live.flatMap((post) => (post.views === null ? [] : [post.views]));
  const total = views.reduce((sum, value) => sum + value, 0);
  const empty = views.length === 0;
  return {
    postCount: live.length,
    recent: live.filter((post) => post.createdAt !== null && post.createdAt >= SINCE).length,
    kinds: new Set(views).size,
    hasDraft: live.some((post) => post.draft === "yes"),
    totalViews: empty ? null : total,
    meanViews: empty ? null : total / views.length,
    minViews: empty ? null : Math.min(...views),
    maxViews: empty ? null : Math.max(...views),
    weight: empty ? null : total * 2,
  };
}

const NAMES = [
  "postCount",
  "recent",
  "kinds",
  "hasDraft",
  "totalViews",
  "meanViews",
  "minViews",
  "maxViews",
  "weight",
] as const;

type Declared = Record<string, Record<string, (row: never) => unknown>>;

/** The callback as `schema({ computed })` stored it, to pass ad hoc. */
function declaredFn(table: string, name: string): never {
  return (app as unknown as { computed: Declared }).computed[table]?.[name] as never;
}

function count(sql: string, part: string): number {
  return sql.split(part).length - 1;
}

function close(actual: unknown, expected: number | null): void {
  if (expected === null) expect(actual).toBeNull();
  else expect(actual as number).toBeCloseTo(expected, 9);
}

postgresTest(
  gate,
  "every verb, declared and selected with true, equals the same callback ad hoc and the per-row oracle",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      const dataA = world(11);
      const dataB = world(12);
      await seed(a, dataA);
      await seed(b, dataB);
      for (const [scope, data] of [
        [a, dataA],
        [b, dataB],
      ] as const) {
        for (const name of NAMES) {
          const viaDeclared = await scope.users.find({
            orderBy: { id: "asc" },
            limit: 100,
            computed: { [name]: true },
          } as never);
          const adHoc = await scope.users.find({
            orderBy: { id: "asc" },
            limit: 100,
            computed: { adHoc: declaredFn("users", name) },
          } as never);
          expect(
            (viaDeclared as unknown as readonly Record<string, unknown>[]).map((row) => row[name]),
            name,
          ).toEqual(
            (adHoc as unknown as readonly Record<string, unknown>[]).map((row) => row.adHoc),
          );
          expect(viaDeclared).toHaveLength(data.users.length);
          for (const row of viaDeclared as unknown as readonly Record<string, unknown>[]) {
            const expected = truth(data, String(row.id))[name];
            if (typeof expected === "boolean") expect(row[name], name).toBe(expected);
            else close(row[name], expected);
          }
        }
        const all = await scope.users.find({
          orderBy: { id: "asc" },
          limit: 100,
          computed: {
            postCount: true,
            recent: true,
            kinds: true,
            hasDraft: true,
            totalViews: true,
            meanViews: true,
            minViews: true,
            maxViews: true,
            weight: true,
          },
        });
        for (const row of all) {
          const expected = truth(data, row.id);
          expect(row.postCount).toBe(expected.postCount);
          expect(row.recent).toBe(expected.recent);
          expect(row.kinds).toBe(expected.kinds);
          expect(row.hasDraft).toBe(expected.hasDraft);
          expect(row.totalViews).toBe(expected.totalViews);
          close(row.meanViews, expected.meanViews);
          expect(row.minViews).toBe(expected.minViews);
          expect(row.maxViews).toBe(expected.maxViews);
          expect(row.weight).toBe(expected.weight);
          expect(Object.keys(row).sort()).toEqual(
            ["id", "name", "profileId", "tenantId", ...NAMES].sort(),
          );
        }
        expect(all.some((row) => row.postCount === 0)).toBe(true);
        expect(all.some((row) => row.totalViews === null)).toBe(true);
        const live = data.posts.filter((post) => !post.archived);
        const commentCounts = await scope.posts.find({
          orderBy: { id: "asc" },
          limit: 500,
          computed: { commentCount: true },
        });
        expect(commentCounts.map((row) => [row.id, row.commentCount])).toEqual(
          [...live].sort((x, y) => (x.id < y.id ? -1 : 1)).map((post) => [post.id, post.comments]),
        );
      }
    });
  },
  120_000,
);

postgresTest(
  gate,
  "declared and ad hoc values on one relation share one grouped subquery",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const data = world(21);
      await seed(a, data);
      const read = a.users.find({
        orderBy: { id: "asc" },
        limit: 100,
        computed: {
          postCount: true,
          maxViews: true,
          hasDraft: true,
          drafts: (u) => u.posts.count({ where: { draft: "yes" } }),
          topDraft: (u) => u.posts.max("views", { where: { draft: "yes" } }),
        },
      });
      const text = (await read.sql()).text;
      expect(count(text, "left join (select")).toBe(1);
      expect(count(text, "group by")).toBe(1);
      expect(count(text, 'from "posts"')).toBe(1);
      expect(text).not.toContain("lateral");
      expect(text).toContain('"archived_at" is null');
      expect(text).toContain('"tenant_id"');
      for (const row of await read) {
        const live = data.posts.filter((post) => post.authorId === row.id && !post.archived);
        const drafts = live.filter((post) => post.draft === "yes");
        const top = drafts.flatMap((post) => (post.views === null ? [] : [post.views]));
        expect(row.postCount).toBe(live.length);
        expect(row.hasDraft).toBe(drafts.length > 0);
        expect(row.drafts).toBe(drafts.length);
        expect(row.topDraft).toBe(top.length === 0 ? null : Math.max(...top));
        expect(row.maxViews).toBe(truth(data, row.id).maxViews);
      }
      const posts = (
        await a.posts
          .find({
            limit: 5,
            computed: {
              commentCount: true,
              loud: (p) => p.comments.count({ where: { body: "b" } }),
            },
          })
          .sql()
      ).text;
      expect(count(posts, "left join (select")).toBe(1);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "where and orderBy take a declared name, in the threshold and the full grouped form",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const data = world(31);
      await seed(a, data);
      const n = (id: string): number => truth(data, id).postCount;
      const ids = data.users;

      const threshold = a.users.find({
        where: { postCount: gte(2) },
        orderBy: { id: "asc" },
        limit: 100,
        computed: { postCount: true },
      });
      expect((await threshold).map((row) => row.id)).toEqual(ids.filter((id) => n(id) >= 2));
      expect((await threshold.sql()).text).toContain("exists (select 1");

      const exact = a.users.find({
        where: { postCount: 2 },
        orderBy: { id: "asc" },
        limit: 100,
        computed: { postCount: true },
      });
      expect((await exact).map((row) => row.id)).toEqual(ids.filter((id) => n(id) === 2));
      expect((await exact.sql()).text).toContain("left join (select");

      const mean = await a.users.find({
        where: { meanViews: gt(2) },
        orderBy: { id: "asc" },
        limit: 100,
        computed: { meanViews: true },
      });
      expect(mean.map((row) => row.id)).toEqual(
        ids.filter((id) => (truth(data, id).meanViews ?? 0) > 2),
      );

      const ordered = await a.users.find({
        orderBy: { postCount: "desc", id: "asc" },
        limit: 100,
        computed: { postCount: true },
      });
      expect(ordered.map((row) => row.id)).toEqual(
        [...ids].sort((x, y) => n(y) - n(x) || (x < y ? -1 : 1)),
      );

      const mixed = await a.users.find({
        where: { postCount: gte(1) },
        orderBy: { adHoc: "desc", id: "asc" },
        limit: 100,
        computed: { postCount: true, adHoc: (u) => u.posts.count({ where: { draft: "yes" } }) },
      });
      expect(mixed.map((row) => row.id)).toEqual(
        ids
          .filter((id) => n(id) >= 1)
          .sort((x, y) => {
            const drafts = (id: string): number =>
              data.posts.filter(
                (post) => post.authorId === id && !post.archived && post.draft === "yes",
              ).length;
            return drafts(y) - drafts(x) || (x < y ? -1 : 1);
          }),
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "one, stream, count, exists, and page take declared names; page cannot order by one",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const data = world(41);
      await seed(a, data);
      const where = { postCount: gte(2) };
      const all = await a.users.find({
        where,
        orderBy: { id: "asc" },
        limit: 100,
        computed: { postCount: true, maxViews: true },
      });
      expect(all.length).toBeGreaterThan(2);

      const first = await a.users.one({
        where,
        orderBy: { id: "asc" },
        computed: { postCount: true, maxViews: true },
      });
      expect(first).toEqual(all[0] ?? null);

      expect(await a.users.count({ where, computed: { postCount: true } })).toBe(all.length);
      expect(await a.users.exists({ where, computed: { postCount: true } })).toBe(true);
      expect(
        await a.users.exists({ where: { postCount: gte(99) }, computed: { postCount: true } }),
      ).toBe(false);

      const streamed = [];
      const read = a.users.find({
        where,
        orderBy: { id: "asc" },
        limit: 100,
        computed: { postCount: true, maxViews: true },
      });
      for await (const row of read.stream({ batch: 3 })) streamed.push(row);
      expect(streamed).toEqual([...all]);

      const pages = [];
      let after: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page: { items: typeof all; next: string | null } = await a.users.page({
          where,
          orderBy: { id: "asc" },
          limit: 4,
          after,
          computed: { postCount: true, maxViews: true },
        });
        pages.push(...page.items);
        if (page.next === null) break;
        after = page.next;
      }
      expect(pages).toEqual([...all]);

      let thrown: unknown;
      try {
        await a.users.page({
          orderBy: { postCount: "asc" },
          limit: 4,
          computed: { postCount: true },
        } as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OkmError);
      expect((thrown as OkmError).code).toBe("OKM1120");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a name only works in where and orderBy when the request selects it",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await seed(a, world(51));
      for (const options of [{ where: { postCount: gte(1) } }, { orderBy: { postCount: "asc" } }]) {
        let thrown: unknown;
        try {
          await a.users.find({ ...options, limit: 5 } as never);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(OkmError);
        expect((thrown as OkmError).code).toBe("OKM1120");
      }
    });
  },
  60_000,
);

const SCHEMA_SOURCE = (computed: boolean): string => {
  const root = repoRoot();
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  return [
    `import { many, schema, table, text, integer } from ${pg};`,
    'const users = table("users", { id: text().primaryKey() }, { relations: { posts: many("posts", "authorId") } });',
    'const posts = table("posts", { id: text().primaryKey(), authorId: text().references("users"), views: integer().nullable() });',
    "export const app = schema({",
    "  tables: [users, posts],",
    ...(computed
      ? [
          "  computed: { users: { postCount: (u) => u.posts.count(), top: (u) => u.posts.max('views') } },",
        ]
      : []),
    "});",
    "",
  ].join("\n");
};

function writeProject(cwd: string, url: string, computed: boolean): void {
  writeFileSync(join(cwd, "schema.ts"), SCHEMA_SOURCE(computed));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(repoRoot(), "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "migrations"), { recursive: true });
}

function tree(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(directory.length)] = readFileSync(path, "utf8");
  }
  return out;
}

postgresTest(
  gate,
  "generate, check, and pull read the same project with and without a declaration",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const plain = mkdtempSync(join(tmpdir(), "okm-computed-plain-"));
    const declared = mkdtempSync(join(tmpdir(), "okm-computed-declared-"));
    const pulledPlain = mkdtempSync(join(tmpdir(), "okm-computed-pull-a-"));
    const pulledDeclared = mkdtempSync(join(tmpdir(), "okm-computed-pull-b-"));
    try {
      writeProject(plain, database.url, false);
      writeProject(declared, database.url, true);
      await generateProject(plain, "init", []);
      await generateProject(declared, "init", []);
      const files = (cwd: string): Record<string, string> => tree(join(cwd, "migrations"));
      expect(files(declared)).toEqual(files(plain));
      expect(Object.keys(files(plain)).length).toBeGreaterThan(1);

      await applyProject(declared, { allowProtected: false, allowPooler: false });
      const checkedPlain = await checkProject(plain);
      const checkedDeclared = await checkProject(declared);
      expect(checkedDeclared.findings).toEqual(checkedPlain.findings);
      expect(checkedPlain.findings).toEqual([]);

      await pullProject(plain, ["--out", pulledPlain]);
      await pullProject(declared, ["--out", pulledDeclared]);
      const pulled = (cwd: string): Record<string, string> => tree(cwd);
      expect(pulled(pulledDeclared)).toEqual(pulled(pulledPlain));
      expect(Object.keys(pulled(pulledPlain)).length).toBeGreaterThan(0);
    } finally {
      await admin.end();
      for (const dir of [plain, declared, pulledPlain, pulledDeclared]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
