/**
 * Transaction-local session settings on real Postgres.
 *
 * A value is visible inside the unit and gone after commit and after
 * rollback. It is the first statement of the transaction, before any
 * savepoint, and a nested `tx()` never sets it again. `for()` composes with
 * `with()` in either order. A row-level security policy reads the value, and
 * two clients on one connection never see each other's.
 */

import { expect } from "bun:test";

import { open } from "../src/adapters/pg/postgresjs.js";
import type {
  DriverConnection,
  DriverPool,
  ExecuteResult,
  Statement,
  WireValue,
} from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { fragment, ident, raw, schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { openPostgres, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl, replicaUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import { columnTenancy, rlsTenancy } from "../src/runtime/tenancy/index.js";

const gate = await loadPostgresGate();

const USER_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const USER_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

const ctx = sessionSettings({
  userId: { name: "app.user_id", type: "uuid", required: true },
  role: { name: "app.role", type: "text" },
  level: { name: "app.level", type: "int" },
  admin: { name: "app.admin", type: "bool" },
});

const notes = table("notes", {
  id: t.identity(),
  title: t.text(),
  actor: t.text().nullable(),
  level: t.text().nullable(),
});

const plain = schema({ casing: "snake", tables: [notes] });

const columnNotes = table("cnotes", {
  id: t.identity(),
  title: t.text(),
  actor: t.text().nullable(),
});
const columned = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [columnNotes],
});

const user = sessionSettings({
  userId: { name: "app.user_id", type: "uuid", required: true },
});

const tenantNotes = table("tnotes", { id: t.identity(), title: t.text() });
const tenanted = schema({
  casing: "snake",
  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tenantNotes],
});

const docs = table("docs", { id: t.identity(), title: t.text(), ownerId: t.uuid() });
const guarded = schema({ casing: "snake", tables: [docs] });

const SEEN = "nullif(current_setting('app.user_id', true), '')";

const SCHEMA_SQL = [
  `create table notes (
     id bigint generated always as identity primary key,
     title text not null,
     actor text default ${SEEN},
     level text default nullif(current_setting('app.level', true), '')
   )`,
  `create table docs (
     id bigint generated always as identity primary key,
     title text not null,
     owner_id uuid not null
   )`,
  "alter table docs enable row level security",
  `create policy own_docs on docs
     using (owner_id = ${SEEN}::uuid)
     with check (owner_id = ${SEEN}::uuid)`,
];

class Seen {
  id = "";
  seen: string | null = "";
  level: string | null = "";
}

class Level {
  id = "";
  level: string | null = "";
}

/** A driver pool that records every statement text, in order. */
type Recorded = DriverPool & { readonly log: string[] };

function recording(inner: DriverPool): Recorded {
  const log: string[] = [];
  const note = (text: string): void => {
    log.push(text);
  };
  const conn = (c: DriverConnection): DriverConnection => ({
    ...c,
    execute: (text, params, options) => {
      note(text);
      return c.execute(text, params, options);
    },
    batch: (statements, options) => {
      for (const statement of statements) note(statement.text);
      return c.batch(statements, options);
    },
    release: () => c.release(),
  });
  const pool: Recorded = {
    ...inner,
    log,
    execute: (text: string, params?: readonly WireValue[], options?: never) => {
      note(text);
      return inner.execute(text, params, options);
    },
    batch: (statements: readonly Statement[], options?: never) => {
      for (const statement of statements) note(statement.text);
      return inner.batch(statements, options);
    },
    stats: () => inner.stats(),
    close: () => inner.close(),
  };
  if (inner.reserve !== undefined) {
    const reserve = inner.reserve.bind(inner);
    pool.reserve = async () => conn(await reserve());
  }
  return pool;
}

type Fixture = {
  readonly url: string;
  readonly schemaName: string;
  readonly pool: (max?: number) => DriverPool;
};

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    await sql.unsafe(`set search_path to "${schemaName}"`);
    for (const statement of SCHEMA_SQL) await sql.unsafe(statement);
    await fn({
      url: primaryUrl(),
      schemaName,
      pool: (max = 1) => open({ url: primaryUrl(), max, searchPath: schemaName }),
    });
  });
}

