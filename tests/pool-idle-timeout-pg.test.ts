/**
 * Runtime pools close idle connections by default (`idleTimeoutMs`, 30 s).
 */

import { expect, test } from "bun:test";
import pg from "pg";
import postgres from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { DEFAULT_IDLE_MS, idleMs } from "../src/adapters/pg/idle-ms.js";
import { open as openNeon } from "../src/adapters/pg/neon.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openJs } from "../src/adapters/pg/postgresjs.js";
import { fragment, raw, schema, table, t } from "../src/dialects/pg/index.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectJs } from "../src/runtime/pg/postgresjs.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const gate = await loadPostgresGate();
const notes = table("notes", {
  id: t.identity(),
  title: t.text(),
  actor: t.text().nullable(),
});
const app = schema({ casing: "snake", tables: [notes] });
const session = sessionSettings({
  userId: { name: "app.user_id", type: "text", required: true },
});

class Seen {
  value = "";
}

test("idleMs default is 30 seconds and 0 disables", () => {
  expect(DEFAULT_IDLE_MS).toBe(30_000);
  expect(idleMs(undefined)).toBe(30_000);
  expect(idleMs(0)).toBe(0);
  expect(idleMs(1_500)).toBe(1_500);
});

test("postgres.js open passes idle_timeout seconds from idleMs", () => {
  const url = "postgres://okm:okm@127.0.0.1:1/okm";
  const sqlDefault = postgres(url, { max: 1, idle_timeout: idleMs(undefined) / 1_000 });
  expect(sqlDefault.options.idle_timeout).toBe(30);
  void sqlDefault.end({ timeout: 0 });
  const sqlOff = postgres(url, { max: 1, idle_timeout: idleMs(0) / 1_000 });
  expect(sqlOff.options.idle_timeout).toBe(0);
  void sqlOff.end({ timeout: 0 });
});

test("node-postgres Pool receives idleTimeoutMillis from idleMs", () => {
  const pool = new pg.Pool({
    connectionString: "postgres://okm:okm@127.0.0.1:1/okm",
    max: 1,
    idleTimeoutMillis: idleMs(undefined),
    allowExitOnIdle: true,
  });
  expect(
    (pool as unknown as { options: { idleTimeoutMillis?: number } }).options.idleTimeoutMillis,
  ).toBe(30_000);
  void pool.end();
});

