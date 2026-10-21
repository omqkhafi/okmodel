/**
 * The `connect({ limits })` cases (M-7). PGlite and real Postgres run the same
 * ones, so the two files only differ in how `make` opens a client.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { gte, has, lt, matches } from "../src/dialects/pg/index.js";
import type { Limits } from "../src/runtime/types.js";
import type { WarningNotice } from "../src/runtime/warnings/index.js";
import { limitsKey, type LimitsDb } from "./limits-schema.js";

/** Opens a client on the seeded database. */
export type MakeLimits = (
  limits: Limits | undefined,
  notices: WarningNotice[],
) => Promise<LimitsDb>;

async function code(pending: PromiseLike<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

async function failure(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

const ORDER = { id: "asc" } as const;

/**
 * Without `limits`, a read behaves as before.
 *
 * @param make - Client factory
 */
export async function absentLimits(make: MakeLimits): Promise<void> {
  const db = await make(undefined, []);
  expect(await code(db.notes.find({ orderBy: ORDER }))).toBe("OKM1101");
  expect(await code(db.notes.find({ orderBy: ORDER, include: { comments: true } as never }))).toBe(
    "OKM1105",
  );
  expect(await code(db.notes.page({ orderBy: ORDER }))).toBe("OKM1101");
  expect(await code(db.notes.aggregate({ groupBy: ["rank"], count: true }))).toBe("OKM1101");
  expect((await db.notes.find({ orderBy: ORDER, limit: 4 })).length).toBe(4);
  expect((await db.notes.find({ orderBy: ORDER }).all("test")).length).toBe(5);
  const inspected = await db.notes.find({ orderBy: ORDER, limit: 4 }).inspect();
  expect(inspected.rules.find((rule) => rule.rule === "bounded")?.contribution).toBe("limit");
}

/**
 * A default applies only where the call states neither a limit nor `.all`.
 *
 * @param make - Client factory
 */
export async function findDefault(make: MakeLimits): Promise<void> {
  const notices: WarningNotice[] = [];
  const db = await make({ find: 3, max: 4 }, notices);
  expect((await db.notes.find({ orderBy: ORDER })).length).toBe(3);
  expect((await db.notes.find({ orderBy: ORDER, limit: 2 })).length).toBe(2);
  expect((await db.notes.find({ orderBy: ORDER }).all("test")).length).toBe(5);

  const defaulted = await db.notes.find({ orderBy: ORDER }).inspect();
  expect(defaulted.intent.limit).toBe(3);
  const rule = defaulted.rules.find((entry) => entry.rule === "bounded");
  expect(rule).toEqual({ rule: "bounded", contribution: "limits.find", provenance: "connect" });
  const written = await db.notes.find({ orderBy: ORDER, limit: 2 }).inspect();
  const own = written.rules.find((entry) => entry.rule === "bounded");
  expect(own).toEqual({ rule: "bounded", contribution: "limit", provenance: "caller" });

  expect((await db.notes.top().find({ orderBy: ORDER })).length).toBe(1);
  expect((await db.notes.top().find({ orderBy: ORDER }).inspect()).intent.limit).toBe(3);
  const locked = await db.tx((tx) => tx.notes.find({ orderBy: ORDER, lock: "update" }));
  expect(locked.length).toBe(3);
  const related = await db.notes.find({
    where: { comments: has({ body: "c0" }) },
    orderBy: ORDER,
  });
  expect(related.map((row) => row.rank)).toEqual([0]);
  const searched = await db.notes.find({ where: { doc: matches("note") }, orderBy: ORDER });
  expect(searched.length).toBe(3);
}

/**
 * `limits.max` is a hard ceiling for explicit limits, and `.all(reason)` goes past it.
 *
 * @param make - Client factory
 */
export async function maxCeiling(make: MakeLimits): Promise<void> {
  const db = await make({ find: 2, page: 2, include: 2, max: 4 }, []);
  expect((await db.notes.find({ orderBy: ORDER, limit: 4 })).length).toBe(4);

  const over = await failure(db.notes.find({ orderBy: ORDER, limit: 5 }));
  expect(over.code).toBe("OKM1101");
  expect(over.message).toContain("limits.max (4)");
  expect(over.fix?.summary).toContain(".all(reason)");
  expect((await db.notes.find({ orderBy: ORDER, limit: 5 }).all("export")).length).toBe(5);

  expect(await code(db.notes.page({ orderBy: ORDER, limit: 5 }))).toBe("OKM1101");
  expect(
    await code(
      db.notes.find({ orderBy: ORDER, limit: 1, include: { comments: { limit: 5 } } as never }),
    ),
  ).toBe("OKM1101");
  const wide = await db.notes
    .find({ orderBy: ORDER, limit: 1, include: { comments: { limit: 5 } } as never })
    .all("export");
  expect(wide.length).toBe(1);
}

/**
 * `include` and `groupBy` never inherit from `find`.
 *
 * @param make - Client factory
 */
export async function independence(make: MakeLimits): Promise<void> {
  const findOnly = await make({ find: 3 }, []);
  expect(
    await code(
      findOnly.notes.find({ orderBy: ORDER, limit: 1, include: { comments: true } as never }),
    ),
  ).toBe("OKM1105");
  expect(await code(findOnly.notes.aggregate({ groupBy: ["rank"], count: true }))).toBe("OKM1101");
  expect(await code(findOnly.notes.page({ orderBy: ORDER }))).toBe("OKM1101");

  const includeOnly = await make({ include: 2 }, []);
  expect(await code(includeOnly.notes.find({ orderBy: ORDER }))).toBe("OKM1101");
  const rows = await includeOnly.notes.find({
    where: { rank: 0 },
    orderBy: ORDER,
    limit: 5,
    include: { comments: true, tags: true } as never,
  });
  expect(rows[0]?.comments.length).toBe(2);
  expect(rows[0]?.tags.length).toBe(2);
  const own = await includeOnly.notes.find({
    where: { rank: 0 },
    orderBy: ORDER,
    limit: 5,
    include: { comments: { limit: 3 } } as never,
  });
  expect(own[0]?.comments.length).toBe(3);
  const all = await includeOnly.notes
    .find({ where: { rank: 0 }, orderBy: ORDER, limit: 5, include: { comments: true } as never })
    .all("export");
  expect(all[0]?.comments.length).toBe(3);

  const groupOnly = await make({ groupBy: 2 }, []);
  expect(await code(groupOnly.notes.find({ orderBy: ORDER }))).toBe("OKM1101");
  const groups = await groupOnly.notes.aggregate({ groupBy: ["rank"], count: true });
  expect(groups.length).toBe(2);
  expect(
    (await groupOnly.notes.aggregate({ groupBy: ["rank"], count: true, limit: 4 })).length,
  ).toBe(4);
  expect((await groupOnly.notes.aggregate({ count: true })).length).toBe(1);

  const pageOnly = await make({ page: 2 }, []);
  expect(await code(pageOnly.notes.find({ orderBy: ORDER }))).toBe("OKM1101");
}

/**
 * `page()` takes `limits.page` as its page size, and the cursor continues.
 *
 * @param make - Client factory
 */
export async function pageDefault(make: MakeLimits): Promise<void> {
  const db = await make({ page: 2 }, []);
  const first = await db.notes.page({ orderBy: ORDER });
  expect(first.items.map((row) => row.rank)).toEqual([0, 1]);
  const second = await db.notes.page({ orderBy: ORDER, after: first.next as string });
  expect(second.items.map((row) => row.rank)).toEqual([2, 3]);
  const third = await db.notes.page({ orderBy: ORDER, after: second.next as string });
  expect(third.items.map((row) => row.rank)).toEqual([4]);
  expect((await db.notes.page({ orderBy: ORDER, limit: 3 })).items.length).toBe(3);

  const streamed: number[] = [];
  for await (const row of db.notes.find({ orderBy: ORDER, limit: 5 }).stream()) {
    streamed.push(row.rank);
  }
  expect(streamed).toEqual([0, 1, 2, 3, 4]);
}

/**
 * Operations the limits do not cover keep their own rules.
 *
 * @param make - Client factory
 */
export async function untouched(make: MakeLimits): Promise<void> {
  const db = await make({ find: 1, include: 1, page: 1, groupBy: 1, max: 1 }, []);
  expect(await db.notes.count({})).toBe(5);
  expect(await db.notes.exists({ where: { rank: 4 } })).toBe(true);
  expect((await db.notes.aggregate({ count: true }))[0]?.count).toBe(5);
  expect((await db.notes.one({ where: { rank: 2 } }))?.rank).toBe(2);
  const streamed: number[] = [];
  for await (const row of db.notes
    .find({ orderBy: ORDER })
    .all("walk")
    .stream({ batch: 2 } as never)) {
    streamed.push(row.rank);
  }
  expect(streamed).toEqual([0, 1, 2, 3, 4]);
  expect((await db.notes.update({ where: { rank: 4 }, set: { title: "last" } })).count).toBe(1);
}

/** The defaults one `reachedWarning` run sets. The warning is reported once per call site and value, so each file picks its own. */
export type Defaults = {
  readonly find: number;
  readonly include: number;
  readonly groupBy: number;
};

/**
 * OKM2011 is raised only for a default that returned exactly its row count.
 *
 * @param make - Client factory
 * @param d - Defaults to set
 */
export async function reachedWarning(make: MakeLimits, d: Defaults): Promise<void> {
  const notices: WarningNotice[] = [];
  const db = await make({ find: d.find, include: d.include, page: 3, groupBy: d.groupBy }, notices);
  const codes = (): string[] =>
    notices.filter((n) => n.code === "OKM2011").map((n) => n.limit ?? "");
  const find = `limits.find = ${String(d.find)}`;
  const include = `limits.include = ${String(d.include)}`;
  const groupBy = `limits.groupBy = ${String(d.groupBy)}`;

  await db.notes.find({ orderBy: ORDER });
  expect(codes()).toEqual([find]);
  expect(notices.at(-1)?.location?.file).toContain("limits-cases");
  expect(notices.at(-1)?.docs).toBe("docs/errors/OKM2011.md");
  expect(notices.at(-1)?.fix.summary).toContain("page()");

  await db.notes.find({ orderBy: ORDER, limit: d.find });
  await db.notes.find({ orderBy: ORDER }).all("walk");
  await db.notes.find({ where: { rank: 4 }, orderBy: ORDER });
  await db.notes.find({ where: { rank: lt(2) }, orderBy: ORDER });
  await db.notes.page({ orderBy: ORDER });
  expect(codes()).toEqual([find]);

  await db.notes.find({ where: { rank: 0 }, orderBy: ORDER, include: { comments: true } as never });
  expect(codes()).toEqual([find, include]);
  await db.notes.find({
    where: { rank: 0 },
    orderBy: ORDER,
    include: { comments: { limit: d.include } } as never,
  });
  await db.notes
    .find({ where: { rank: 0 }, orderBy: ORDER, include: { tags: true } as never })
    .all("walk");
  expect(codes()).toEqual([find, include]);

  await db.notes.aggregate({ groupBy: ["rank"], count: true });
  expect(codes()).toEqual([find, include, groupBy]);
  await db.notes.aggregate({ groupBy: ["rank"], count: true, limit: d.groupBy });
  expect(codes()).toHaveLength(3);

  const quiet: WarningNotice[] = [];
  const none = await make(undefined, quiet);
  await none.notes.find({ orderBy: ORDER, limit: d.find });
  expect(quiet.filter((n) => n.code === "OKM2011")).toEqual([]);
}

/**
 * Rows inserted while default reads run do not change what those reads return.
 *
 * @param make - Client factory
 * @param size - `limits.find`, below the seeded rows
 */
export async function concurrentInsert(make: MakeLimits, size: number): Promise<void> {
  const notices: WarningNotice[] = [];
  const db = await make({ find: size }, notices);
  const writer = await make(undefined, []);
  const inserts: Promise<unknown>[] = [];
  const reads: Promise<readonly { rank: number }[]>[] = [];
  for (let n = 10; n < 20; n++) {
    inserts.push(
      writer.notes.insert({ id: limitsKey("n", n), title: `late ${n}`, doc: "'late':1", rank: n }),
    );
    reads.push(db.notes.find({ orderBy: ORDER }));
  }
  await Promise.all(inserts);
  for (const rows of await Promise.all(reads)) {
    expect(rows.map((row) => row.rank)).toEqual(Array.from({ length: size }, (_, n) => n));
  }
  expect(await db.notes.count({})).toBe(15);
  expect(notices.filter((n) => n.code === "OKM2011")).toHaveLength(1);
  await writer.notes.delete({ where: { rank: gte(10) } }).all("cleanup");
}
