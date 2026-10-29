/**
 * `connect({ limits })` and OKM2011 (M-7) on PGlite, plus the connect-time checks.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { connect } from "../src/runtime/pg/pglite.js";
import type { Limits } from "../src/runtime/types.js";
import { warnings, type WarningNotice } from "../src/runtime/warnings/index.js";
import { queryObserver } from "../src/runtime/observe.js";
import type { QueryEvent } from "../src/runtime/observe-types.js";
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
import { limitsApp, seedLimits, type LimitsDb } from "./limits-schema.js";

async function seeded(): Promise<{ pool: DriverPool; make: MakeLimits }> {
  const pool = await open();
  for (const statement of renderCatalog(limitsApp.catalog, "public")) {
    await pool.execute(statement);
  }
  await seedLimits(await connect(pool, { schema: limitsApp }));
  const make: MakeLimits = async (limits, notices) =>
    (await connect(pool, {
      schema: limitsApp,
      ...(limits === undefined ? {} : { limits }),
      warnings: warnings({ env: "development", onWarning: (notice) => notices.push(notice) }),
    })) as unknown as LimitsDb;
  return { pool, make };
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
    (make: MakeLimits) => reachedWarning(make, { find: 3, include: 3, groupBy: 3 }),
  ],
  [
    "concurrent inserts do not change a default read",
    (make: MakeLimits) => concurrentInsert(make, 5),
  ],
] as const;

for (const [name, run] of cases) {
  test(name, async () => {
    const { pool, make } = await seeded();
    try {
      await run(make);
    } finally {
      await pool.close();
    }
  });
}

test("the query event carries the limit and its source", async () => {
  const { pool } = await seeded();
  try {
    const events: QueryEvent[] = [];
    const onQuery = queryObserver({ query: (event) => void events.push(event) });
    const db = (await connect(pool, {
      schema: limitsApp,
      limits: { find: 2 },
      onQuery,
    })) as unknown as LimitsDb;
    await db.notes.find({ orderBy: { id: "asc" } });
    await db.notes.find({ orderBy: { id: "asc" }, limit: 4 });
    expect(events.filter((event) => event.op === "find").map((event) => event.limit)).toEqual([
      { value: 2, source: "limits.find" },
      { value: 4, source: "caller" },
    ]);
  } finally {
    await pool.close();
  }
});

test("limits are checked once: positive integers, known keys, none above max", async () => {
  const { pool } = await seeded();
  try {
    const bad: readonly [unknown, string][] = [
      [{ find: 0 }, "limits.find is a positive integer."],
      [{ include: 1.5 }, "limits.include is a positive integer."],
      [{ page: "10" }, "limits.page is a positive integer."],
      [{ groupBy: -1 }, "limits.groupBy is a positive integer."],
      [{ max: Infinity }, "limits.max is a positive integer."],
      [{ find: 50, max: 10 }, "limits.find is above limits.max."],
      [{ page: 11, max: 10 }, "limits.page is above limits.max."],
      [{ fnd: 5 }, "limits.fnd is unknown."],
      [[], "limits is an object."],
      [null, "limits is an object."],
    ];
    for (const [limits, message] of bad) {
      const error = await connect(pool, { schema: limitsApp, limits } as never)
        .then((db) => db.connected)
        .then(
          () => undefined,
          (rejected: unknown) => rejected,
        );
      expect(error).toBeInstanceOf(OkmError);
      expect((error as OkmError).code).toBe("OKM1120");
      expect((error as OkmError).message).toContain(message);
    }
    const ok: Limits = { find: 10, include: 10, page: 10, groupBy: 10, max: 10 };
    const db = await connect(pool, { schema: limitsApp, limits: ok });
    await db.connected;
  } finally {
    await pool.close();
  }
});

test("the console line names the call site, the key, and the ways out", async () => {
  const { pool } = await seeded();
  const lines: string[] = [];
  const previous = console.warn;
  console.warn = (...args: readonly unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const db = (await connect(pool, {
      schema: limitsApp,
      limits: { find: 2 },
      warnings: warnings({ env: "development" }),
    })) as unknown as LimitsDb;
    await db.notes.find({ orderBy: { id: "asc" } });
  } finally {
    console.warn = previous;
    await pool.close();
  }
  const text = lines.join("\n");
  expect(text).toContain("OKM2011 warn:");
  expect(text).toContain("limits.test.ts");
  expect(text).toContain("Limit: limits.find = 2");
  expect(text).toContain(".all(reason)");
  expect(text).toContain("Fix: Pass a limit that fits the call, or use page() with a cursor.");
  expect(text).toContain("docs/errors/OKM2011.md");
});

test("production reports nothing until a level is set, and ignore silences one call", async () => {
  const { pool } = await seeded();
  const seen: WarningNotice[] = [];
  try {
    const quiet = (await connect(pool, {
      schema: limitsApp,
      limits: { find: 2 },
      warnings: warnings({ env: "production", onWarning: (notice) => seen.push(notice) }),
    })) as unknown as LimitsDb;
    await quiet.notes.find({ orderBy: { id: "asc" } });
    expect(seen).toEqual([]);

    const ignored = (await connect(pool, {
      schema: limitsApp,
      limits: { find: 2 },
      warnings: warnings({ env: "development", onWarning: (notice) => seen.push(notice) }),
    })) as unknown as LimitsDb;
    await ignored.notes.find({
      orderBy: { id: "asc" },
      ignore: { rule: "default-limit-reached", reason: "first two are enough" },
    });
    expect(seen).toEqual([]);
  } finally {
    await pool.close();
  }
});
