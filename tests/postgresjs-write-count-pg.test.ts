/**
 * Write counts on postgres.js 3 and 4.
 *
 * 4.x keeps `count` on the result class. An update, a delete, and a claim
 * still report the command tag, including zero.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, text } from "../src/dialects/pg/index.js";
import { testing, type Testing } from "../src/tooling/testing/index.js";

const jobs = table("jobs", {
  id: text().primaryKey(),
  status: text(),
  claimedBy: text().nullable(),
});

const app = schema({ casing: "snake", tables: [jobs] });

type Db = Testing<typeof app>["db"];

type Job = { id: string; status: string; claimedBy: string | null };

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "postgres.js write counts, a claim, and a miss",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await apply(sql, schemaName);
      const open = (): ReturnType<typeof openPostgres> =>
        openPostgres({ url: primaryUrl(), searchPath: schemaName, max: 1 });
      const harness = await testing(app, { driver: open(), migrate: false });
      const other = await testing(app, { driver: open(), migrate: false });
      try {
        await matrix(harness.db, other.db);
      } finally {
        await other.close();
        await harness.close();
      }
    });
  },
  20_000,
);

async function matrix(db: Db, other: Db): Promise<void> {
  await db.jobs.insert([
    { id: "a", status: "pending" },
    { id: "b", status: "pending" },
  ]);

  expect(await db.jobs.update({ where: { id: "a" }, set: { status: "edited" } })).toEqual({
    count: 1,
  });
  expect(
    await db.jobs.update([
      { where: { id: "a" }, set: { status: "listed" } },
      { where: { id: "b" }, set: { status: "listed" } },
    ]),
  ).toEqual({ count: 2 });
  expect(
    await db.jobs.update({ where: { id: "a" }, set: { status: "checked" } }).expect(1),
  ).toEqual({ count: 1 });

  await db.jobs.update([
    { where: { id: "a" }, set: { status: "pending", claimedBy: null } },
    { where: { id: "b" }, set: { status: "pending", claimedBy: null } },
  ]);
  const claimed = await claim(db, "worker-1");
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.status).toBe("running");
  const taken = claimed[0];
  if (taken === undefined) throw new Error("claim returned no job");
  const left = taken.id === "a" ? "b" : "a";
  expect(await db.jobs.delete({ where: { id: left } })).toEqual({ count: 1 });

  const returned: unknown = await db.jobs.update(
    { where: { id: taken.id }, set: { status: "done" } },
    { returning: ["id", "status"] },
  );
  expect(returned).toEqual([{ id: taken.id, status: "done" }]);

  expect(await db.jobs.update({ where: { id: "missing" }, set: { status: "nope" } })).toEqual({
    count: 0,
  });
  let missed: unknown;
  try {
    await db.jobs.update({ where: { id: "missing" }, set: { status: "nope" } }).expect(1);
  } catch (error) {
    missed = error;
  }
  expect(missed).toBeInstanceOf(OkmError);
  if (!(missed instanceof OkmError)) throw new Error("expected not_found");
  expect(missed.kind).toBe("not_found");

  await db.jobs.delete({ where: { id: "a" } });
  await db.jobs.delete({ where: { id: "b" } });
  await db.jobs.insert([
    { id: "a", status: "pending" },
    { id: "b", status: "pending" },
  ]);
  const [first, second] = await Promise.all([claim(db, "left"), claim(other, "right")]);
  expect([...first, ...second].map((row) => row.id).sort()).toEqual(["a", "b"]);
}

/**
 * Claims one pending job and reads it back by the token.
 *
 * A count of zero returns no rows. The documented pattern uses that count,
 * not a `returning` list.
 *
 * @param db - Client on its own connection
 * @param token - Value stored in `claimedBy`
 * @returns The claimed job, or an empty list
 */
async function claim(db: Db, token: string): Promise<readonly Job[]> {
  const claimed = await db.jobs.update({
    where: { status: "pending" },
    set: { status: "running", claimedBy: token },
    limit: 1,
    lock: "skip",
  });
  if (claimed.count === 0) return [];
  return db.jobs.find({ where: { claimedBy: token }, limit: claimed.count });
}

async function apply(sql: Sql, schemaName: string): Promise<void> {
  for (const statement of renderCatalog(app.catalog, schemaName)) {
    if (statement.trim().length === 0) continue;
    await sql.unsafe(statement);
  }
}
