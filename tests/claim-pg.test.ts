/**
 * Atomic `inc` and `update` with `lock: "skip"` on a real database (P93).
 *
 * Two connections: the row one transaction holds is not returned to the other.
 */

import { expect, test } from "bun:test";
import type { Sql } from "postgres";

import { open as openNodePostgres } from "../src/adapters/pg/nodepostgres.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { inc, integer, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { testing, type Testing } from "../src/tooling/testing/index.js";

const A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";
const B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
const TAG = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c03";

const jobs = table("p93Jobs", {
  id: uuid().primaryKey(),
  status: text(),
  qty: integer().nullable(),
});

const tags = table("p93Tags", {
  id: uuid().primaryKey(),
  name: text().unique(),
  n: integer(),
});

const app = schema({ casing: "snake", tables: [jobs, tags] });

type Db = Testing<typeof app>["db"];

/** `returning` is a row list at runtime. The public update type stays `{ count }`. */
function value(result: unknown): unknown {
  return result;
}

async function rejection(pending: Promise<unknown>, code: string): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error(`expected ${code}`);
}

async function seed(db: Db): Promise<void> {
  await db.p93Jobs.insert([
    { id: A, status: "pending", qty: 1 },
    { id: B, status: "pending", qty: null },
  ]);
}

async function run(db: Db): Promise<void> {
  await seed(db);
  await db.p93Jobs.update({ where: { id: A }, set: { qty: inc(2) } });
  expect((await db.p93Jobs.one({ where: { id: A } }))?.qty).toBe(3);
  await db.p93Jobs.update({ where: { id: B }, set: { qty: inc(1) } });
  expect((await db.p93Jobs.one({ where: { id: B } }))?.qty).toBeNull();

  const claimed = await db.p93Jobs.update(
    { where: { status: "pending" }, set: { status: "running" }, limit: 1, lock: "skip" },
    { returning: ["id", "status"] },
  );
  expect(value(claimed)).toEqual([expect.objectContaining({ status: "running" })]);
  expect(await db.p93Jobs.count({ where: { status: "pending" } })).toBe(1);

  const rolled = await db
    .tx(async (tx) => {
      await tx.p93Jobs.update({
        where: { status: "pending" },
        set: { status: "held" },
        limit: 1,
        lock: "skip",
      });
      throw new Error("roll");
    })
    .then(
      () => false,
      () => true,
    );
  expect(rolled).toBe(true);
  expect(await db.p93Jobs.count({ where: { status: "pending" } })).toBe(1);

  const [batched] = await db.batch([db.p93Jobs.update({ where: { id: A }, set: { qty: inc(1) } })]);
  expect(batched).toEqual({ count: 1 });
  expect((await db.p93Jobs.one({ where: { id: A } }))?.qty).toBe(4);

  const created = await db.p93Tags.insert(
    { id: TAG, name: "once", n: 1 },
    { onConflict: { on: "name", return: true } },
  );
  const again = await db.p93Tags.insert(
    { id: A, name: "once", n: 9 },
    { onConflict: { on: "name", return: true } },
  );
  expect(again).toMatchObject({ id: created.id, n: 1 });
  await db.p93Tags.update({ where: { name: "once" }, set: { n: inc(1) } });
  expect((await db.p93Tags.one({ where: { name: "once" } }))?.n).toBe(2);

  const duplicate = await rejection(
    db.p93Jobs.update([
      { id: A, set: { qty: inc(1) } },
      { where: { id: A }, set: { qty: inc(2) } },
    ]),
    "OKM1120",
  );
  expect(duplicate.message).toContain("same target twice");

  const mixed = await rejection(
    db.p93Jobs.update([
      { id: A, set: { qty: inc(1) } },
      { id: B, set: { qty: 5 } },
    ]),
    "OKM1120",
  );
  expect(mixed.message).toBe("qty is both inc and a value in this update.");

  await db.tx(async (tx) => {
    const read = await rejection(tx.p93Jobs.find({ limit: 1, lock: "skip" } as never), "OKM1120");
    expect(read.message).toContain('wait: "skip"');
    const held = await tx.p93Jobs.find({ limit: 5, lock: "update", wait: "skip" });
    expect(held.length).toBeGreaterThan(0);
  });

  const outside = await rejection(
    db.p93Jobs.find({ limit: 1, lock: "update" } as never),
    "OKM1830",
  );
  expect(outside.message).toContain("transaction");
}

