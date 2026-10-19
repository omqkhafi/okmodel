/**
 * `versioned()` and `sortable()` on Postgres.
 *
 * PGlite always runs. A second connection on the Docker topology runs the same
 * checks, including two writers at once.
 */

import { expect, test } from "bun:test";
import postgres from "postgres";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { inc, schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { sortable, versioned } from "../src/runtime/traits/index.js";
import type { Connected } from "../src/runtime/types.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

const tasks = table(
  "tasks",
  {
    id: t.text().primaryKey(),
    title: t.text(),
    laneId: t.text(),
    count: t.integer().default(0),
  },
  { traits: [versioned(), sortable("laneId")] },
);

const items = table(
  "items",
  {
    id: t.text().primaryKey(),
    title: t.text(),
    laneId: t.text(),
  },
  { traits: [versioned(), sortable("laneId")] },
);

const app = schema({ casing: "snake", tables: [tasks] });
const tenantApp = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [items],
});

type Db = Connected<typeof app>;
type TenantDb = Connected<typeof tenantApp>;

test("version checks, moves, and tenancy on pglite", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    for (const statement of renderCatalog(tenantApp.catalog, "public"))
      await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    const other = await connectPglite(pool, { schema: app });
    const scoped = await connectPglite(pool, { schema: tenantApp });
    await db.connected;
    try {
      await prove(db, other);
      await proveTenancy(scoped);
      await proveCrowd(db);
    } finally {
      await db.close();
      await other.close();
      await scoped.close();
    }
  } finally {
    await pool.close();
  }
}, 60_000);

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "version checks and moves on two postgres connections",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      for (const statement of renderCatalog(tenantApp.catalog, schemaName))
        await sql.unsafe(statement);
      const db = connectPostgres(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      const other = connectPostgres(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      const scoped = connectPostgres(primaryUrl(), {
        schema: tenantApp,
        searchPath: schemaName,
        max: 1,
      });
      const wide = connectPostgres(primaryUrl(), {
        schema: app,
        searchPath: schemaName,
        max: 8,
      });
      const contender = connectPostgres(primaryUrl(), {
        schema: app,
        searchPath: schemaName,
        max: 1,
      });
      await Promise.all([db.connected, wide.connected, contender.connected]);
      try {
        await prove(db, other);
        await proveTenancy(scoped);
        await proveCrowd(wide);
        await proveWaiter(wide, contender, sql);
        await proveAnyRace(wide);
        await proveReadCommittedRecheck(schemaName);
      } finally {
        await db.close();
        await other.close();
        await scoped.close();
        await wide.close();
        await contender.close();
      }
    });
  },
  60_000,
);

