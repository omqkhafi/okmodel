/**
 * `.stream()` walks keyset batches on every driver (P98).
 *
 * PGlite always runs. postgres.js, node-postgres, and Bun.sql run when the
 * topology is up. A second connection, for the snapshot, needs a pool, so
 * PGlite skips that part: its one connection is held by the transaction.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  integer,
  lte,
  many,
  rowNumber,
  schema,
  table,
  text,
  tsvector,
} from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import type { Connected } from "../src/runtime/types.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c31";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c32";
const COUNT = 900;

const items = table(
  "items",
  {
    n: integer().primaryKey(),
    label: text().nullable(),
  },
  {
    relations: { notes: many("notes", "itemN") },
    presets: {
      labeled: (q, label: string) => q.where({ label }),
    },
  },
);

const notes = table("notes", {
  id: integer().primaryKey(),
  itemN: integer().references("items"),
  body: text(),
});

const pairs = table(
  "pairs",
  {
    a: integer(),
    b: integer(),
    label: text(),
  },
  { primaryKey: ["a", "b"] },
);

const loose = table("loose", { label: text() });

const files = table(
  "files",
  {
    n: integer().primaryKey(),
    title: text(),
  },
  { traits: [archivable()] },
);

const pages = table("pages", {
  n: integer().primaryKey(),
  body: tsvector(),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [items, notes, pairs, loose, files, pages],
});

type Db = Connected<typeof app>;
type Scoped = ReturnType<Db["for"]>;
type Item = { n: number; label: string | null };

const gate = await loadPostgresGate();

test("keyset stream on pglite", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    await db.connected;
    try {
      await prove(db);
    } finally {
      await db.close();
    }
  } finally {
    await pool.close();
  }
}, 60_000);

for (const driver of ["postgres.js", "node-postgres", "bun.sql"] as const) {
  postgresTest(
    gate,
    `keyset stream on ${driver}`,
    async () => {
      await withPostgresSchema(async (sql, schemaName) => {
        for (const statement of renderCatalog(app.catalog, schemaName)) {
          await sql.unsafe(statement);
        }
        const db = openDriver(driver, schemaName);
        await db.connected;
        try {
          await prove(db, () => openDriver(driver, schemaName));
        } finally {
          await db.close();
        }
      });
    },
    60_000,
  );
}

function openDriver(driver: "postgres.js" | "node-postgres" | "bun.sql", schemaName: string): Db {
  const options = { schema: app, searchPath: schemaName, max: 1 };
  if (driver === "postgres.js") return connectPostgres(primaryUrl(), options);
  if (driver === "node-postgres") return connectPg(primaryUrl(), options);
  return connectBun(primaryUrl(), options);
}

async function prove(db: Db, openOther?: () => Db): Promise<void> {
  const a = db.for({ tenantId: TENANT_A });
  const b = db.for({ tenantId: TENANT_B });
  await refusals(a);

  expect(
    await collect(
      a.items
        .find({ where: { n: -1 } })
        .all("export")
        .stream(),
    ),
  ).toEqual([]);
  expect(await collect(a.items.find({ limit: 0 }).stream())).toEqual([]);

  await a.items.insert(
    Array.from({ length: COUNT }, (_, index) => {
      const n = index + 1;
      return { n, label: n % 10 === 0 ? null : `r${String(n)}` };
    }),
  );
  await b.items.insert({ n: 1, label: "other" });
  await a.notes.insert([
    { id: 1, itemN: 1, body: "one" },
    { id: 2, itemN: 1, body: "two" },
  ]);
  await a.pairs.insert([
    { a: 1, b: 2, label: "late" },
    { a: 1, b: 1, label: "early" },
    { a: 2, b: 1, label: "high" },
  ]);
  await a.files.insert([
    { n: 1, title: "keep" },
    { n: 2, title: "gone" },
  ]);
  await a.files.archive({ where: { n: 2 } });

  const all = await collect<Item>(a.items.find({}).all("export").stream({ batch: 300 }));
  expect(all).toHaveLength(COUNT);
  expect(all.map((row) => row.n)).toEqual(Array.from({ length: COUNT }, (_, index) => index + 1));

  const exact = await collect<Item>(
    a.items
      .find({ where: { n: lte(300) } })
      .all("export")
      .stream({ batch: 300 }),
  );
  expect(exact.map((row) => row.n)).toEqual(Array.from({ length: 300 }, (_, index) => index + 1));

  const boundary = await collect<Item>(
    a.items
      .find({ where: { n: lte(4) } })
      .all("export")
      .stream({ batch: 2 }),
  );
  expect(boundary.map((row) => row.n)).toEqual([1, 2, 3, 4]);

  const capped = await collect<Item>(a.items.find({ limit: 4 }).stream({ batch: 3 }));
  expect(capped.map((row) => row.n)).toEqual([1, 2, 3, 4]);

  const narrow = await collect<{ label: string | null }>(
    a.items.find({ where: { n: 1 }, select: ["label"], limit: 1 }).stream(),
  );
  expect(narrow).toEqual([{ label: "r1" }]);
  expect(narrow[0] !== undefined && "n" in narrow[0]).toBe(false);

  const labeled = await collect<Item>(a.items.labeled("r1").find({}).all("export").stream());
  expect(labeled.map((row) => row.n)).toEqual([1]);

  const included = await collect<{ n: number; notes: readonly { body: string }[] }>(
    a.items.find({ where: { n: 1 }, include: { notes: { limit: 5 } }, limit: 1 }).stream(),
  );
  expect(
    included[0]?.notes.map((note) => note.body).sort((left, right) => (left < right ? -1 : 1)),
  ).toEqual(["one", "two"]);

  const byLabel = await collect<Item>(
    a.items
      .find({ where: { n: lte(20) } })
      .all("export")
      .stream({ batch: 7 }),
  );
  expect(byLabel.map((row) => row.n)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

  const ordered = await collect<{ a: number; b: number }>(
    a.pairs.find({}).all("export").stream({ batch: 1 }),
  );
  expect(ordered.map((row) => [row.a, row.b])).toEqual([
    [1, 1],
    [1, 2],
    [2, 1],
  ]);
  // `a` descending, then `b` ascending, which is the primary-key tie-break.
  const custom = await collect<{ a: number; b: number }>(
    a.pairs
      .find({ orderBy: { a: "desc" } })
      .all("export")
      .stream({ batch: 2 }),
  );
  expect(custom.map((row) => [row.a, row.b])).toEqual([
    [2, 1],
    [1, 1],
    [1, 2],
  ]);

  const nullable = await collect<Item>(
    a.items
      .find({ where: { n: lte(20) }, orderBy: { label: "asc" } })
      .all("export")
      .stream({ batch: 8 }),
  );
  const nulls = nullable.filter((row) => row.label === null).map((row) => row.n);
  expect(nulls).toEqual([10, 20]);
  expect(nullable.at(-1)?.label).toBeNull();

  const active = await collect<{ n: number }>(a.files.find({}).all("export").stream());
  expect(active.map((row) => row.n)).toEqual([1]);
  const archived = await collect<{ n: number }>(
    a.files.withArchived().find({}).all("export").stream({ batch: 1 }),
  );
  expect(archived.map((row) => row.n).sort((left, right) => left - right)).toEqual([1, 2]);

  const tenant = await collect<Item>(b.items.find({}).all("export").stream());
  expect(tenant.map((row) => row.label)).toEqual(["other"]);

  let broken = 0;
  for await (const row of a.items.find({}).all("export").stream({ batch: 50 })) {
    broken += 1;
    expect(row.n).toBe(1);
    break;
  }
  expect(broken).toBe(1);
  const again = await finished(a.items.find({ limit: 1 }));
  expect(Array.isArray(again) && again.length).toBe(1);

  const ac = new AbortController();
  let signalled = 0;
  const signalError = await streamError(async () => {
    for await (const row of a.items
      .find({ signal: ac.signal })
      .all("export")
      .stream({ batch: 1 })) {
      signalled += 1;
      expect(row.n).toBe(1);
      ac.abort();
    }
  });
  expect(signalError.kind).toBe("cancelled");
  expect(signalError.message).toBe("The stream was cancelled.");
  expect(signalled).toBe(1);
  await finished(a.items.find({ limit: 1 }));

  const already = new AbortController();
  already.abort();
  const early = await streamError(() =>
    collect(a.items.find({ signal: already.signal }).all("export").stream()),
  );
  expect(early.message).toBe("The stream was cancelled.");

  let timed = 0;
  const timeoutError = await streamError(async () => {
    for await (const row of a.items.find({ timeout: 1_000 }).all("export").stream({ batch: 1 })) {
      timed += 1;
      expect(row.n).toBe(1);
      await Bun.sleep(1_200);
    }
  });
  expect(timeoutError.kind).toBe("timeout");
  expect(timeoutError.message).toBe("The stream timed out.");
  expect(timed).toBe(1);
  await finished(a.items.find({ limit: 1 }));

  if (openOther !== undefined) await snapshot(db, openOther);
}

async function refusals(a: Scoped): Promise<void> {
  const missing = await streamError(() => collect(a.loose.find({}).all("export").stream()));
  expect(missing.code).toBe("OKM1120");
  expect(missing.message).toContain("primary key");

  const searched = await streamError(() =>
    collect(a.pages.find({ search: "deploy", limit: 1 } as { limit: number }).stream()),
  );
  expect(searched.code).toBe("OKM1120");
  expect(searched.message).toContain("search");

  const windowed = await streamError(() =>
    collect(
      a.items
        .find({
          select: [rowNumber({ orderBy: { n: "asc" }, as: "rank" })],
          limit: 1,
        })
        .stream(),
    ),
  );
  expect(windowed.code).toBe("OKM1120");
  expect(windowed.message).toContain("window");

  const counted = await streamError(() => collect(a.items.count().stream()));
  expect(counted.code).toBe("OKM1120");
  expect(counted.message).toContain("find()");

  const unbounded = await streamError(() =>
    collect((a.items.find({}) as unknown as { stream(): AsyncIterable<unknown> }).stream()),
  );
  expect(unbounded.code).toBe("OKM1101");

  const badBatch = await streamError(() =>
    collect(a.items.find({ limit: 1 }).stream({ batch: 0 })),
  );
  expect(badBatch.code).toBe("OKM1121");
}

async function snapshot(db: Db, openOther: () => Db): Promise<void> {
  const writer = openOther();
  await writer.connected;
  try {
    await db.for({ tenantId: TENANT_A }).tx({ isolation: "repeatable read" }, async (tx) => {
      const iter = tx.items.find({}).all("export").stream({ batch: 2 })[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.done).toBe(false);
      if (first.done) return;
      expect(first.value.n).toBe(1);
      await writer.for({ tenantId: TENANT_A }).items.insert({ n: 5000, label: "late" });
      await writer.for({ tenantId: TENANT_A }).items.update({
        where: { n: 5 },
        set: { label: "changed" },
      });
      const rest: Item[] = [];
      for (;;) {
        const step = await iter.next();
        if (step.done) break;
        rest.push(step.value);
      }
      expect(rest.some((row) => row.n === 5000)).toBe(false);
      expect(rest.find((row) => row.n === 5)?.label).toBe("r5");
    });

    const iter = db
      .for({ tenantId: TENANT_A })
      .items.find({})
      .all("export")
      .stream({ batch: 2 })
      [Symbol.asyncIterator]();
    await iter.next();
    await writer.for({ tenantId: TENANT_A }).items.insert({ n: 5001, label: "seen" });
    const rest: Item[] = [];
    for (;;) {
      const step = await iter.next();
      if (step.done) break;
      rest.push(step.value);
    }
    expect(rest.some((row) => row.n === 5001)).toBe(true);
  } finally {
    await writer.close();
  }
}

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

async function streamError(run: () => Promise<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected the stream to fail");
}

/** Fails when the follow-up query does not finish. A held connection would wait here. */
async function finished(query: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("the connection was still held")), 3_000);
  });
  try {
    return await Promise.race([query, hung]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
