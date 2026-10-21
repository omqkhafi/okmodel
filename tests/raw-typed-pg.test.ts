/**
 * Typed `raw(db, sql, params)` on Postgres: the lock comes from a real
 * `okm raw sync`, the codecs round-trip enum, jsonb, bigint, and arrays, a
 * write goes to the primary, a transaction owns its statements, and a tenant
 * client is refused.
 */

import { afterAll, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { raw, registerRawLock, schema, t, table, trusted } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { runRawSync } from "../src/tooling/describe/command.js";
import type { ObserveEvent } from "../src/runtime/observe-types.js";
import { repoRoot } from "../scripts/root.js";
import { createIsolatedDatabase, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { primaryUrl, replicaUrl } from "../packages/harness/src/topology.js";

const root = repoRoot();
const gate = await loadPostgresGate();

const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const BIG = 9_007_199_254_740_993n;

const INSERT =
  "insert into tasks (id, title, done, big, meta, mood, moods, note, tenant_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id";
const SELECT = "select id, title, done, big, meta, mood, moods, note from tasks where id = $1";
const RETITLE = "update tasks set title = $2 where id = $1";
const WIDE = "select * from tasks where id = $1";
const UNLOCKED = 'select count(*) as "n!" from tasks';

const ENUM_SQL = "create type mood as enum ('open', 'closed')";
const TABLE_SQL =
  "create table tasks (id integer primary key, title text not null, done boolean not null default false, big bigint not null default 0, meta jsonb not null default '{}', mood mood not null default 'open', moods mood[] not null default '{}', note text, tenant_id uuid)";

const plain = schema({
  casing: "snake",
  codecs: { bigint: "bigint" },
  tables: [table("tasks", { id: t.integer().primaryKey(), title: t.text() })],
});

const tenant = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [table("tasks", { id: t.integer().primaryKey(), title: t.text() })],
});

const run = raw as unknown as (
  db: object,
  sql: string,
  params: unknown,
) => Promise<readonly Record<string, unknown>[]>;

type Fixture = {
  readonly url: string;
  readonly dir: string;
  readonly close: () => Promise<void>;
};

let shared: Promise<Fixture> | undefined;

function fixture(): Promise<Fixture> {
  shared ??= build();
  return shared;
}

async function build(): Promise<Fixture> {
  const database = await createIsolatedDatabase();
  const pool = openPostgres({ url: database.url, max: 1 });
  const cwd = mkdtempSync(join(tmpdir(), "okm-raw-typed-pg-"));
  try {
    await pool.execute(ENUM_SQL);
    await pool.execute(TABLE_SQL);
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { integer, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'export default schema({ codecs: { bigint: "bigint" }, tables: [table("tasks", { id: integer().primaryKey(), title: text() })] });',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        `export default defineConfig({ schema: "./schema.ts", database: ${JSON.stringify(database.url)} });`,
        "",
      ].join("\n"),
    );
    mkdirSync(join(cwd, "src"));
    writeFileSync(
      join(cwd, "src", "app.ts"),
      [
        'import { raw } from "okmodel/pg";',
        ...[INSERT, SELECT, RETITLE, WIDE].map(
          (sql) => `export const a${String(sql.length)} = raw(db, ${JSON.stringify(sql)}, []);`,
        ),
        "",
      ].join("\n"),
    );
    await runRawSync(cwd, false, { allowProtected: false, allowPooler: false });
  } finally {
    await pool.close();
  }
  return { url: database.url, dir: join(cwd, ".okm"), close: () => database.close() };
}

afterAll(async () => {
  if (shared !== undefined) await (await shared).close();
});

async function thrown(work: () => Promise<unknown>): Promise<OkmError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) return error;
  }
  throw new Error("expected OkmError");
}

const row = (id: number) => [
  id,
  `task ${String(id)}`,
  true,
  BIG,
  { nested: { list: [1, "two", null] }, ok: true },
  "closed",
  ["closed", "open", "closed"],
  null,
  null,
];

