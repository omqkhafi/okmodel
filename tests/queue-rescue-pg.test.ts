/**
 * Queue rescue: a null heartbeat is stale only after the claim, and a rescue
 * refreshes the marker so a second rescuer does not take the same row.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { inc, lt, or, schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres, open as openPostgres } from "../src/runtime/pg/postgresjs.js";
import { versioned } from "../src/runtime/traits/index.js";
import type { Connected } from "../src/runtime/types.js";

const gate = await loadPostgresGate();

const jobs = table(
  "jobs",
  {
    id: t.text().primaryKey(),
    status: t.text(),
    attempt: t.integer().default(0),
    owner: t.text().nullable(),
    claimedAt: t.timestamptz().nullable(),
    heartbeatAt: t.timestamptz().nullable(),
  },
  { traits: [versioned()] },
);
const app = schema({ tables: [jobs] });

type Db = Connected<typeof app>;

test("rescue claims a dead job once", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    await db.connected;
    try {
      await proveRescue(db);
    } finally {
      await db.close();
    }
  } finally {
    await pool.close();
  }
});

postgresTest(
  gate,
  "rescue claims a dead job once on Postgres",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      const pool = openPostgres({ url: database.url });
      for (const statement of renderCatalog(app.catalog, "public")) {
        await pool.execute(statement);
      }
      const db = connectPostgres(pool, { schema: app });
      await db.connected;
      try {
        await proveRescue(db);
      } finally {
        await db.close();
      }
    } finally {
      await database.close();
    }
  },
  60_000,
);

function instant(minutesAgo: number): Temporal.Instant {
  return Temporal.Instant.from(new Date(Date.now() - minutesAgo * 60_000).toISOString());
}

async function proveRescue(db: Db): Promise<void> {
  const now = instant(0);
  const old = instant(10);
  await db.jobs.insert([
    { id: "a", status: "running", claimedAt: old, heartbeatAt: null },
    { id: "b", status: "running", claimedAt: now, heartbeatAt: null },
    { id: "c", status: "running", claimedAt: old, heartbeatAt: old },
  ]);

  const first = await rescue(db, "one");
  expect(first?.id).toBe("a");
  expect(first?.owner).toBe("one");
  expect(first?.attempt).toBe(1);
  expect(first?.heartbeatAt).not.toBeNull();

  const second = await rescue(db, "two");
  expect(second?.id).toBe("c");
  expect(second?.owner).toBe("two");

  expect(await rescue(db, "three")).toBeUndefined();
  const rows = await db.jobs.find({ limit: 10 });
  const byId = new Map(rows.map((row) => [row.id, row]));
  expect(byId.get("a")?.owner).toBe("one");
  expect(byId.get("b")?.owner).toBeNull();
  expect(byId.get("c")?.owner).toBe("two");
}

async function rescue(db: Db, owner: string) {
  const now = instant(0);
  const stale = instant(5);
  const [job] = await db.jobs.update({
    where: or([
      { status: "running", heartbeatAt: null, claimedAt: lt(stale) },
      { status: "running", heartbeatAt: lt(stale) },
    ]),
    set: { status: "running", attempt: inc(1), claimedAt: now, heartbeatAt: now, owner },
    limit: 1,
    lock: "skip",
    version: "any",
  });
  return job;
}