async function prove(db: Db, other: Db): Promise<void> {
  const inserted = await db.tasks.insert({ id: "a", title: "a", laneId: "x" });
  expect(inserted.version).toBe(1);
  expect(inserted.position).toBe(1);
  await db.tasks.insert([
    { id: "b", title: "b", laneId: "x" },
    { id: "c", title: "c", laneId: "x" },
    { id: "d", title: "d", laneId: "y" },
  ]);

  const stale = await conflict(() =>
    db.tasks.update({ where: { id: "a" }, set: { title: "stale" }, version: 4 }),
  );
  expect(stale.category).toBe("conflict");
  expect(stale.message).toContain("tried to write title");
  expect(stale.message).toContain("version 4");
  expect(stale.message).toContain("Reread the row and retry");
  expect(await title(db, "a")).toBe("a");

  const missed = await db.tasks.update({
    where: { id: "missing" },
    set: { title: "nope" },
    version: 1,
  });
  expect(missed).toEqual({ count: 0 });

  const wrote = await db.tasks.update(
    { where: { id: "a" }, set: { title: "a2" }, version: 1 },
    { returning: ["id", "title", "version"] },
  );
  expect(rows(wrote)).toEqual([{ id: "a", title: "a2", version: 2 }]);

  const bumped = await db.tasks.update(
    { where: { id: "a" }, set: { count: inc(2) }, version: 2 },
    { returning: ["count", "version"] },
  );
  expect(rows(bumped)).toEqual([{ count: 2, version: 3 }]);

  const kept = await db.tasks.insert(
    { id: "a", title: "other", laneId: "x" },
    { onConflict: { on: "id", return: true } },
  );
  expect(kept.title).toBe("a2");
  expect(kept.version).toBe(3);

  const claimed = await db.tasks.update({
    where: { laneId: "y" },
    set: { title: "claimed" },
    version: 1,
    lock: "skip",
    limit: 1,
  });
  expect(claimed).toEqual({ count: 1 });
  const claimStale = await conflict(() =>
    db.tasks.update({
      where: { id: "d" },
      set: { title: "again" },
      version: 1,
      lock: "skip",
      limit: 1,
    }),
  );
  expect(claimStale.category).toBe("conflict");

  const both = await conflict(() =>
    db.tasks.update([
      { id: "b", set: { title: "b2" }, version: 1 },
      { id: "c", set: { title: "c2" }, version: 9 },
    ]),
  );
  expect(both.category).toBe("conflict");
  expect(await title(db, "b")).toBe("b");

  await db.tasks.update([
    { id: "b", set: { title: "b2" }, version: 1 },
    { id: "c", set: { title: "c2" }, version: 1 },
  ]);
  expect(await title(db, "b")).toBe("b2");
  expect((await one(db, "c")).version).toBe(2);

  const [first, second] = await Promise.allSettled([
    db.tasks.update({ where: { id: "b" }, set: { title: "left" }, version: 2 }),
    other.tasks.update({ where: { id: "b" }, set: { title: "right" }, version: 2 }),
  ]);
  const won = [first, second].filter((item) => item.status === "fulfilled");
  const lost = [first, second].filter((item) => item.status === "rejected");
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  const reason = lost[0]?.status === "rejected" ? lost[0].reason : undefined;
  expect(reason).toBeInstanceOf(OkmError);
  expect((reason as OkmError).category).toBe("conflict");
  const current = await one(db, "b");
  expect(current.version).toBe(3);
  await db.tasks.update({
    where: { id: "b" },
    set: { title: "retried" },
    version: current.version,
  });
  expect(await title(db, "b")).toBe("retried");
  expect((await one(db, "b")).version).toBe(4);

  expect(await db.tasks.move("c", { before: "a" })).toEqual({ position: 1 });
  expect(await order(db, "x")).toEqual(["c", "a", "b"]);
  expect(await db.tasks.move("a", { after: "b" })).toEqual({ position: 3 });
  expect(await order(db, "x")).toEqual(["c", "b", "a"]);
  expect(await db.tasks.move("c", { before: "c" })).toEqual({ position: 1 });
  const beforeBoundary = await order(db, "x");
  const otherGroup = await conflict(() => db.tasks.move("a", { before: "d" }));
  expect(otherGroup.code).toBe("OKM1120");
  expect(otherGroup.message).toContain("laneId");
  expect(await order(db, "x")).toEqual(beforeBoundary);
  const missing = await conflict(() => db.tasks.move("a", { after: "missing" }));
  expect(missing.code).toBe("not_found");
  expect(await order(db, "x")).toEqual(beforeBoundary);

  const [movedLeft, movedRight] = await Promise.allSettled([
    other.tasks.move("c", { after: "a" }),
    db.tasks.move("b", { before: "c" }),
  ]);
  expect(movedLeft.status).toBe("fulfilled");
  expect(movedRight.status).toBe("fulfilled");
  const positions = (await db.tasks.find({ where: { laneId: "x" }, limit: 10 })).map(
    (row) => row.position,
  );
  expect(new Set(positions).size).toBe(3);
  expect([...positions].sort((left, right) => left - right)).toEqual([1, 2, 3]);

  const ranked = await db.tasks.find({ where: { laneId: "x" }, limit: 10 });
  expect(ranked.map((row) => row.position)).toEqual([1, 2, 3]);
  const byTitle = await db.tasks.find({
    where: { laneId: "x" },
    orderBy: { title: "asc" },
    limit: 10,
  });
  expect(byTitle.map((row) => row.title)).toEqual(["a2", "c2", "retried"]);

  const added = await db.tasks.insert({ id: "e", title: "e", laneId: "x" });
  expect(added.position).toBe(4);

  expect(await db.tasks.delete({ where: { id: "e" } })).toEqual({ count: 1 });
  await proveAny(db);
}