async function leftover(pool: DriverPool, name: string): Promise<WireValue> {
  const result: ExecuteResult = await pool.execute(`select current_setting('${name}', true)`);
  return result.rows[0]?.[0] ?? null;
}

/** Runs `fn` as a login role that owns nothing, so row-level security applies to it. */
async function asRole(
  schemaName: string,
  tables: readonly string[],
  fn: (url: string, base: (host: string) => string) => Promise<void>,
): Promise<void> {
  const admin = openPostgres();
  const role = `okm_session_${schemaName.slice(-8)}`;
  try {
    await admin.unsafe(`create role ${role} login password 'sessionapp'`);
    await admin.unsafe(`grant usage on schema "${schemaName}" to ${role}`);
    for (const name of tables) {
      await admin.unsafe(
        `grant select, insert, update, delete on "${schemaName}"."${name}" to ${role}`,
      );
    }
    const as = (base: string): string => {
      const url = new URL(base);
      url.username = role;
      url.password = "sessionapp";
      return url.href;
    };
    await fn(as(primaryUrl()), as);
  } finally {
    await admin.unsafe(`drop owned by ${role}`).catch(() => undefined);
    await admin.unsafe(`drop role if exists ${role}`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
}

const SET = /^select set_config\(/;

async function rejected(run: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

postgresTest(
  gate,
  "a value is visible in the unit and gone after commit and after rollback",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = openPool();
      const db = connect(pool, { schema: plain, session: ctx });
      try {
        await db.connected;
        const scoped = db.with({ userId: USER_A, level: 7 });
        const inside = await scoped.tx(async (tx) => tx.notes.insert({ title: "in a unit" }));
        expect(inside.actor).toBe(USER_A);
        expect(inside.level).toBe("7");
        expect(await leftover(pool, "app.user_id")).toBe("");
        expect(await leftover(pool, "app.level")).toBe("");

        const single = await scoped.notes.insert({ title: "one statement" });
        expect(single.actor).toBe(USER_A);
        expect(await leftover(pool, "app.user_id")).toBe("");

        let seen: string | null = null;
        expect(
          await rejected(() =>
            scoped.tx(async (tx) => {
              seen = (await tx.notes.insert({ title: "rolled back" })).actor;
              throw new Error("undo");
            }),
          ),
        ).toMatchObject({ message: "undo" });
        expect(seen === USER_A).toBe(true);
        expect(await leftover(pool, "app.user_id")).toBe("");
        const count = await db.with({ userId: USER_A }).notes.find({ limit: 50 });
        expect(count.map((row) => row.title)).toEqual(["in a unit", "one statement"]);
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "the set is one statement, first in the transaction, before any savepoint",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = recording(openPool());
      const db = connect(pool, { schema: plain, session: ctx });
      try {
        await db.connected;
        pool.log.length = 0;
        await db.with({ userId: USER_A, role: "editor", admin: true }).tx(async (tx) => {
          await tx.notes.insert({ title: "outer" });
          await tx.tx(async (inner) => {
            await inner.notes.insert({ title: "inner" });
          });
          expect(
            await rejected(() =>
              tx.tx(async (inner) => {
                await inner.notes.insert({ title: "undone" });
                throw new Error("undo");
              }),
            ),
          ).toMatchObject({ message: "undo" });
          await tx.notes.insert({ title: "after the savepoint" });
        });
        const log = [...pool.log];
        const begin = log.findIndex((text) => /^begin/i.test(text));
        expect(begin).toBeGreaterThanOrEqual(0);
        expect(log[begin + 1]).toMatch(SET);
        expect(log[begin + 1]).toContain("set_config($1, $2, true)");
        expect(log[begin + 1]).toContain("set_config($3, $4, true)");
        expect(log[begin + 1]).toContain("set_config($5, $6, true)");
        expect(log.filter((text) => SET.test(text))).toHaveLength(1);
        const savepoint = log.findIndex((text) => /^savepoint/i.test(text));
        expect(savepoint).toBeGreaterThan(begin + 1);
        const rows = await db.with({ userId: USER_A }).notes.find({ limit: 50 });
        expect(rows.map((row) => [row.title, row.actor])).toEqual([
          ["outer", USER_A],
          ["inner", USER_A],
          ["after the savepoint", USER_A],
        ]);
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "rolling back to a savepoint does not cancel the setting",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = openPool();
      const db = connect(pool, { schema: plain, session: ctx });
      try {
        await db.connected;
        const seen: (string | null)[] = [];
        await db.with({ userId: USER_B, level: 3 }).tx(async (tx) => {
          expect(
            await rejected(() =>
              tx.tx(async (inner) => {
                seen.push((await inner.notes.insert({ title: "a" })).actor);
                throw new Error("undo");
              }),
            ),
          ).toMatchObject({ message: "undo" });
          seen.push((await tx.notes.insert({ title: "b" })).actor);
          const [row] = await raw(
            tx.notes,
            Level,
            "read",
            fragment`
            select ${ident("id")}, nullif(current_setting('app.level', true), '') as level
            from notes
          `,
          );
          seen.push(row?.level ?? null);
        });
        expect(seen).toEqual([USER_B, USER_B, "3"]);
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "clients with other values never see each other's, slow read against concurrent write",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = openPool(4);
      const db = connect(pool, { schema: plain, session: ctx });
      try {
        await db.connected;
        const a = db.with({ userId: USER_A });
        const b = db.with({ userId: USER_B });
        const slow = a.tx(async (tx) => {
          const first = await tx.notes.insert({ title: "a1" });
          await Bun.sleep(300);
          const second = await tx.notes.insert({ title: "a2" });
          return [first.actor, second.actor];
        });
        await Bun.sleep(50);
        const writes = await Promise.all(
          Array.from(
            { length: 5 },
            async (_unused, index) => (await b.notes.insert({ title: `b${String(index)}` })).actor,
          ),
        );
        expect(writes).toEqual(Array.from({ length: 5 }, () => USER_B));
        expect(await slow).toEqual([USER_A, USER_A]);
        const reads = await Promise.all([
          a.notes.find({ limit: 50 }),
          b.notes.find({ limit: 50 }),
          a.notes.find({ limit: 50 }),
        ]);
        expect(reads[0]?.every((row) => row.actor !== null)).toBe(true);
        expect(await leftover(pool, "app.user_id")).toBe("");
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a read sees the value on its read-only transaction",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = recording(openPool());
      const db = connect(pool, { schema: plain, session: ctx });
      try {
        await db.connected;
        await db.with({ userId: USER_A }).notes.insert({ title: "x" });
        pool.log.length = 0;
        const [row] = await raw(
          db.with({ userId: USER_A, level: 9 }).notes,
          Seen,
          "read",
          fragment`
          select ${ident("id")}, nullif(current_setting('app.user_id', true), '') as seen,
            nullif(current_setting('app.level', true), '') as level
          from notes
        `,
        );
        expect(row?.seen).toBe(USER_A);
        expect(row?.level).toBe("9");
        expect(pool.log.findIndex((text) => /^begin read only/i.test(text))).toBeGreaterThanOrEqual(
          0,
        );
        const begin = pool.log.findIndex((text) => /^begin/i.test(text));
        expect(pool.log[begin + 1]).toMatch(SET);
        const replicaPort = process.env.OKM_REPLICA_A_PORT ?? "55433";
        expect(replicaUrl("a")).toContain(`:${replicaPort}/`);
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "for() composes with with() in either order, and the unit sets once with both",
  async () => {
    await withFixture(async ({ schemaName }) => {
      const admin = openPostgres();
      try {
        for (const statement of renderCatalog(tenanted.catalog, schemaName)) {
          await admin.unsafe(statement);
        }
      } finally {
        await admin.end({ timeout: 5 });
      }
      await asRole(schemaName, ["tnotes"], async (url) => {
        const pool = recording(open({ url, max: 1, searchPath: schemaName }));
        const db = connect(pool, { schema: tenanted, session: user });
        const viaFor = db.for({ tenantId: TENANT_A }).with({ userId: USER_A });
        const viaWith = db.with({ userId: USER_A }).for({ tenantId: TENANT_A });
        try {
          await db.connected;
          for (const scoped of [viaFor, viaWith]) {
            pool.log.length = 0;
            const row = await scoped.tnotes.insert({ title: "mixed" });
            expect(row.tenantId).toBe(TENANT_A);
            const sets = pool.log.filter((text) => SET.test(text));
            expect(sets).toHaveLength(1);
            expect(sets[0]).toContain("set_config($1, $2, true), set_config($3, $4, true)");
          }
          pool.log.length = 0;
          await viaFor.tx(async (tx) => {
            await tx.tnotes.insert({ title: "in a unit" });
            await tx.tx(async (inner) => {
              await inner.tnotes.insert({ title: "nested" });
            });
          });
          expect(pool.log.filter((text) => SET.test(text))).toHaveLength(1);
          const begin = pool.log.findIndex((text) => /^begin/i.test(text));
          expect(pool.log[begin + 1]).toMatch(SET);
          expect((await viaFor.tnotes.find({ limit: 50 })).length).toBe(4);
          const other = db.for({ tenantId: TENANT_B }).with({ userId: USER_B });
          expect((await other.tnotes.find({ limit: 50 })).length).toBe(0);
          expect(await leftover(pool, "app.user_id")).toBe("");
          expect(await leftover(pool, "app.tenant")).toBe("");
        } finally {
          await db.close();
          await pool.close();
        }
      });
    });
  },
  60_000,
);

postgresTest(
  gate,
  "for() and with() compose on column tenancy and unscoped() keeps the setting",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = openPool();
      const db = connect(pool, { schema: columned, session: user });
      try {
        await db.connected;
        await pool.execute(
          "create table cnotes (id bigint generated always as identity primary key, tenant_id uuid not null, title text not null, actor text default nullif(current_setting('app.user_id', true), ''))",
        );
        const viaFor = db.for({ tenantId: TENANT_A }).with({ userId: USER_A });
        const viaWith = db.with({ userId: USER_B }).for({ tenantId: TENANT_A });
        expect((await viaFor.cnotes.insert({ title: "one" })).actor).toBe(USER_A);
        expect((await viaWith.cnotes.insert({ title: "two" })).actor).toBe(USER_B);
        const seen = await db.with({ userId: USER_A }).unscoped("test").cnotes.find({ limit: 10 });
        expect(seen.map((row) => row.title).sort()).toEqual(["one", "two"]);
        const again = await db.unscoped("test").with({ userId: USER_A }).cnotes.find({ limit: 10 });
        expect(again).toHaveLength(2);
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "an RLS policy reads the setting, and a client without it sees nothing",
  async () => {
    await withFixture(async ({ schemaName }) => {
      await asRole(schemaName, ["docs"], async (url) => {
        const pool = open({ url, max: 1, searchPath: schemaName });
        const db = connect(pool, { schema: guarded, session: user });
        try {
          await db.connected;
          const a = db.with({ userId: USER_A });
          const b = db.with({ userId: USER_B });
          await a.docs.insert({ title: "mine", ownerId: USER_A });
          await b.docs.insert({ title: "theirs", ownerId: USER_B });
          expect((await a.docs.find({ limit: 50 })).map((row) => row.title)).toEqual(["mine"]);
          expect((await b.docs.find({ limit: 50 })).map((row) => row.title)).toEqual(["theirs"]);
          expect(
            await rejected(() => a.docs.insert({ title: "forged", ownerId: USER_B })),
          ).toBeInstanceOf(OkmError);
          const rows = await a.tx(async (tx) => {
            await tx.docs.insert({ title: "second", ownerId: USER_A });
            return tx.docs.find({ limit: 50 });
          });
          expect(rows.map((row) => row.title).sort()).toEqual(["mine", "second"]);
          expect(await leftover(pool, "app.user_id")).toBe("");
          const bare = await pool.execute("select count(*) from docs");
          expect(bare.rows[0]?.[0]).toBe("0");
        } finally {
          await db.close();
          await pool.close();
        }
      });
    });
  },
  60_000,
);

/**
 * Waits until an explicit replica read is served.
 *
 * A replica that is still catching up, or whose position is not known yet,
 * is OKM1843. The call does not fall back to the primary.
 */
async function replicaRows(read: () => Promise<readonly string[]>): Promise<readonly string[]> {
  let last: unknown;
  // The file is dealt onto a suite shard. On Postgres 18 isolation the
  // replica can stay behind the watermark for longer than 20s.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const rows = await read();
      if (rows.length > 0) return rows;
    } catch (error) {
      if (!(error instanceof OkmError) || error.code !== "OKM1843") throw error;
      last = error;
    }
    await Bun.sleep(100);
  }
  if (last !== undefined) throw last;
  return [];
}

postgresTest(
  gate,
  "a read routed to a replica sets the value on its read-only transaction",
  async () => {
    await withFixture(async ({ schemaName }) => {
      await asRole(schemaName, ["docs"], async (url, as) => {
        const db = await connect(
          {
            primary: url,
            replicas: [{ url: as(replicaUrl("a")), name: "a" }],
          },
          { schema: guarded, session: user, searchPath: schemaName, max: 1 },
        );
        try {
          const a = db.with({ userId: USER_A });
          const b = db.with({ userId: USER_B });
          await a.docs.insert({ title: "mine", ownerId: USER_A });
          await b.docs.insert({ title: "theirs", ownerId: USER_B });
          const titles = await replicaRows(async () =>
            (await a.docs.find({ limit: 50, route: "replica" })).map((row) => row.title),
          );
          expect(titles).toEqual(["mine"]);
          const others = await replicaRows(async () =>
            (await b.docs.find({ limit: 50, route: "replica" })).map((row) => row.title),
          );
          expect(others).toEqual(["theirs"]);
        } finally {
          await db.close();
        }
      });
    });
  },
  120_000,
);

postgresTest(
  gate,
  "batch starts with the set statement",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = recording(openPool());
      const db = connect(pool, { schema: plain, session: ctx });
      try {
        await db.connected;
        pool.log.length = 0;
        const scoped = db.with({ userId: USER_A });
        const [first, second] = await scoped.batch([
          scoped.notes.insert({ title: "one" }),
          scoped.notes.insert({ title: "two" }),
        ]);
        expect([first.actor, second.actor]).toEqual([USER_A, USER_A]);
        expect(pool.log.filter((text) => SET.test(text))).toHaveLength(1);
        const begin = pool.log.findIndex((text) => /^begin/i.test(text));
        const savepoint = pool.log.findIndex((text) => /^savepoint/i.test(text));
        expect(pool.log[begin + 1]).toMatch(SET);
        expect(savepoint === -1 || savepoint > begin + 1).toBe(true);
        expect(await leftover(pool, "app.user_id")).toBe("");
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "values and a missing required key are refused before any statement",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = recording(openPool());
      const db = connect(pool, { schema: plain, session: ctx });
      try {
        await db.connected;
        pool.log.length = 0;
        const attempts: (() => unknown)[] = [
          () => db.with({ userId: "not a uuid" }),
          () => db.with({ userId: USER_A, level: 1.5 }),
          () => db.with({ userId: USER_A, admin: "yes" as unknown as boolean }),
          () => db.with({ role: "x" } as never),
        ];
        for (const attempt of attempts) {
          expect(attempt).toThrow(OkmError);
        }
        expect(await rejected(() => db.notes.find({ limit: 1 }))).toMatchObject({
          code: "OKM1709",
        });
        expect(await rejected(() => db.notes.insert({ title: "x" }))).toMatchObject({
          code: "OKM1709",
        });
        expect(await rejected(() => db.tx(async () => 1))).toMatchObject({ code: "OKM1709" });
        expect(pool.log).toEqual([]);
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a setting that is not given stays unset, and with() calls merge",
  async () => {
    await withFixture(async ({ pool: openPool }) => {
      const pool = recording(openPool());
      const db = connect(pool, { schema: plain, session: ctx });
      try {
        await db.connected;
        pool.log.length = 0;
        const row = await db.with({ userId: USER_A }).notes.insert({ title: "bare" });
        expect(row.level).toBeNull();
        const set = pool.log.find((text) => SET.test(text)) ?? "";
        expect(set.match(/set_config/g)).toHaveLength(1);
        const merged = await db
          .with({ userId: USER_A })
          .with({ userId: USER_B, level: 2 })
          .notes.insert({ title: "merged" });
        expect(merged.actor).toBe(USER_B);
        expect(merged.level).toBe("2");
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  30_000,
);
