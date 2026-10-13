/**
 * First-or-create and the per-row update list on a real driver (P92, D246).
 *
 * The lookup after a conflict is a second statement. Two callers share one
 * row: the second waits on the first transaction, then reads the committed row.
 */

import { expect, test } from "bun:test";
import type { Sql } from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { integer, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { open as openNodePostgres } from "../src/adapters/pg/nodepostgres.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";
import { WRITE_PARAM_BUDGET } from "../src/runtime/write.js";
import { testing, type Testing } from "../src/tooling/testing/index.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

const tags = table(
  "p92Tags",
  {
    id: uuid().primaryKey(),
    name: text().unique(),
    note: text().nullable(),
    role: text().guarded().default("member"),
  },
  { tenancy: global("shared tags") },
);

const tasks = table(
  "p92Tasks",
  {
    id: uuid().primaryKey(),
    title: text(),
    position: integer(),
  },
  { tenancy: global("shared tasks") },
);

const items = table("p92Items", {
  id: uuid().primaryKey(),
  title: text().unique(),
  code: text(),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tags, tasks, items],
});

type Harness = Testing<typeof app>;

function rowId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function expectCode(pending: Promise<unknown>, code: string): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function waitForLock(sql: Sql): Promise<void> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from pg_stat_activity
      where pid <> pg_backend_pid()
        and wait_event_type = 'Lock'
        and query like '%"p92_tags"%'
    `;
    if (Number(rows[0]?.n ?? 0) > 0) return;
    if (Date.now() >= deadline) throw new Error("the second insert did not wait on the lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function run(harness: Harness, sql?: Sql): Promise<void> {
  const db = harness.db;
  const created = await db.p92Tags.insert(
    { id: rowId(1), name: "fresh", note: "new" },
    { onConflict: { on: "name", return: true } },
  );
  expect(created).toMatchObject({ id: rowId(1), name: "fresh", note: "new", role: "member" });
  await harness.expectQueries(1, () =>
    db.p92Tags.insert(
      { id: rowId(2), name: "once", note: "n" },
      { onConflict: { on: "name", return: true } },
    ),
  );

  const kept = await db.p92Tags.insert(
    { id: rowId(3), name: "fresh", note: "other" },
    { onConflict: { on: "name", return: true } },
  );
  expect(kept).toMatchObject({ id: rowId(1), name: "fresh", note: "new" });
  await harness.expectQueries(2, () =>
    db.p92Tags.insert(
      { id: rowId(4), name: "fresh", note: "again" },
      { onConflict: { on: "name", return: true } },
    ),
  );
  const described = await db.p92Tags
    .insert(
      { id: rowId(5), name: "fresh", note: "sql" },
      { onConflict: { on: "name", return: true } },
    )
    .sql();
  expect(described.statements).toHaveLength(1);
  expect(described.statements[0]?.text).toContain('on conflict ("name") do nothing');
  expect(described.statements[0]?.text.includes("union all")).toBe(false);

  await db.p92Tags.insert({ id: rowId(6), name: "mid", note: "old" });
  const ordered = await db.p92Tags.insert(
    [
      { id: rowId(7), name: "left", note: "L" },
      { id: rowId(8), name: "mid", note: "nope" },
      { id: rowId(9), name: "right", note: "R" },
    ],
    { onConflict: { on: "name", return: true } },
  );
  expect(ordered.map((row) => row.name)).toEqual(["left", "mid", "right"]);
  expect(ordered.map((row) => row.note)).toEqual(["L", "old", "R"]);
  expect(ordered[1]?.id).toBe(rowId(6));

  const a = db.for({ tenantId: TENANT_A });
  const b = db.for({ tenantId: TENANT_B });
  await a.p92Items.insert({ id: rowId(10), title: "shared", code: "a" });
  await b.p92Items.insert({ id: rowId(10), title: "shared", code: "b" });
  await b.p92Items.insert({ id: rowId(11), title: "only-b", code: "b2" });
  const tenantSql = await a.p92Items
    .insert(
      { id: rowId(12), title: "shared", code: "nope" },
      { onConflict: { on: "title", return: true } },
    )
    .sql();
  expect(tenantSql.statements[0]?.text).toContain('on conflict ("tenant_id", "title") do nothing');
  const tenantRow = await a.p92Items.insert(
    { id: rowId(12), title: "shared", code: "nope" },
    { onConflict: { on: "title", return: true } },
  );
  expect(tenantRow).toMatchObject({
    id: rowId(10),
    title: "shared",
    code: "a",
    tenantId: TENANT_A,
  });
  expect((await b.p92Items.one({ where: { id: rowId(10) } }))?.code).toBe("b");
  const tenantNew = await a.p92Items.insert(
    { id: rowId(13), title: "fresh-a", code: "new" },
    { onConflict: { on: "title", return: true } },
  );
  expect(tenantNew).toMatchObject({ id: rowId(13), code: "new", tenantId: TENANT_A });

  await db.p92Tasks.insert([
    { id: rowId(20), title: "a", position: 1 },
    { id: rowId(21), title: "b", position: 2 },
  ]);
  expect(
    await db.p92Tasks.update([
      { id: rowId(20), set: { position: 9, title: "a2" } },
      { where: { id: rowId(21) }, set: { position: 4 } },
    ]),
  ).toEqual({ count: 2 });
  const positions = await db.p92Tasks.find({ orderBy: { position: "asc" }, limit: 5 });
  expect(positions.map((row) => [row.title, row.position])).toEqual([
    ["b", 4],
    ["a2", 9],
  ]);
  await harness.expectQueries(1, () =>
    db.p92Tasks.update([
      { id: rowId(20), set: { position: 3 } },
      { id: rowId(21), set: { position: 8 } },
    ]),
  );

  expect(
    await a.p92Items.update([
      { id: rowId(10), set: { code: "a2" } },
      { id: rowId(11), set: { code: "stolen" } },
    ]),
  ).toEqual({ count: 1 });
  expect((await a.p92Items.one({ where: { id: rowId(10) } }))?.code).toBe("a2");
  expect((await b.p92Items.one({ where: { id: rowId(10) } }))?.code).toBe("b");
  expect((await b.p92Items.one({ where: { id: rowId(11) } }))?.code).toBe("b2");

  expect(
    await db.p92Tasks.update([
      { id: rowId(20), set: { title: "seen" } },
      { id: rowId(99), set: { title: "missing" } },
    ]),
  ).toEqual({ count: 1 });
  expect((await db.p92Tasks.one({ where: { id: rowId(20) } }))?.title).toBe("seen");

  await harness.expectQueries(0, () =>
    expectCode(
      db.p92Tasks.update([
        { id: rowId(20), set: { position: 1 } },
        { where: { id: rowId(20) }, set: { position: 2 } },
      ]),
      "OKM1120",
    ),
  );
  expect((await db.p92Tasks.one({ where: { id: rowId(20) } }))?.position).toBe(3);

  await expectCode(
    db.p92Tags.update([{ id: rowId(1), set: { role: "admin" } }] as never),
    "OKM1190",
  );
  expect((await db.p92Tags.one({ where: { id: rowId(1) } }))?.role).toBe("member");

  const none: { readonly id: string; readonly set: { readonly title: string } }[] = [];
  await harness.expectQueries(0, async () => {
    expect(await db.p92Tasks.update(none)).toEqual({ count: 0 });
  });

  const sample = await db.p92Tasks.update([{ id: rowId(99), set: { position: 1 } }]).sql();
  const cost = sample.statements[0]?.params?.length ?? 1;
  const width = Math.floor(WRITE_PARAM_BUDGET / cost) + 1;
  const chunk: { id: string; set: { position: number } }[] = [];
  for (let index = 0; index < width; index += 1) {
    chunk.push({ id: rowId(100 + index), set: { position: index } });
  }
  const planned = await db.p92Tasks.update(chunk).sql();
  expect(planned.statements.length).toBeGreaterThan(1);
  for (const statement of planned.statements) {
    expect(statement.params?.length ?? 0).toBeLessThanOrEqual(WRITE_PARAM_BUDGET);
  }
  await harness.expectQueries(planned.statements.length, () => db.p92Tasks.update(chunk));

  const [batched] = await db.batch([
    db.p92Tags.insert(
      { id: rowId(30), name: "batched", note: "batch" },
      { onConflict: { on: "name", return: true } },
    ),
  ]);
  expect(batched).toMatchObject({ id: rowId(30), note: "batch" });
  const [again] = await db.batch([
    db.p92Tags.insert(
      { id: rowId(31), name: "batched", note: "nope" },
      { onConflict: { on: "name", return: true } },
    ),
  ]);
  expect(again).toMatchObject({ id: rowId(30), note: "batch" });

  const inside = await db.tx((tx) =>
    tx.p92Tags.insert(
      { id: rowId(32), name: "fresh", note: "tx" },
      { onConflict: { on: "name", return: true } },
    ),
  );
  expect(inside).toMatchObject({ id: rowId(1), note: "new" });
  const rolled = await db
    .tx(async (tx) => {
      await tx.p92Tags.insert(
        { id: rowId(33), name: "rolled", note: "x" },
        { onConflict: { on: "name", return: true } },
      );
      throw new Error("roll");
    })
    .then(
      () => false,
      () => true,
    );
  expect(rolled).toBe(true);
  expect(await db.p92Tags.one({ where: { name: "rolled" } })).toBeNull();

  if (sql === undefined) return;
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inserted: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const owner = db.tx(async (tx) => {
    const row = await tx.p92Tags.insert(
      { id: rowId(40), name: "race", note: "kept" },
      { onConflict: { on: "name", return: true } },
    );
    inserted();
    await hold;
    return row;
  });
  await ready;
  const other = db.p92Tags
    .insert(
      { id: rowId(41), name: "race", note: "nope" },
      { onConflict: { on: "name", return: true } },
    )
    .then((row) => row);
  await waitForLock(sql);
  release();
  const [left, right] = await Promise.all([owner, other]);
  expect(left).toMatchObject({ id: rowId(40), name: "race", note: "kept" });
  expect(right).toMatchObject({ id: rowId(40), name: "race", note: "kept" });
  expect(await db.p92Tags.count({ where: { name: "race" } })).toBe(1);
}

async function apply(sql: Sql, schemaName: string): Promise<void> {
  for (const statement of renderCatalog(app.catalog, schemaName)) {
    if (statement.trim().length === 0) continue;
    await sql.unsafe(statement);
  }
}

async function onPostgres(
  open: (schemaName: string) => DriverPool | Promise<DriverPool>,
  sql: Sql,
  schemaName: string,
): Promise<void> {
  await apply(sql, schemaName);
  const pool = await open(schemaName);
  const harness = await testing(app, { driver: pool, migrate: false });
  try {
    await run(harness, sql);
  } finally {
    await harness.close();
  }
}

test("pglite first-or-create and per-row update", async () => {
  const harness = await testing(app, { driver: openPglite() });
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
});

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "postgres.js first-or-create and per-row update",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await onPostgres(
        (name) => openPostgres({ url: primaryUrl(), searchPath: name, max: 4 }),
        sql,
        schemaName,
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "node-postgres first-or-create and per-row update",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await onPostgres(
        (name) => openNodePostgres({ url: primaryUrl(), searchPath: name, max: 4 }),
        sql,
        schemaName,
      );
    });
  },
  60_000,
);

const bunSql = typeof Bun !== "undefined" && typeof Bun.SQL === "function";
if (bunSql) {
  const adapter = await import("../src/adapters/pg/bunsql.js");
  postgresTest(
    gate,
    "bun.sql first-or-create and per-row update",
    async () => {
      await withPostgresSchema(async (sql, schemaName) => {
        await onPostgres(
          (name) =>
            adapter.open({
              url: primaryUrl(),
              searchPath: name,
              max: 4,
            }),
          sql,
          schemaName,
        );
      });
    },
    60_000,
  );
} else {
  test.skip("bun.sql first-or-create (Bun.sql runs only under Bun)", () => undefined);
}