async function proveAny(db: Db): Promise<void> {
  await db.tasks.insert(
    Array.from({ length: 6 }, (_, index) => ({
      id: `cap${String(index)}`,
      title: "pending",
      laneId: "cap",
    })),
  );
  const first = await db.tasks.update({
    where: { laneId: "cap", title: "pending" },
    set: { title: "running" },
    limit: 2,
    lock: "skip",
    version: "any",
  });
  const taken = rows(first);
  expect(taken).toHaveLength(2);
  expect(new Set(taken.map((row) => row.id)).size).toBe(2);
  for (const row of taken) expect(row.version).toBe(2);
  const second = rows(
    await db.tasks.update({
      where: { laneId: "cap", title: "pending" },
      set: { title: "running" },
      limit: 2,
      lock: "skip",
      version: "any",
    }),
  );
  expect(second).toHaveLength(2);
  expect(second.every((row) => row.version === 2)).toBe(true);
  const ids = [...taken, ...second].map((row) => {
    const id = row.id;
    if (typeof id !== "string") throw new Error("expected a claimed id");
    return id;
  });
  expect(new Set(ids).size).toBe(4);

  const sample = ids[0];
  if (sample === undefined) throw new Error("expected a claimed id");
  const stale = await conflict(() =>
    db.tasks.update({ where: { id: sample }, set: { title: "done" }, version: 1 }),
  );
  expect(stale.category).toBe("conflict");
  await db.tasks.update({ where: { id: sample }, set: { title: "done" }, version: 2 });
  expect((await one(db, sample)).version).toBe(3);

  await db.tasks.insert({ id: "re", title: "pending", laneId: "re" });
  await db.tasks.update({ where: { id: "re" }, set: { title: "cancelled" }, version: 1 });
  const dropped = await db.tasks.update({
    where: { laneId: "re", title: "pending" },
    set: { title: "running" },
    limit: 1,
    lock: "skip",
    version: "any",
  });
  expect(dropped).toEqual([]);
  const left = await one(db, "re");
  expect(left.title).toBe("cancelled");
  expect(left.version).toBe(2);

  const empty = await db.tasks.update({
    where: { laneId: "cap", title: "absent" },
    set: { title: "running" },
    limit: 1,
    lock: "skip",
    version: "any",
  });
  expect(empty).toEqual([]);
}

async function proveAnyRace(db: Db): Promise<void> {
  const count = 8;
  await db.tasks.insert(
    Array.from({ length: count }, (_, index) => ({
      id: `race${String(index)}`,
      title: "pending",
      laneId: "race",
    })),
  );
  const claimed = await Promise.all(
    Array.from({ length: count }, () =>
      db.tasks.update({
        where: { laneId: "race", title: "pending" },
        set: { title: "running" },
        limit: 1,
        lock: "skip",
        version: "any",
      }),
    ),
  );
  const flat = claimed.flatMap((item) => rows(item));
  expect(flat.length).toBeLessThanOrEqual(count);
  expect(flat.length).toBe(count);
  expect(new Set(flat.map((row) => row.id)).size).toBe(flat.length);
  expect(claimed.every((item) => rows(item).length <= 1)).toBe(true);
  for (const row of flat) expect(row.version).toBe(2);
  const again = await db.tasks.update({
    where: { laneId: "race", title: "pending" },
    set: { title: "running" },
    limit: 1,
    lock: "skip",
    version: "any",
  });
  expect(again).toEqual([]);
}

/**
 * Under READ COMMITTED the outer predicate drops a row whose status changed
 * while the claim waited for the lock. `version: "any"` adds `SKIP LOCKED`,
 * so this statement waits on purpose: the same CTE and the repeated predicate
 * are what the planner emits.
 */