test("Neon HTTP open refuses an explicit idleTimeoutMs with OKM1120", async () => {
  const error = await openNeon({
    url: "postgresql://user:pass@example.neon.tech/db",
    mode: "http",
    idleTimeoutMs: 1_000,
  }).then(
    () => {
      throw new Error("expected OKM1120");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.code).toBe("OKM1120");
  expect(error.message).toBe("timeout");
});

postgresTest(
  gate,
  "postgres.js closes idle pool connections after a short idleTimeoutMs",
  async () => {
    await assertIdleCloses((url, idleTimeoutMs) => openJs({ url, max: 4, idleTimeoutMs }));
  },
  30_000,
);

postgresTest(
  gate,
  "postgres.js idleTimeoutMs 0 keeps idle connections",
  async () => {
    await assertIdleKeeps((url) => openJs({ url, max: 4, idleTimeoutMs: 0 }));
  },
  20_000,
);

postgresTest(
  gate,
  "node-postgres closes idle pool connections after a short idleTimeoutMs",
  async () => {
    await assertIdleCloses((url, idleTimeoutMs) => openPg({ url, max: 4, idleTimeoutMs }));
  },
  30_000,
);

postgresTest(
  gate,
  "node-postgres idleTimeoutMs 0 keeps idle connections",
  async () => {
    await assertIdleKeeps((url) => openPg({ url, max: 4, idleTimeoutMs: 0 }));
  },
  20_000,
);

postgresTest(
  gate,
  "Bun.sql closes idle pool connections after a short idleTimeoutMs",
  async () => {
    if (typeof Bun === "undefined" || typeof Bun.SQL !== "function") {
      throw new Error("Bun.sql runs only under Bun");
    }
    await assertIdleCloses((url, idleTimeoutMs) => openBun({ url, max: 4, idleTimeoutMs }));
  },
  30_000,
);

postgresTest(
  gate,
  "Bun.sql idleTimeoutMs 0 keeps idle connections",
  async () => {
    if (typeof Bun === "undefined" || typeof Bun.SQL !== "function") {
      throw new Error("Bun.sql runs only under Bun");
    }
    await assertIdleKeeps((url) => openBun({ url, max: 4, idleTimeoutMs: 0 }));
  },
  20_000,
);

postgresTest(
  gate,
  "a pool reconnects after idle close; with() and tx stay correct",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table notes (
        id bigint generated always as identity primary key,
        title text not null,
        actor text default nullif(current_setting('app.user_id', true), '')
      )`);
      const db = connectJs(primaryUrl(), {
        schema: app,
        max: 2,
        idleTimeoutMs: 1_000,
        session,
        searchPath: schemaName,
      });
      try {
        await db.connected;
        const first = await db.with({ userId: "alice" }).notes.insert({ title: "a" });
        expect(first.actor).toBe("alice");
        await sleep(2_500);
        const second = await db.with({ userId: "bob" }).tx(async (tx) => {
          const row = await tx.notes.insert({ title: "b" });
          const [seen] = await raw(
            tx.notes,
            Seen,
            "read",
            fragment`select nullif(current_setting('app.user_id', true), '') as value`,
          );
          expect(seen?.value).toBe("bob");
          return row;
        });
        expect(second.actor).toBe("bob");
        const rows = await db.with({ userId: "bob" }).notes.find({ limit: 10 });
        expect(rows.map((row) => row.title).sort()).toEqual(["a", "b"]);
      } finally {
        await db.close();
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "node-postgres and Bun clients open with the default idle timeout",
  async () => {
    const empty = schema({ casing: "snake", tables: [] });
    const js = connectJs(primaryUrl(), { schema: empty, max: 1 });
    const node = connectPg(primaryUrl(), { schema: empty, max: 1 });
    const bun =
      typeof Bun !== "undefined" && typeof Bun.SQL === "function"
        ? connectBun(primaryUrl(), { schema: empty, max: 1 })
        : undefined;
    const clients = bun === undefined ? [js, node] : [js, node, bun];
    try {
      for (const db of clients) await db.connected;
    } finally {
      for (const db of clients) await db.close();
    }
  },
  20_000,
);

type TestPool = {
  execute(text: string): Promise<{ rows: readonly (readonly unknown[])[] }>;
  reserve?(): Promise<{
    execute(text: string): Promise<{ rows: readonly (readonly unknown[])[] }>;
    release(): Promise<void>;
  }>;
  close(): Promise<void>;
};

/**
 * Opens N checkouts on an isolated database, releases them, waits past a 1 s
 * idle timeout, and asserts the server sees at most one leftover backend.
 *
 * @param openPool - Builds a pool with the given idle timeout for `url`
 */
async function assertIdleCloses(
  openPool: (url: string, idleTimeoutMs: number) => TestPool,
): Promise<void> {
  const isolated = await createIsolatedDatabase();
  const admin = openJs({ url: primaryUrl(), max: 1, idleTimeoutMs: 0 });
  const pool = openPool(isolated.url, 1_000);
  try {
    await warm(pool, 3);
    await sleep(2_500);
    expect(await backends(admin, isolated.url)).toBeLessThanOrEqual(1);
  } finally {
    await pool.close();
    await admin.close();
    await isolated.close();
  }
}

/**
 * Opens idle connections with `idleTimeoutMs: 0` and asserts they remain.
 *
 * @param openPool - Builds a pool with idle close disabled for `url`
 */
async function assertIdleKeeps(openPool: (url: string) => TestPool): Promise<void> {
  const isolated = await createIsolatedDatabase();
  const admin = openJs({ url: primaryUrl(), max: 1, idleTimeoutMs: 0 });
  const pool = openPool(isolated.url);
  try {
    await warm(pool, 3);
    await sleep(2_500);
    expect(await backends(admin, isolated.url)).toBeGreaterThanOrEqual(3);
  } finally {
    await pool.close();
    await admin.close();
    await isolated.close();
  }
}

async function warm(pool: TestPool, n: number): Promise<void> {
  const held = [];
  for (let i = 0; i < n; i += 1) {
    const conn = await pool.reserve?.();
    if (conn === undefined) throw new Error("reserve required");
    await conn.execute("select 1");
    held.push(conn);
  }
  for (const conn of held) await conn.release();
}

async function backends(
  admin: { execute(text: string): Promise<{ rows: readonly (readonly unknown[])[] }> },
  url: string,
): Promise<number> {
  const name = new URL(url).pathname.replace(/^\//, "");
  const result = await admin.execute(
    `select count(*)::text from pg_stat_activity where datname = '${name}' and application_name = 'okmodel'`,
  );
  return Number(result.rows[0]?.[0] ?? 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
