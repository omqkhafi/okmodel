/**
 * `connect({ limits })` and OKM2011 (M-7) on real Postgres, with the examples
 * from the limits page of the handbook.
 */

import { expect } from "bun:test";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { warnings, type WarningNotice } from "../src/runtime/warnings/index.js";
import {
  absentLimits,
  concurrentInsert,
  distinctLimits,
  findDefault,
  independence,
  maxCeiling,
  pageDefault,
  reachedWarning,
  untouched,
  type MakeLimits,
} from "./limits-cases.js";
import { limitsApp, limitsKey, seedLimits, type LimitsDb } from "./limits-schema.js";

const gate = await loadPostgresGate();

/**
 * Runs `body` against a fresh schema holding the seed.
 *
 * @param body - Receives a client factory and the schema name
 */
async function withSeed(
  body: (make: MakeLimits, schemaName: string) => Promise<void>,
): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(limitsApp.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const open: MakeLimits = (limits, notices) =>
      Promise.resolve(
        connect(primaryUrl(), {
          schema: limitsApp,
          searchPath: schemaName,
          max: 4,
          ...(limits === undefined ? {} : { limits }),
          warnings: warnings({ env: "development", onWarning: (notice) => notices.push(notice) }),
        }) as unknown as LimitsDb,
      );
    const seeder = await open(undefined, []);
    try {
      await seeder.connected;
      await seedLimits(seeder);
    } finally {
      await seeder.close();
    }
    const opened: Awaited<ReturnType<MakeLimits>>[] = [];
    const make: MakeLimits = async (limits, notices) => {
      const db = await open(limits, notices);
      opened.push(db);
      await db.connected;
      return db;
    };
    try {
      await body(make, schemaName);
    } finally {
      for (const db of opened) await db.close();
    }
  });
}

const cases = [
  ["absent limits keep today's behaviour", absentLimits],
  ["find takes limits.find, an explicit limit and .all win", findDefault],
  ["distinct and distinctOn take limits.find", distinctLimits],
  ["limits.max is a hard ceiling that .all(reason) passes", maxCeiling],
  ["include and groupBy never inherit from find", independence],
  ["page() takes limits.page", pageDefault],
  ["stream, one, count, exists, and writes are untouched", untouched],
  [
    "OKM2011 fires only for a default that returned its row count",
    (make: MakeLimits) => reachedWarning(make, { find: 4, include: 2, groupBy: 4 }),
  ],
  [
    "inserts racing default reads do not change what they return",
    (make: MakeLimits) => concurrentInsert(make, 4),
  ],
] as const;

for (const [name, run] of cases) {
  postgresTest(gate, name, () => withSeed((make) => run(make)));
}

postgresTest(gate, "the handbook examples run as written", () =>
  withSeed(async (make) => {
    const notices: WarningNotice[] = [];
    const db = await make({ find: 3, include: 2, page: 2, groupBy: 4, max: 5 }, notices);

    const recent = await db.notes.find({ orderBy: { id: "asc" } });
    expect(recent).toHaveLength(3);
    expect(notices.map((notice) => notice.code)).toEqual(["OKM2011"]);
    expect(notices[0]?.limit).toBe("limits.find = 3");
    expect(notices[0]?.location?.file).toContain("limits-pg.test.ts");

    const exact = await db.notes.find({ orderBy: { id: "asc" }, limit: 3 });
    expect(exact).toHaveLength(3);
    const everything = await db.notes.find({ orderBy: { id: "asc" } }).all("nightly export");
    expect(everything).toHaveLength(5);
    expect(notices).toHaveLength(1);

    const inspected = await db.notes.find({ orderBy: { id: "asc" } }).inspect();
    expect(inspected.intent.limit).toBe(3);
    expect(inspected.rules).toContainEqual({
      rule: "bounded",
      contribution: "limits.find",
      provenance: "connect",
    });

    const first = await db.notes.page({ orderBy: { id: "asc" } });
    expect(first.items).toHaveLength(2);
    expect(first.next).toBeDefined();

    const note = await db.notes.find({
      where: { id: limitsKey("n", 0) },
      orderBy: { id: "asc" },
      limit: 1,
      include: { comments: true, tags: true } as never,
    });
    expect(note[0]?.comments).toHaveLength(2);
    expect(note[0]?.tags).toHaveLength(2);

    const groups = await db.notes.aggregate({ groupBy: ["rank"], count: true });
    expect(groups).toHaveLength(4);

    const above = await db.notes.find({ orderBy: { id: "asc" }, limit: 6 }).then(
      () => undefined,
      (error: { code?: string }) => error.code,
    );
    expect(above).toBe("OKM1101");
    const wide = await db.notes.find({ orderBy: { id: "asc" }, limit: 6 }).all("backfill");
    expect(wide).toHaveLength(5);
  }),
);