async function proveReadCommittedRecheck(schemaName: string): Promise<void> {
  const raw = postgres(primaryUrl(), {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  const holder = await raw.reserve();
  const claimer = await raw.reserve();
  try {
    await holder.unsafe(`set search_path to ${schemaName}`);
    await claimer.unsafe(`set search_path to ${schemaName}`);
    await holder.unsafe(
      `insert into tasks (id, title, lane_id, position) values ('epq', 'pending', 'epq', 1)`,
    );
    await holder.unsafe(`begin isolation level read committed`);
    await holder.unsafe(
      `update tasks set title = 'cancelled', version = version + 1 where id = 'epq'`,
    );
    const claim = claimer.unsafe(
      `with claimed as (select s.id as okm_0 from tasks as s where s.title = 'pending' and s.lane_id = 'epq' order by s.id limit 1 for update of s) update tasks as t set title = 'running', version = t.version + 1 from claimed where t.id = claimed.okm_0 and t.title = 'pending' and t.lane_id = 'epq' returning t.id, t.version`,
    );
    const waiting = await Promise.race([
      claim.then(() => "done" as const),
      Bun.sleep(1500).then(() => "wait" as const),
    ]);
    expect(waiting).toBe("wait");
    await holder.unsafe(`commit`);
    const rows = await claim;
    expect(rows).toHaveLength(0);
    const after = await claimer.unsafe(`select title, version from tasks where id = 'epq'`);
    expect(after[0]?.title).toBe("cancelled");
    expect(Number(after[0]?.version)).toBe(2);
  } finally {
    await holder.unsafe(`rollback`).catch(() => undefined);
    await claimer.unsafe(`rollback`).catch(() => undefined);
    holder.release();
    claimer.release();
    await raw.end({ timeout: 5 });
  }
}

async function proveTenancy(db: TenantDb): Promise<void> {
  const left = db.for({ tenantId: TENANT_A });
  const right = db.for({ tenantId: TENANT_B });
  await left.items.insert({ id: "1", title: "left", laneId: "x" });
  await right.items.insert({ id: "1", title: "right", laneId: "x" });
  const stale = await conflict(() =>
    left.items.update({ where: { id: "1" }, set: { title: "no" }, version: 9 }),
  );
  expect(stale.category).toBe("conflict");
  expect(await right.items.find({ where: { id: "1" }, limit: 1 })).toEqual([
    expect.objectContaining({ title: "right", version: 1, position: 1 }),
  ]);
  expect(
    await left.items.update({ where: { id: "absent" }, set: { title: "no" }, version: 1 }),
  ).toEqual({ count: 0 });
  await left.items.update({ where: { id: "1" }, set: { title: "yes" }, version: 1 });
  expect(await right.items.find({ where: { id: "1" }, limit: 1 })).toEqual([
    expect.objectContaining({ title: "right", version: 1 }),
  ]);
  expect(await left.items.move("1", { after: "1" })).toEqual({ position: 1 });
}

async function proveCrowd(db: Db): Promise<void> {
  const count = 8;
  const inserted = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      db.tasks.insert({
        id: `c${String(index)}`,
        title: `c${String(index)}`,
        laneId: "crowd",
      }),
    ),
  );
  expect(inserted.map((row) => row.position).sort((left, right) => left - right)).toEqual(
    Array.from({ length: count }, (_, index) => index + 1),
  );

  const batch = await db.tasks.insert([
    { id: "s1", title: "s1", laneId: "seq" },
    { id: "s2", title: "s2", laneId: "seq" },
    { id: "s3", title: "s3", laneId: "seq" },
  ]);
  expect(batch.map((row) => row.position)).toEqual([1, 2, 3]);

  await Promise.all([
    db.tasks.insert([
      { id: "g1a", title: "g1a", laneId: "ga" },
      { id: "g2a", title: "g2a", laneId: "gb" },
    ]),
    db.tasks.insert([
      { id: "g2b", title: "g2b", laneId: "gb" },
      { id: "g1b", title: "g1b", laneId: "ga" },
    ]),
  ]);
  expect(await positions(db, "ga")).toEqual([1, 2]);
  expect(await positions(db, "gb")).toEqual([1, 2]);

  await db.tasks.insert([
    { id: "m0", title: "m0", laneId: "mix" },
    { id: "m1", title: "m1", laneId: "mix" },
  ]);
  await Promise.all([
    db.tasks.insert({ id: "m2", title: "m2", laneId: "mix" }),
    db.tasks.insert({ id: "m3", title: "m3", laneId: "mix" }),
    db.tasks.move("m0", { after: "m1" }),
    db.tasks.insert({ id: "m4", title: "m4", laneId: "mix" }),
  ]);
  expect(await positions(db, "mix")).toEqual([1, 2, 3, 4, 5]);
}

