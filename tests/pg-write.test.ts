/**
 * Write path on PGlite and, when the topology is up, on postgres.js.
 *
 * Chunked inserts are one transaction. Conflict SQL loads only for `onConflict`.
 */

import { expect, test } from "bun:test";

import { runAtomicBatch, type BatchSession } from "../src/adapters/pg/batch.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import type { DriverPool, ExecuteResult, Statement } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { inc, integer, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { runWriteOn } from "../src/runtime/tx.js";
import { WRITE_PARAM_BUDGET } from "../src/runtime/write.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const TASK_B = "44444444-4444-4444-8444-444444444444";
const SENTINEL = "55555555-5555-4555-8555-555555555555";

const users = table("users", {
  id: uuid(),
  email: text().unique(),
  name: text().nullable(),
  role: text().guarded(),
});

const tasks = table("tasks", {
  id: uuid(),
  ownerId: uuid(),
  title: text(),
  position: integer(),
  qty: integer(),
});

const stock = table("stock", {
  sku: text().unique(),
  qty: integer(),
});

const app = schema({
  casing: "snake",
  tables: [users, tasks, stock],
});

const DDL = [
  `create table users (
    id uuid primary key,
    email text not null,
    name text,
    role text not null default 'member',
    constraint users_email_key unique (email)
  )`,
  `create table tasks (
    id uuid primary key,
    owner_id uuid not null references users (id),
    title text not null,
    position integer not null,
    qty integer not null,
    constraint tasks_positive_check check (position > 0)
  )`,
  `create table stock (
    sku text primary key,
    qty integer not null
  )`,
];

type Client = Awaited<ReturnType<typeof connectPglite<typeof app>>>;

async function expectRejection(pending: Promise<unknown>, code: string): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return error;
  }
  throw new Error(`expected ${code}`);
}

async function seed(pool: DriverPool): Promise<void> {
  for (const statement of DDL) await pool.execute(statement);
}

function rowId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function bulk(count: number): { id: string; email: string; name: undefined }[] {
  const rows: { id: string; email: string; name: undefined }[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({ id: rowId(index), email: `u${String(index)}@b.c`, name: undefined });
  }
  return rows;
}

async function writeSuite(db: Client, pool: DriverPool): Promise<void> {
  await db.connected;
  const inserted = await db.users.insert({ id: USER, email: "a@b.c", name: "Ada" });
  expect(inserted.role).toBe("member");
  expect(inserted.email).toBe("a@b.c");

  const dropped = await db.users.insert({
    id: OTHER,
    email: "b@b.c",
    name: null,
    unknown: true,
  } as never);
  expect(dropped.email).toBe("b@b.c");
  expect("unknown" in dropped).toBe(false);

  await expectRejection(
    db.users.insert({ id: rowId(9), email: "c@b.c", role: "admin" } as never),
    "OKM1190",
  );

  const described = await db.users.insert({ id: rowId(8), email: "d@b.c", name: undefined }).sql();
  expect(described.statements).toHaveLength(1);
  expect(described.statements[0]?.text.includes("on conflict")).toBe(false);
  expect(described.statements[0]?.text.includes("d@b.c")).toBe(false);
  expect(described.statements[0]?.params).toContain("d@b.c");

  await db.tasks.insert({ id: TASK, ownerId: USER, title: "ship", position: 1, qty: 1 });
  await db.tasks.insert({ id: TASK_B, ownerId: USER, title: "shop", position: 2, qty: 4 });

  const updated = await db.tasks.update({
    where: { id: TASK },
    set: { title: "shipped", qty: undefined },
  });
  expect(updated).toEqual({ count: 1 });
  expect((await db.tasks.one({ where: { id: TASK } }))?.qty).toBe(1);

  await db.tasks.update({ where: { id: TASK }, set: { qty: inc(2) } });
  expect((await db.tasks.one({ where: { id: TASK } }))?.qty).toBe(3);

  await db.tasks.update([
    { id: TASK, set: { position: 5 } },
    { id: TASK_B, set: { position: 4 } },
  ]);
  const positions = await db.tasks.find({
    where: { ownerId: USER },
    orderBy: { position: "asc" },
    limit: 5,
  });
  expect(positions.map((row) => row.position)).toEqual([4, 5]);
  const listed = await db.tasks
    .update([
      { id: TASK, set: { title: "a" } },
      { where: { id: TASK_B }, set: { title: "b" } },
    ])
    .sql();
  expect(listed.statements).toHaveLength(1);
  expect(listed.statements[0]?.text.startsWith("update ")).toBe(true);

  await db.tasks.delete({ where: { id: TASK_B } }, { expect: 1 });
  await expectRejection(db.tasks.delete({ where: { id: TASK_B } }, { expect: 1 }), "not_found");
  await expectRejection(db.tasks.update({ set: { title: "x" } } as never), "OKM1102");
  await db.tasks.update({ set: { title: "all" } } as never).all("reset titles");
  expect((await db.tasks.one({ where: { id: TASK } }))?.title).toBe("all");

  const conflict = await expectRejection(
    db.users.insert({ id: rowId(10), email: "a@b.c", name: "Eve" }),
    "unique",
  );
  expect(conflict).toMatchObject({ batchIndex: null, kind: "unique" });

  const ignored = await db.users.insert(
    { id: rowId(11), email: "a@b.c", name: "Eve" },
    { onConflict: "ignore" },
  );
  expect(ignored).toBeNull();

  const existing = await db.users.insert(
    { id: rowId(12), email: "a@b.c", name: "Eve" },
    { onConflict: { on: "email", return: true } },
  );
  expect(existing.id).toBe(USER);
  expect(existing.name).toBe("Ada");

  await db.stock.insert({ sku: "pen", qty: 1 });
  const upserted = await db.stock.insert(
    { sku: "pen", qty: 9 },
    { onConflict: { on: ["sku"], update: ["qty"] }, returning: ["sku", "qty"] },
  );
  expect(upserted).toMatchObject({ sku: "pen", qty: 9 });

  await expectRejection(
    db.stock.insert({ sku: "cup", qty: 1 }, { onConflict: { on: "qty", update: ["qty"] } }),
    "OKM1104",
  );

  const missing = await expectRejection(
    db.tasks.insert({ id: rowId(13), ownerId: rowId(99), title: "x", position: 1, qty: 1 }),
    "foreign_key",
  );
  expect(missing).toMatchObject({ kind: "foreign_key", batchIndex: null });

  const absent = await expectRejection(
    db.tasks.insert({ id: rowId(14), ownerId: USER, title: null, position: 1, qty: 1 } as never),
    "not_null",
  );
  expect(absent).toMatchObject({ kind: "not_null" });

  const checked = await expectRejection(
    db.tasks.insert({ id: rowId(15), ownerId: USER, title: "x", position: 0, qty: 1 }),
    "check",
  );
  expect(checked).toMatchObject({ kind: "check" });

  const width = 2;
  const full = Math.floor(WRITE_PARAM_BUDGET / width);
  const oneChunk = await db.users.insert(bulk(full)).sql();
  expect(oneChunk.statements).toHaveLength(1);
  const twoChunks = await db.users.insert(bulk(full + 1)).sql();
  expect(twoChunks.statements).toHaveLength(2);

  const boundary = bulk(full + 1).map((row, index) =>
    index === 0
      ? { ...row, id: rowId(full + 10), email: `edge${String(index)}@b.c` }
      : { ...row, email: `edge${String(index)}@b.c` },
  );
  const stored = await db.users.insert(boundary);
  expect(stored).toHaveLength(full + 1);

  const failing = bulk(full + 1).map((_row, index) =>
    index === full
      ? { id: rowId(full + 50), email: "a@b.c", name: undefined }
      : { id: rowId(full + 100 + index), email: `roll${String(index)}@b.c`, name: undefined },
  );
  const rolled = await expectRejection(db.users.insert(failing), "unique");
  expect(rolled).toMatchObject({ batchIndex: 1, kind: "unique" });
  expect(await db.users.exists({ where: { email: "roll0@b.c" } })).toBe(false);

  const broken = schema({
    casing: "snake",
    tables: [users, tasks, stock],
  });
  const model = {
    ...broken,
    model: {
      ...broken.model,
      users: { ...broken.model.users, sql: "select" },
    },
  };
  const bad = await connectPglite(pool, { schema: model });
  await expectRejection(
    bad.users.insert({ id: rowId(70), email: "bad@b.c", name: undefined }),
    "OKM1122",
  );
}