async function race(owner: Db, other: Db): Promise<void> {
  await owner.p93Jobs.insert([
    { id: A, status: "pending", qty: 1 },
    { id: B, status: "pending", qty: 1 },
  ]);
  let release = (): void => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const first = owner.tx(async (tx) => {
    const rows = await tx.p93Jobs.update(
      { where: { id: A }, set: { status: "held" }, limit: 1, lock: "skip" },
      { returning: ["id"] },
    );
    ready();
    await hold;
    return rows;
  });
  try {
    await held;
    const missed = await Promise.race([
      other.p93Jobs.update({
        where: { id: A },
        set: { status: "stolen" },
        limit: 1,
        lock: "skip",
      }),
      refuse("the second claim waited on the locked row"),
    ]);
    expect(missed).toEqual({ count: 0 });
    const took = await Promise.race([
      other.p93Jobs.update(
        { where: { status: "pending" }, set: { status: "running" }, limit: 1, lock: "skip" },
        { returning: ["id"] },
      ),
      refuse("the second claim waited on the locked row"),
    ]);
    expect(value(took)).toEqual([{ id: B }]);
  } finally {
    release();
  }
  expect(value(await first)).toEqual([{ id: A }]);
  expect(await other.p93Jobs.one({ where: { id: A } })).toMatchObject({ status: "held" });
  expect(await other.p93Jobs.one({ where: { id: B } })).toMatchObject({ status: "running" });

  let releaseRead = (): void => undefined;
  const holdRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readyRead: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => {
    readyRead = resolve;
  });
  const reader = owner.tx(async (tx) => {
    await tx.p93Jobs.find({ where: { id: B }, limit: 1, lock: "update" });
    readyRead();
    await holdRead;
  });
  try {
    await locked;
    const skipped = await Promise.race([
      other.tx((tx) =>
        tx.p93Jobs.find({ where: { id: B }, limit: 1, lock: "update", wait: "skip" }),
      ),
      refuse("the second read waited on the locked row"),
    ]);
    expect(skipped).toEqual([]);
    const rest = await Promise.race([
      other.tx((tx) => tx.p93Jobs.find({ limit: 10, lock: "update", wait: "skip" })),
      refuse("the second read waited on the locked row"),
    ]);
    expect(rest.map((row) => row.id)).toEqual([A]);
  } finally {
    releaseRead();
  }
  await reader;
}

function refuse(message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), 2_000);
  });
}

async function apply(sql: Sql, schemaName: string): Promise<void> {
  for (const statement of renderCatalog(app.catalog, schemaName)) {
    if (statement.trim().length === 0) continue;
    await sql.unsafe(statement);
  }
}

test("pglite inc, claim, batch, and first-or-create", async () => {
  const harness = await testing(app, { driver: openPglite() });
  try {
    await run(harness.db);
  } finally {
    await harness.close();
  }
});

const gate = await loadPostgresGate();

async function onPostgres(
  open: (schemaName: string) => DriverPool | Promise<DriverPool>,
  sql: Sql,
  schemaName: string,
): Promise<void> {
  await apply(sql, schemaName);
  const harness = await testing(app, { driver: open(schemaName), migrate: false });
  const second = await testing(app, { driver: open(schemaName), migrate: false });
  try {
    await run(harness.db);
    await harness.db.p93Jobs.delete({ where: { id: A } }).all("reset jobs");
    await harness.db.p93Jobs.delete({ where: { id: B } }).all("reset jobs");
    await race(harness.db, second.db);
  } finally {
    await second.close();
    await harness.close();
  }
}

postgresTest(
  gate,
  "postgres.js two connections skip a row the other holds",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await onPostgres(
        (name) => openPostgres({ url: primaryUrl(), searchPath: name, max: 1 }),
        sql,
        schemaName,
      );
    });
  },
  30_000,
);

const parts = table("p93Parts", {
  id: integer(),
  k: integer(),
  status: text(),
});

const heirs = table("p93Heirs", {
  id: integer(),
  status: text(),
});

const partApp = schema({ casing: "snake", tables: [parts, heirs] });

type PartDb = Testing<typeof partApp>["db"];

