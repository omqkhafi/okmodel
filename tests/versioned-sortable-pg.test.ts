/**
 * `versioned()` and `sortable()` on Postgres.
 *
 * PGlite always runs. A second connection on the Docker topology runs the same
 * checks, including two writers at once.
 */

import { expect, test } from "bun:test";

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
      await db.connected;
      try {
        await prove(db, other);
        await proveTenancy(scoped);
      } finally {
        await db.close();
        await other.close();
        await scoped.close();
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