async function proveWaiter(holder: Db, other: Db, sql: LockPoll): Promise<void> {
  await whileHolding(
    holder,
    sql,
    async (tx) => {
      await tx.tasks.insert({ id: "hold", title: "hold", laneId: "held" });
    },
    () => other.tasks.insert({ id: "wait", title: "wait", laneId: "held" }),
  );
  expect((await one(holder, "wait")).position).toBe(2);

  await holder.tasks.insert([
    { id: "hm0", title: "hm0", laneId: "hm" },
    { id: "hm1", title: "hm1", laneId: "hm" },
  ]);
  await whileHolding(
    holder,
    sql,
    async (tx) => {
      await tx.tasks.move("hm0", { after: "hm1" });
    },
    () => other.tasks.insert({ id: "hm2", title: "hm2", laneId: "hm" }),
  );
  expect(await positions(holder, "hm")).toEqual([1, 2, 3]);

  await holder.tasks.insert([
    { id: "km0", title: "km0", laneId: "km" },
    { id: "km1", title: "km1", laneId: "km" },
  ]);
  await whileHolding(
    holder,
    sql,
    async (tx) => {
      await tx.tasks.insert({ id: "km2", title: "km2", laneId: "km" });
    },
    () => other.tasks.move("km0", { after: "km1" }),
  );
  expect(await positions(holder, "km")).toEqual([1, 2, 3]);
}

type LockPoll = {
  unsafe(text: string): Promise<readonly { readonly n: number | string }[]>;
};

type TxTasks = { readonly tasks: Db["tasks"] };

async function whileHolding(
  db: Db,
  sql: LockPoll,
  hold: (tx: TxTasks) => Promise<void>,
  during: () => Promise<unknown>,
): Promise<void> {
  const ready = defer();
  const gate = defer();
  const holding = db.tx(async (tx) => {
    await hold(tx);
    ready.resolve();
    await gate.promise;
  });
  await ready.promise;
  const pending = Promise.resolve(during());
  let waiter: unknown;
  try {
    await waitForAdvisoryWaiter(sql);
  } catch (error) {
    waiter = error;
  } finally {
    gate.resolve();
  }
  await holding;
  await pending;
  if (waiter !== undefined) throw waiter;
}

async function waitForAdvisoryWaiter(sql: LockPoll): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = await sql.unsafe(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
    );
    if (Number(found[0]?.n) > 0) return;
    if (Date.now() > deadline) {
      throw new Error("no session was waiting on the sortable advisory lock");
    }
    await Bun.sleep(15);
  }
}

function defer(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function positions(db: Db, laneId: string): Promise<number[]> {
  const rows = await db.tasks.find({ where: { laneId }, limit: 20 });
  return rows.map((row) => row.position).sort((left, right) => left - right);
}

async function title(db: Db, id: string): Promise<unknown> {
  return (await one(db, id)).title;
}

async function one(
  db: Db,
  id: string,
): Promise<{ title: string; version: number; position: number }> {
  const rows = await db.tasks.find({ where: { id }, limit: 1 });
  const row = rows[0];
  if (row === undefined) throw new Error(`missing ${id}`);
  return row;
}

async function order(db: Db, laneId: string): Promise<string[]> {
  const rows = await db.tasks.find({ where: { laneId }, limit: 10 });
  return rows.map((row) => row.id);
}

function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("expected rows");
  return value as Record<string, unknown>[];
}

async function conflict(run: () => Promise<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
