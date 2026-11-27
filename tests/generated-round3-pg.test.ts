/**
 * Generated-column and foreign-key gaps on real Postgres.
 *
 * `NEON_*` and `SUPABASE_*` are unset. Those hosts are not reachable here.
 * Virtual statements run only on PostgreSQL 18 or newer.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, sql, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { assertGeneratedImmutable } from "../src/tooling/migrate/generated-check.js";
import { refuseGeneratedRows } from "../src/tooling/migrate/generated-probe.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const gate = await loadPostgresGate();

for (const name of [
  "NEON_R1_URL",
  "NEON_R2_URL",
  "NEON_POOL_URL",
  "NEON_URL",
  "NEON_R2_POOL_URL",
  "NEON_R1_POOL_URL",
  "SUPABASE_URL",
  "SUPABASE_TRANSACTION_POOL_URL",
  "SUPABASE_SESSION_POOL_URL",
] as const) {
  delete process.env[name];
}

postgresTest(
  gate,
  "a non-immutable generated expression fails at check with a trap hint",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      const built = schema({
        tables: [
          table("stats", {
            name: t.text(),
            label: t.text().generated(() => sql`concat(name, name)`),
          }),
        ],
      });
      let caught: unknown;
      try {
        await assertGeneratedImmutable(built.catalog, database.url);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      if (caught instanceof OkmError) {
        expect(caught.code).toBe("OKM1848");
        expect(caught.message + (caught.fix?.summary ?? "")).toContain("coalesce");
      }
    } finally {
      await database.close();
    }
  },
);

postgresTest(gate, "violating virtual rows stop apply and clean rows pass", async () => {
  const database = await createIsolatedDatabase();
  const db = openPostgres(database.url);
  try {
    const version = await db<{ version: string }[]>`show server_version_num`;
    const major = Math.floor(Number(version[0]?.version ?? "0") / 10_000);
    if (major < 18) return;
    await db.unsafe(
      `create table stats (qty integer, total integer generated always as (qty + 1) virtual not null)`,
    );
    await db.unsafe(`insert into stats (qty) values (1)`);
    const bad = `alter table "public"."stats" alter column "total" set expression as (qty - qty)`;
    let caught: unknown;
    try {
      await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        migrations: [
          {
            id: "0001_expr",
            catalogHash: "expr",
            steps: [
              {
                sql: bad,
                kind: "set-generated",
                class: "expand",
                action: "ddl",
                lock: "ACCESS EXCLUSIVE",
                transactional: true,
              },
            ],
          },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OkmError);
    if (caught instanceof OkmError) {
      expect(caught.code).toBe("OKM1922");
      expect(caught.message).toContain("Nothing was changed.");
    }
    const still = await db<{ expr: string }[]>`
      select pg_get_expr(adbin, adrelid) as expr
      from pg_attrdef
      where adrelid = 'stats'::regclass
    `;
    expect(still[0]?.expr).toContain("1");
    await db.unsafe(`delete from stats`);
    await refuseGeneratedRows(
      async (text, params) => {
        await db.unsafe(text, params as never[]);
        return { rows: [] };
      },
      "public",
      [{ sql: bad }],
    );
  } finally {
    await db.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "rewrite weights match relfilenode and AccessExclusiveLock", async () => {
  const database = await createIsolatedDatabase();
  const db = openPostgres(database.url);
  try {
    const before = schema({
      tables: [
        table("stats", {
          n: t.integer(),
          flag: t.integer(),
          total: t.integer().generated(() => sql`n + 1`),
        }),
      ],
    });
    const typed = schema({
      tables: [
        table("stats", {
          n: t.integer(),
          flag: t.bigint(),
          total: t.integer().generated(() => sql`n + 1`),
        }),
      ],
    });
    const expressed = schema({
      tables: [
        table("stats", {
          n: t.integer(),
          flag: t.integer(),
          total: t.integer().generated(() => sql`n + 2`),
        }),
      ],
    });
    const added = schema({
      tables: [
        table("stats", {
          n: t.integer(),
          flag: t.integer(),
          total: t.integer().generated(() => sql`n + 1`),
          extra: t.integer().generated(() => sql`n + 3`),
        }),
      ],
    });
    const typePlan = planMigration({
      before: before.catalog,
      after: typed.catalog,
      name: "type",
      postgres: 17,
    });
    const exprPlan = planMigration({
      before: before.catalog,
      after: expressed.catalog,
      name: "expr",
      postgres: 17,
    });
    const addPlan = planMigration({
      before: before.catalog,
      after: added.catalog,
      name: "add",
      postgres: 17,
    });
    await db.unsafe(
      `create table stats (n integer, flag integer, total integer generated always as (n + 1) stored)`,
    );
    await db.unsafe(`insert into stats (n) values (1)`);
    const typeStep = typePlan.steps.find((step) => step.kind === "set-column-type");
    const exprStep = exprPlan.steps.find((step) => step.kind === "set-generated");
    const addStep = addPlan.steps.find((step) => step.sql.includes("extra"));
    expect(typeStep?.weight).toBe("rewrite");
    expect(exprStep?.weight).toBe("rewrite");
    expect(addStep?.weight).toBe("rewrite");
    expect(await rewrites(db, typeStep?.sql ?? "")).toBe(true);
    expect(await rewrites(db, exprStep?.sql ?? "")).toBe(true);
    expect(await rewrites(db, addStep?.sql ?? "")).toBe(true);
  } finally {
    await db.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(
  gate,
  "a deferred foreign key and 40001 at commit use the statement mapper",
  async () => {
    const database = await createIsolatedDatabase();
    const users = table("users", { id: t.integer().primaryKey() });
    const posts = table(
      "posts",
      { id: t.integer().primaryKey(), authorId: t.integer() },
      {
        foreignKeys: () => ({
          posts_author: {
            columns: ["authorId"],
            references: { table: "users", columns: ["id"] },
            deferrable: "deferred",
          },
        }),
      },
    );
    const built = schema({ tables: [users, posts] });
    const db = connect(database.url, { schema: built });
    const raw = openPostgres(database.url);
    try {
      for (const statement of planMigration({
        before: schema({ tables: [] }).catalog,
        after: built.catalog,
        name: "fk",
      }).steps) {
        await raw.unsafe(statement.sql);
      }
      let caught: unknown;
      try {
        await db.tx(async (tx) => {
          await tx.posts.insert({ id: 1, authorId: 9 });
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      if (caught instanceof OkmError) {
        expect(caught.kind).toBe("foreign_key");
        expect(caught.constraint ?? caught.message).toContain("posts_author");
      }
      await raw.unsafe(`
      create function okm_boom() returns trigger language plpgsql as $$
      begin
        raise exception 'serialization' using errcode = '40001';
      end $$
    `);
      await raw.unsafe(`
      create constraint trigger posts_boom after insert on posts
      deferrable initially deferred for each row execute function okm_boom()
    `);
      let attempts = 0;
      let retryCaught: unknown;
      try {
        await db.tx({ retry: 1 }, async (tx) => {
          attempts += 1;
          await tx.users.insert({ id: attempts });
          await tx.posts.insert({ id: attempts, authorId: attempts });
        });
      } catch (error) {
        retryCaught = error;
      }
      expect(attempts).toBe(2);
      expect(retryCaught).toBeInstanceOf(OkmError);
      if (retryCaught instanceof OkmError) expect(retryCaught.kind).toBe("serialization");
    } finally {
      await db.close();
      await raw.end({ timeout: 5 });
      await database.close();
    }
  },
);

postgresTest(
  gate,
  "drop column on a generated column drops its index and check and stops on a view",
  async () => {
    const database = await createIsolatedDatabase();
    const db = openPostgres(database.url);
    try {
      await db.unsafe(
        `create table stats (n integer, total integer generated always as (n + 1) stored)`,
      );
      await db.unsafe(`insert into stats (n) values (1)`);
      await db.unsafe(`create unique index stats_total on stats (total)`);
      await db.unsafe(`alter table stats add constraint stats_total_check check (total > 0)`);
      await db.unsafe(`create view stats_v as select total from stats`);
      let caught: unknown;
      try {
        await db.unsafe(`alter table stats drop column total`);
      } catch (error) {
        caught = error;
      }
      const blocked = caught as { code?: string };
      expect(blocked.code).toBe("2BP01");
      await db.unsafe(`drop view stats_v`);
      await db.unsafe(`alter table stats drop column total`);
      const left = await db<{ indexes: string; checks: string }[]>`
        select
          (select count(*)::text from pg_indexes where tablename = 'stats' and indexname = 'stats_total') as indexes,
          (select count(*)::text from pg_constraint where conname = 'stats_total_check') as checks
      `;
      expect(left[0]?.indexes).toBe("0");
      expect(left[0]?.checks).toBe("0");
      const view = await db<{ n: string }[]>`
        select count(*)::text as n from pg_views where viewname = 'stats_v'
      `;
      expect(view[0]?.n).toBe("0");
    } finally {
      await db.end({ timeout: 5 });
      await database.close();
    }
  },
);

async function rewrites(db: ReturnType<typeof openPostgres>, statement: string): Promise<boolean> {
  if (statement.length === 0) return false;
  return db.begin(async (tx) => {
    const before = await tx<{ node: string }[]>`
      select relfilenode::text as node from pg_class where oid = 'stats'::regclass
    `;
    await tx.unsafe(statement);
    const locks = await tx<{ mode: string }[]>`
      select mode from pg_locks
      where relation = 'stats'::regclass and pid = pg_backend_pid()
    `;
    const after = await tx<{ node: string }[]>`
      select relfilenode::text as node from pg_class where oid = 'stats'::regclass
    `;
    expect(locks.some((row) => row.mode === "AccessExclusiveLock")).toBe(true);
    return before[0]?.node !== after[0]?.node;
  });
}