postgresTest(
  gate,
  "a typed read and write round-trip enum, jsonb, bigint, boolean, and arrays",
  async () => {
    const { url, dir } = await fixture();
    const db = connect(url, { schema: plain, catalogDir: dir, max: 1 });
    try {
      await db.connected;
      const written = await run(db, INSERT, row(1));
      expect(written).toEqual([{ id: 1 }]);
      const read = await run(db, SELECT, [1]);
      expect(read).toEqual([
        {
          id: 1,
          title: "task 1",
          done: true,
          big: BIG,
          meta: { nested: { list: [1, "two", null] }, ok: true },
          mood: "closed",
          moods: ["closed", "open", "closed"],
          note: null,
        },
      ]);
      await run(db, RETITLE, [1, "renamed"]);
      expect((await run(db, SELECT, [1]))[0]?.title).toBe("renamed");
      expect(await run(db, SELECT, [404])).toEqual([]);
      const bad = await thrown(() => run(db, SELECT, ["x"]));
      expect(bad.code).toBe("OKM1210");
    } finally {
      await db.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a typed write runs on the primary of a topology and its event is a raw event",
  async () => {
    const { dir } = await fixture();
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(ENUM_SQL);
      await sql.unsafe(TABLE_SQL);
      const events: ObserveEvent[] = [];
      const db = await connect(
        { primary: primaryUrl(), replicas: [{ url: replicaUrl("a"), name: "east" }] },
        {
          schema: plain,
          catalogDir: dir,
          searchPath: schemaName,
          max: 1,
          onWrite: (event) => void events.push(event),
        },
      );
      try {
        await db.connected;
        expect(await run(db, INSERT, row(50))).toEqual([{ id: 50 }]);
        const stored = await sql.unsafe("select id, big::text as big from tasks");
        expect(stored.map((item) => item.id)).toEqual([50]);
        expect(stored[0]?.big).toBe(String(BIG));
        expect(events.find((event) => event.type === "write")).toMatchObject({
          table: null,
          op: "raw",
          source: "raw",
          rowCount: 1,
          rowCountMode: "returned",
        });
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a tenant client refuses typed raw, and trusted() runs it with its reason",
  async () => {
    const { url, dir } = await fixture();
    const events: ObserveEvent[] = [];
    const db = connect(url, {
      schema: tenant,
      catalogDir: dir,
      max: 1,
      onWrite: (event) => void events.push(event),
    });
    try {
      await db.connected;
      const scoped = db.for({ tenantId: TENANT });
      const refused = await thrown(() => run(scoped, SELECT, [1]));
      expect(refused.code).toBe("OKM1702");
      expect(refused.fix.summary).toContain("trusted");
      expect((await thrown(() => run(db, SELECT, [1]))).code).toBe("OKM1702");
      const open = trusted(scoped, "tenant-scoped backfill");
      const values = row(20);
      values[8] = TENANT;
      await run(open, INSERT, values);
      expect((await run(open, SELECT, [20]))[0]?.title).toBe("task 20");
      const write = events.find((event) => event.type === "write");
      expect(write).toMatchObject({
        table: null,
        op: "raw",
        source: "raw",
        rowCountMode: "returned",
        tag: "trusted: tenant-scoped backfill",
      });
      expect((await thrown(() => run(scoped, SELECT, [20]))).code).toBe("OKM1702");
    } finally {
      await db.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a statement missing from the lock is OKM1601 and nothing reaches the server",
  async () => {
    const { url, dir } = await fixture();
    const db = connect(url, { schema: plain, catalogDir: dir, max: 1 });
    try {
      await db.connected;
      const error = await thrown(() => run(db, UNLOCKED, []));
      expect(error.code).toBe("OKM1601");
      expect(error.fix.summary).toContain("okm raw sync");
    } finally {
      await db.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a lock that no longer matches the table is OKM1601",
  async () => {
    const { url, dir } = await fixture();
    const db = connect(url, { schema: plain, catalogDir: dir, max: 1 });
    const admin = openPostgres({ url, max: 1 });
    try {
      await db.connected;
      await run(db, INSERT, row(30));
      expect((await run(db, WIDE, [30]))[0]).toBeDefined();
      await admin.execute("alter table tasks add column extra text");
      const error = await thrown(() => run(db, WIDE, [30]));
      expect(error.code).toBe("OKM1601");
      expect(error.message).toContain("columns");
      expect(error.fix.summary).toContain("okm raw sync");
    } finally {
      await admin.execute("alter table tasks drop column if exists extra");
      await admin.close();
      await db.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a transaction runs typed raw on its own connection and rolls it back",
  async () => {
    const { url, dir } = await fixture();
    const db = connect(url, { schema: plain, catalogDir: dir, max: 2 });
    try {
      await db.connected;
      let inside: readonly Record<string, unknown>[] = [];
      const failure = await thrown(() =>
        db.tx(async (tx) => {
          await run(tx, INSERT, row(40));
          inside = await run(tx, SELECT, [40]);
          expect(await run(db, SELECT, [40])).toEqual([]);
          throw new OkmError("OKM1121", "undo");
        }),
      );
      expect(failure.code).toBe("OKM1121");
      expect(inside).toHaveLength(1);
      expect(await run(db, SELECT, [40])).toEqual([]);
      await db.tx(async (tx) => {
        await run(tx, INSERT, row(41));
      });
      expect(await run(db, SELECT, [41])).toHaveLength(1);
    } finally {
      await db.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a registered lock serves a client that has no .okm directory",
  async () => {
    const { url, dir } = await fixture();
    const text = await Bun.file(join(dir, "raw.lock.json")).text();
    const db = connect(url, { schema: plain, catalogDir: join(dir, "nowhere"), max: 1 });
    try {
      await db.connected;
      expect((await thrown(() => run(db, SELECT, [1]))).code).toBe("OKM1601");
      registerRawLock(JSON.parse(text));
      expect(await run(db, SELECT, [404])).toEqual([]);
    } finally {
      registerRawLock(undefined);
      await db.close();
    }
  },
  30_000,
);