test("pglite writes", async () => {
  const pool = await openPglite();
  try {
    await seed(pool);
    const db = await connectPglite(pool, { schema: app });
    await writeSuite(db, pool);
    await savepoint(pool);
    await db.close();
  } finally {
    await pool.close();
  }
});

test("outcome_unknown on a lost commit", async () => {
  let depth = 0;
  const empty: ExecuteResult = { rows: [], count: 1, notices: [] };
  const session: BatchSession = {
    canCancel: false,
    inTransaction: () => depth > 0,
    abandon() {
      depth = 0;
    },
    query(text) {
      const command = text.trim().toLowerCase();
      if (command === "begin") {
        depth += 1;
        return Promise.resolve(empty);
      }
      if (command === "commit") {
        return Promise.reject(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
      }
      if (command === "rollback") {
        depth = 0;
        return Promise.resolve(empty);
      }
      return Promise.resolve(empty);
    },
  };
  const pool = {
    capabilities: {
      transactions: "interactive",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
    batch: (statements: readonly Statement[]) => runAtomicBatch(session, statements, undefined),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  } as DriverPool;
  const db = await connectPglite(pool, { schema: app });
  const error = await expectRejection(
    db.users.insert(bulk(Math.floor(WRITE_PARAM_BUDGET / 2) + 1)),
    "OKM1401",
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.kind).toBe("outcome_unknown");
    expect(error.retryable).toBe(false);
  }
  await db.close();
});

async function savepoint(pool: DriverPool): Promise<void> {
  const connection = await pool.reserve?.();
  if (connection === undefined) throw new Error("expected reserve");
  try {
    await connection.execute("begin");
    await connection.execute("insert into users (id, email) values ($1, $2)", [
      SENTINEL,
      "sentinel@b.c",
    ]);
    let failed = false;
    try {
      await runWriteOn(
        connection,
        [
          {
            text: "insert into users (id, email) values ($1, $2)",
            params: [rowId(8_000), "chunk@b.c"],
          },
          {
            text: "insert into users (id, email) values ($1, $2)",
            params: [rowId(8_001), "chunk@b.c"],
          },
        ],
        undefined,
      );
    } catch (error) {
      failed = true;
      expect(error).toMatchObject({ batchIndex: 1, sqlstate: "23505" });
    }
    expect(failed).toBe(true);
    const seen = await connection.execute(
      "select email from users where email in ('sentinel@b.c', 'chunk@b.c') order by email",
    );
    expect(seen.rows.map((row) => row[0])).toEqual(["sentinel@b.c"]);
    await connection.execute("rollback");
  } finally {
    await connection.release();
  }
}

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "postgres.js writes",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of DDL) await sql.unsafe(statement);
      const pool = openPostgres({ url: primaryUrl(), searchPath: schemaName });
      try {
        const db = connectPostgres(pool, { schema: app });
        await writeSuite(db, pool);
        await savepoint(pool);
        await db.close();
      } finally {
        await pool.close();
      }
    });
  },
  20_000,
);
