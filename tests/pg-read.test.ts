/**
 * Read path on PGlite and, when the topology is up, on postgres.js.
 *
 * One statement per read. Values stay parameters. Includes are LATERAL.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import {
  between,
  boolean,
  contains,
  eq,
  every,
  gt,
  has,
  id,
  inList,
  integer,
  many,
  none,
  not,
  one,
  or,
  schema,
  startsWith,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TASK_A = "33333333-3333-4333-8333-333333333333";
const TASK_B = "44444444-4444-4444-8444-444444444444";
const TASK_C = "55555555-5555-4555-8555-555555555555";

const users = table(
  "users",
  {
    id: id(),
    email: text(),
    name: text().nullable(),
    active: boolean(),
  },
  { relations: { tasks: many("tasks") } },
);

const tasks = table(
  "tasks",
  {
    id: id(),
    ownerId: uuid().references("users"),
    title: text(),
    position: integer(),
  },
  { relations: { owner: one("users") } },
);

const app = schema({
  casing: "snake",
  tables: [users, tasks],
});

const DDL = [
  `create table users (
    id uuid primary key,
    email text not null,
    name text,
    active boolean not null
  )`,
  `create table tasks (
    id uuid primary key,
    owner_id uuid not null references users (id),
    title text not null,
    position integer not null
  )`,
  `insert into users (id, email, name, active) values
    ('${USER_A}', 'a@b.c', 'Ada', true),
    ('${USER_B}', 'b@b.c', null, false)`,
  `insert into tasks (id, owner_id, title, position) values
    ('${TASK_A}', '${USER_A}', 'ship', 1),
    ('${TASK_B}', '${USER_A}', 'shop', 2),
    ('${TASK_C}', '${USER_B}', 'other', 3)`,
];

type Client = Awaited<ReturnType<typeof connectPglite<typeof app>>>;

async function expectRejection(pending: Promise<unknown>, code: string): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

async function seed(pool: DriverPool): Promise<void> {
  for (const statement of DDL) await pool.execute(statement);
}

function counting(pool: DriverPool): DriverPool & { readonly taken: () => number } {
  let count = 0;
  const execute: DriverPool["execute"] = (text, params, options) => {
    count += 1;
    return pool.execute(text, params, options);
  };
  return { ...pool, execute, taken };
  function taken(): number {
    const value = count;
    count = 0;
    return value;
  }
}

async function readSuite(db: Client, taken: () => number): Promise<void> {
  await db.connected;
  taken();

  const ada = await db.users.find({ where: { email: eq("a@b.c") }, limit: 1 });
  expect(ada).toEqual([{ id: USER_A, email: "a@b.c", name: "Ada", active: true }]);
  expect(taken()).toBe(1);

  const missing = await db.users.find({ where: { name: null }, limit: 5 });
  expect(missing).toEqual([{ id: USER_B, email: "b@b.c", name: null, active: false }]);

  const ranked = await db.tasks.find({
    where: { position: gt(1) },
    orderBy: { position: "asc" },
    limit: 5,
  });
  expect(ranked.map((row) => row.position)).toEqual([2, 3]);

  expect(await db.tasks.count({ where: { ownerId: USER_A } })).toBe(2);
  expect(await db.tasks.exists({ where: { title: "missing" } })).toBe(false);
  expect(await db.tasks.exists({ where: { title: eq("ship") } })).toBe(true);

  const ranged = await db.tasks.find({
    where: { position: between(2, 3), title: startsWith("o") },
    orderBy: { position: "asc" },
    limit: 5,
  });
  expect(ranged.map((row) => row.title)).toEqual(["other"]);

  const listed = await db.tasks.find({
    where: { title: inList(["ship", "other"]) },
    orderBy: { title: "asc" },
    limit: 5,
  });
  expect(listed.map((row) => row.title)).toEqual(["other", "ship"]);

  const either = await db.users.find({
    where: or([{ email: eq("a@b.c") }, { active: false }]),
    orderBy: { email: "asc" },
    limit: 5,
  });
  expect(either.map((row) => row.email)).toEqual(["a@b.c", "b@b.c"]);

  const hidden = await db.tasks.find({
    where: { title: not(contains("hip")) },
    orderBy: { position: "asc" },
    limit: 5,
  });
  expect(hidden.map((row) => row.title)).toEqual(["shop", "other"]);

  taken();
  const withOwner = await db.tasks.find({
    where: { title: eq("ship") },
    limit: 1,
    include: { owner: true },
  });
  expect(withOwner[0]?.owner).toEqual({
    id: USER_A,
    email: "a@b.c",
    name: "Ada",
    active: true,
  });
  expect(taken()).toBe(1);

  const withTasks = await db.users.find({
    where: { email: eq("a@b.c") },
    limit: 1,
    include: { tasks: { limit: 5, orderBy: { position: "desc" } } },
  });
  expect(withTasks[0]?.tasks.map((row) => row.title)).toEqual(["shop", "ship"]);

  expect(
    (await db.users.find({ where: { tasks: has({ title: "ship" }) }, limit: 5 })).map(
      (row) => row.id,
    ),
  ).toEqual([USER_A]);
  expect(
    (
      await db.users.find({
        where: { tasks: none({ title: "ship" }) },
        orderBy: { email: "asc" },
        limit: 5,
      })
    ).map((row) => row.id),
  ).toEqual([USER_B]);
  expect(
    (
      await db.users.find({
        where: { tasks: every({ position: gt(0) }) },
        orderBy: { email: "asc" },
        limit: 5,
      })
    ).map((row) => row.id),
  ).toEqual([USER_A, USER_B]);

  const first = await db.tasks.one({
    where: { ownerId: USER_A },
    orderBy: { position: "asc" },
  });
  expect(first?.title).toBe("ship");
  await expectRejection(db.tasks.one({ where: { ownerId: USER_A } }), "not_unique");
  await expectRejection(db.tasks.one({ where: { title: "missing" } }).required(), "not_found");

  const described = db.tasks.find({ where: { title: eq("ship") }, limit: 1 });
  const inspected = described.inspect();
  expect(inspected).not.toBeInstanceOf(Promise);
  if (inspected instanceof Promise) return;
  expect(inspected.plan.statements).toBe(1);
  expect(inspected.routing).toEqual({
    endpoint: "primary",
    role: "primary",
    reason: "single-endpoint",
  });
  expect(inspected.sql.text.includes(";")).toBe(false);
  expect(inspected.sql.params).toEqual(["ship", "1"]);
  expect(inspected.sql.text.includes("ship")).toBe(false);
  const again = db.tasks.find({ where: { title: eq("shop") }, limit: 1 }).inspect();
  if (again instanceof Promise) return;
  expect(again.plan.fingerprint).toBe(inspected.plan.fingerprint);
  expect(again.sql.text).toBe(inspected.sql.text);
  expect(again.sql.params).toEqual(["shop", "1"]);

  const text = described.sql();
  expect(text).not.toBeInstanceOf(Promise);
  if (!(text instanceof Promise)) expect(text.params).toEqual(["ship", "1"]);

  const safe = await described.safe();
  expect(safe.ok).toBe(true);
  if (safe.ok) expect(safe.value[0]?.title).toBe("ship");

  const failed = await db.tasks.find({ where: { missing: true } as never, limit: 1 }).safe();
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.error.code).toBe("OKM1120");

  await expectRejection(
    db.users.find({ where: { email: eq("a@b.c") } }) as unknown as Promise<unknown>,
    "OKM1101",
  );
  await expectRejection(
    db.users.find({ where: { email: { equals: "a" } }, limit: 1 } as never) as Promise<unknown>,
    "OKM1121",
  );
  await expectRejection(
    db.users.find({
      where: { email: eq("a@b.c") },
      limit: 1,
      include: { tasks: true },
    } as never) as Promise<unknown>,
    "OKM1105",
  );
}

test("pglite reads", async () => {
  const pool = counting(await openPglite());
  try {
    await seed(pool);
    const db = await connectPglite(pool, { schema: app });
    await readSuite(db, pool.taken);
    const iterator = db.users.find({ limit: 1 }).stream()[Symbol.asyncIterator]();
    await expectRejection(iterator.next(), "OKM1111");
    await db.close();
  } finally {
    await pool.close();
  }
});

test("values stay parameters", async () => {
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
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  } as DriverPool;
  const db = await connectPglite(pool, { schema: app });
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 24 }), (value) => {
      const marker = `z${value.replaceAll("'", "")}q`;
      const described = db.tasks.find({ where: { title: eq(marker) }, limit: 1 }).sql();
      if (described instanceof Promise)
        throw new Error("a read without include plans synchronously");
      expect(described.params).toEqual([marker, "1"]);
      expect(described.text.includes(marker)).toBe(false);
      expect(described.text.includes(";")).toBe(false);
    }),
    { numRuns: 20 },
  );
  await db.close();
});

test("requireMeta makes a missing okm_meta OKM1520 and toHttp uses connect statuses", async () => {
  const pool = {
    capabilities: {
      transactions: "interactive",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    execute: () =>
      Promise.resolve({ rows: [["170000", "PostgreSQL 17", null]], count: 1, notices: [] }),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  } as DriverPool;
  const adopted = await connectPglite(pool, { schema: app });
  await adopted.connected;
  await adopted.close();
  const strict = await connectPglite(pool, {
    schema: app,
    requireMeta: true,
    errors: { http: { internal: 599, input: 418 } },
  });
  try {
    await strict.connected;
    throw new Error("missing okm_meta should fail");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (!(error instanceof OkmError)) return;
    expect(error.code).toBe("OKM1520");
    expect(error.toHttp().status).toBe(599);
    expect(error.toHttp({ internal: 400 }).status).toBe(400);
  }
  let thrown: unknown;
  try {
    const lookup = (name: string): unknown => strict.table(name as "tasks");
    lookup("missing");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OkmError);
  if (thrown instanceof OkmError) {
    expect(thrown.code).toBe("OKM1120");
    expect(thrown.toHttp().status).toBe(418);
  }
  await strict.close();
});

const gate = await loadPostgresGate();

postgresTest(gate, "postgres.js reads", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of DDL) await sql.unsafe(statement);
    const pool = counting(openPostgres({ url: primaryUrl(), searchPath: schemaName }));
    try {
      const db = connectPostgres(pool, { schema: app });
      await readSuite(db, pool.taken);
      await db.close();
    } finally {
      await pool.close();
    }
  });
});