async function createPartitions(sql: Sql): Promise<void> {
  await sql.unsafe(
    `create table p93_parts (id integer, k integer not null, status text not null) partition by list (k)`,
  );
  await sql.unsafe(`create table p93_parts_1 partition of p93_parts for values in (1)`);
  await sql.unsafe(`create table p93_parts_2 partition of p93_parts for values in (2)`);
  await sql.unsafe(
    `insert into p93_parts (id, k, status) values (1, 1, 'pending'), (2, 2, 'pending'), (3, 2, 'pending')`,
  );
  await sql.unsafe(`create table p93_heirs (id integer, status text not null)`);
  await sql.unsafe(`create table p93_heirs_a () inherits (p93_heirs)`);
  await sql.unsafe(`create table p93_heirs_b () inherits (p93_heirs)`);
  await sql.unsafe(`insert into p93_heirs_a (id, status) values (1, 'pending')`);
  await sql.unsafe(`insert into p93_heirs_b (id, status) values (2, 'pending')`);
}

async function claimPartitions(owner: PartDb, other: PartDb): Promise<void> {
  const claimed = await owner.p93Parts.update(
    { where: { k: 1 }, set: { status: "claimed" }, limit: 1, lock: "skip" },
    { returning: ["id"] },
  );
  expect(value(claimed)).toEqual([{ id: 1 }]);
  expect(await owner.p93Parts.find({ orderBy: { id: "asc" }, limit: 10 })).toEqual([
    { id: 1, k: 1, status: "claimed" },
    { id: 2, k: 2, status: "pending" },
    { id: 3, k: 2, status: "pending" },
  ]);

  const heir = await owner.p93Heirs.update(
    { where: { id: 1 }, set: { status: "claimed" }, limit: 1, lock: "skip" },
    { returning: ["id"] },
  );
  expect(value(heir)).toEqual([{ id: 1 }]);
  expect(await owner.p93Heirs.find({ orderBy: { id: "asc" }, limit: 10 })).toEqual([
    { id: 1, status: "claimed" },
    { id: 2, status: "pending" },
  ]);

  await owner.p93Parts.update({
    where: { id: 1 },
    set: { status: "pending" },
  });
  let release = (): void => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const first = owner.tx(async (tx) => {
    const rows = await tx.p93Parts.update(
      { where: { k: 1 }, set: { status: "held" }, limit: 1, lock: "skip" },
      { returning: ["id"] },
    );
    ready();
    await hold;
    return rows;
  });
  try {
    await held;
    const missed = await Promise.race([
      other.p93Parts.update({
        where: { k: 1 },
        set: { status: "stolen" },
        limit: 1,
        lock: "skip",
      }),
      refuse("the second claim waited on the locked partition row"),
    ]);
    expect(missed).toEqual({ count: 0 });
  } finally {
    release();
  }
  expect(value(await first)).toEqual([{ id: 1 }]);
  expect(await other.p93Parts.find({ orderBy: { id: "asc" }, limit: 10 })).toEqual([
    { id: 1, k: 1, status: "held" },
    { id: 2, k: 2, status: "pending" },
    { id: 3, k: 2, status: "pending" },
  ]);
  const took = await other.p93Parts.update(
    { where: { status: "pending" }, set: { status: "running" }, limit: 1, lock: "skip" },
    { returning: ["id", "k"] },
  );
  expect(value(took)).toEqual([expect.objectContaining({ k: 2 })]);
  expect(await other.p93Parts.count({ where: { status: "pending" } })).toBe(1);
  expect(await other.p93Parts.count({ where: { k: 1, status: "held" } })).toBe(1);
}

postgresTest(
  gate,
  "a partitioned claim changes only the selected partition",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await createPartitions(sql);
      const open = (): ReturnType<typeof openPostgres> =>
        openPostgres({ url: primaryUrl(), searchPath: schemaName, max: 1 });
      const harness = await testing(partApp, { driver: open(), migrate: false });
      const second = await testing(partApp, { driver: open(), migrate: false });
      try {
        await claimPartitions(harness.db, second.db);
      } finally {
        await second.close();
        await harness.close();
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "node-postgres two connections skip a row the other holds",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await onPostgres(
        (name) => openNodePostgres({ url: primaryUrl(), searchPath: name, max: 1 }),
        sql,
        schemaName,
      );
    });
  },
  30_000,
);
