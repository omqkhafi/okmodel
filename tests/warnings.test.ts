/**
 * Static warning rules: a positive case, a nearby silent case, levels, and ignore.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import {
  between,
  id,
  inList,
  many,
  notIn,
  one,
  or,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { WARNING_RULES } from "../src/runtime/warnings/catalog.js";
import type { WarningOptions } from "../src/runtime/warnings/config.js";
import { warnings, type WarningNotice } from "../src/runtime/warnings/index.js";
import { developmentLevel } from "../src/runtime/warnings/level.js";

const replies = table("replies", {
  id: id({ default: "none" }),
  commentId: uuid().references("comments"),
  body: text(),
});

const comments = table(
  "comments",
  {
    id: id({ default: "none" }),
    noteId: uuid().references("notes"),
    body: text(),
  },
  { relations: { replies: many("replies", "commentId") } },
);

const edits = table("edits", {
  id: id({ default: "none" }),
  noteId: uuid().references("notes"),
  body: text(),
});

const users = table("users", {
  id: id({ default: "none" }),
  name: text(),
});

const notes = table(
  "notes",
  {
    id: id({ default: "none" }),
    title: text().unique(),
    body: text(),
    authorId: uuid().references("users"),
  },
  {
    relations: {
      comments: many("comments", "noteId"),
      edits: many("edits", "noteId"),
      author: one("users", "authorId"),
    },
  },
);

const app = schema({
  tables: [users, replies, comments, edits, notes],
});

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

function db(options?: WarningOptions) {
  return connect(pool, {
    schema: app,
    warnings: warnings({ env: "development", ...options }),
  });
}

async function capture(run: () => Promise<void>): Promise<readonly string[]> {
  const lines: string[] = [];
  const previous = console.warn;
  console.warn = (...args: readonly unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
    return lines;
  } finally {
    console.warn = previous;
  }
}

function expectRule(lines: readonly string[], code: string): void {
  const hit = lines.find((line) => line.startsWith(code));
  expect(hit, lines.join("\n")).toBeDefined();
  expect(hit).toContain(`docs/errors/${code}.md`);
  expect(hit).toContain("Fix:");
  expect(hit).toContain("at ");
}

test("each rule default matches its development severity", () => {
  expect(developmentLevel("low")).toBe("hint");
  expect(developmentLevel("medium")).toBe("warn");
  expect(developmentLevel("high")).toBe("warn");
  for (const rule of WARNING_RULES) expect(rule.defaultLevel).toBe(developmentLevel(rule.severity));
});

test("OKM2004 warns past 1,000 and stays silent at 1,000 and on page()", async () => {
  const client = db();
  const deep = await capture(async () => {
    await client.notes
      .find({ limit: 1, offset: 1001, orderBy: { id: "asc" } })
      .catch(() => undefined);
  });
  expectRule(deep, "OKM2004");
  const edge = await capture(async () => {
    await client.notes
      .find({ limit: 1, offset: 1000, orderBy: { id: "asc" } })
      .catch(() => undefined);
  });
  expect(edge.join("\n")).not.toContain("OKM2004");
  const paged = await capture(async () => {
    await client.notes.page({ limit: 1 }).catch(() => undefined);
  });
  expect(paged.join("\n")).not.toContain("OKM2004");
  expect(paged.join("\n")).not.toContain("OKM2005");
});

test("OKM2005 warns when the order does not end in a unique key", async () => {
  const client = db();
  const missing = await capture(async () => {
    await client.notes.find({ limit: 2 }).catch(() => undefined);
  });
  expectRule(missing, "OKM2005");
  const trailing = await capture(async () => {
    await client.notes
      .find({ limit: 2, orderBy: { id: "asc", body: "asc" } })
      .catch(() => undefined);
  });
  expectRule(trailing, "OKM2005");
  const byId = await capture(async () => {
    await client.notes
      .find({ limit: 2, orderBy: { body: "asc", id: "desc" } })
      .catch(() => undefined);
  });
  expect(byId.join("\n")).not.toContain("OKM2005");
  const byTitle = await capture(async () => {
    await client.notes.find({ limit: 2, orderBy: { title: "asc" } }).catch(() => undefined);
  });
  expect(byTitle.join("\n")).not.toContain("OKM2005");
});

test("OKM2007 warns on a value list past 500 and stays silent at 500", async () => {
  const client = db();
  const values = Array.from({ length: 501 }, (_, index) => String(index));
  const listed = await capture(async () => {
    await client.notes
      .find({ where: { title: inList(values) }, limit: 1, orderBy: { id: "asc" } })
      .catch(() => undefined);
  });
  expectRule(listed, "OKM2007");
  const excluded = await capture(async () => {
    await client.notes
      .find({ where: { title: notIn(values) }, limit: 1, orderBy: { id: "asc" } })
      .catch(() => undefined);
  });
  expectRule(excluded, "OKM2007");
  const edge = Array.from({ length: 500 }, (_, index) => String(index));
  const quiet = await capture(async () => {
    await client.notes
      .find({
        where: or([{ title: inList(edge) }, { title: between("a", "z") }]),
        limit: 1,
        orderBy: { id: "asc" },
      })
      .catch(() => undefined);
  });
  expect(quiet.join("\n")).not.toContain("OKM2007");
});

test("OKM2008 warns when an include product passes 10,000", async () => {
  const client = db();
  const wide = await capture(async () => {
    await client.notes
      .find({ limit: 101, orderBy: { id: "asc" }, include: { comments: { limit: 100 } } })
      .catch(() => undefined);
  });
  expectRule(wide, "OKM2008");
  const nested = await capture(async () => {
    await client.notes
      .find({
        limit: 10,
        orderBy: { id: "asc" },
        include: { comments: { limit: 100, include: { replies: { limit: 11 } } } },
      })
      .catch(() => undefined);
  });
  expectRule(nested, "OKM2008");
  const edge = await capture(async () => {
    await client.notes
      .find({ limit: 100, orderBy: { id: "asc" }, include: { comments: { limit: 100 } } })
      .catch(() => undefined);
  });
  expect(edge.join("\n")).not.toContain("OKM2008");
  const siblings = await capture(async () => {
    await client.notes
      .find({
        limit: 100,
        orderBy: { id: "asc" },
        include: { comments: { limit: 100 }, edits: { limit: 100 } },
      })
      .catch(() => undefined);
  });
  expect(siblings.join("\n")).not.toContain("OKM2008");
  const nestedEdge = await capture(async () => {
    await client.notes
      .find({
        limit: 10,
        orderBy: { id: "asc" },
        include: { comments: { limit: 100, include: { replies: { limit: 10 } } } },
      })
      .catch(() => undefined);
  });
  expect(nestedEdge.join("\n")).not.toContain("OKM2008");
  const toOne = await capture(async () => {
    await client.notes
      .find({ limit: 10000, orderBy: { id: "asc" }, include: { author: true } })
      .catch(() => undefined);
  });
  expect(toOne.join("\n")).not.toContain("OKM2008");
  const toOneWide = await capture(async () => {
    await client.notes
      .find({ limit: 10001, orderBy: { id: "asc" }, include: { author: true } })
      .catch(() => undefined);
  });
  expectRule(toOneWide, "OKM2008");
  const unbounded = await capture(async () => {
    await client.notes
      .find({ orderBy: { id: "asc" }, include: { comments: { limit: 100 } } })
      .all("export")
      .catch(() => undefined);
  });
  expect(unbounded.join("\n")).not.toContain("OKM2008");
  const missing = await capture(async () => {
    await client.notes
      .find({
        limit: 10,
        orderBy: { id: "asc" },
        include: { comments: true },
      } as never)
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(OkmError);
        expect((error as OkmError).code).toBe("OKM1105");
      });
  });
  expect(missing.join("\n")).not.toContain("OKM2008");
});

test("a level override and production silence", async () => {
  const hinted = db({ levels: { "deep-offset": "hint" } });
  const hint = await capture(async () => {
    await hinted.notes
      .find({ limit: 1, offset: 1001, orderBy: { id: "asc" } })
      .catch(() => undefined);
  });
  expect(hint[0]).toContain("OKM2004 hint:");
  const off = db({ levels: { "unordered-limit": "off" } });
  const quiet = await capture(async () => {
    await off.notes.find({ limit: 2 }).catch(() => undefined);
  });
  expect(quiet.join("\n")).not.toContain("OKM2005");
  const prod = db({ env: "production" });
  const silenced = await capture(async () => {
    await prod.notes.find({ limit: 2, offset: 1001 }).catch(() => undefined);
  });
  expect(silenced).toEqual([]);
  const forced = db({ env: "production", levels: { "unordered-limit": "warn" } });
  const still = await capture(async () => {
    await forced.notes.find({ limit: 2 }).catch(() => undefined);
  });
  expectRule(still, "OKM2005");
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const fromEnv = connect(pool, { schema: app, warnings: warnings() });
    const lines = await capture(async () => {
      await fromEnv.notes.find({ limit: 2, offset: 2000 }).catch(() => undefined);
    });
    expect(lines).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("error throws on every evaluation and names the fix", async () => {
  const client = db({ levels: { "unordered-limit": "error" } });
  const fire = () => client.notes.find({ limit: 3 });
  const first = await fire().catch((error: unknown) => error);
  const second = await fire().catch((error: unknown) => error);
  expect(first).toBeInstanceOf(OkmError);
  expect(second).toBeInstanceOf(OkmError);
  const error = first as OkmError;
  expect(error.code).toBe("OKM2005");
  expect(error.kind).toBe("invalid");
  expect(error.fix.summary).toContain("orderBy");
  expect((second as OkmError).code).toBe("OKM2005");
});

test("ignore needs a reason and suppresses only the named rule", async () => {
  const client = db();
  const missing = await client.notes
    .find({ limit: 1, orderBy: { id: "asc" }, ignore: { rule: "deep-offset", reason: " " } })
    .catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(OkmError);
  expect((missing as OkmError).code).toBe("invalid");
  expect((missing as OkmError).message).toContain("reason");
  const ignored = await capture(async () => {
    await client.notes
      .find({ limit: 2, ignore: { rule: "unordered-limit", reason: "one row" } })
      .catch(() => undefined);
  });
  expect(ignored.join("\n")).not.toContain("OKM2005");
  const stale = await capture(async () => {
    await client.notes
      .find({ limit: 2, ignore: { rule: "not-yet", reason: "later" } })
      .catch(() => undefined);
  });
  expectRule(stale, "OKM2005");
  const configured = db({ ignore: [{ rule: "wide-fan-out", reason: "tenant cap" }] });
  const capped = await capture(async () => {
    await configured.notes
      .find({ limit: 101, orderBy: { id: "asc" }, include: { comments: { limit: 100 } } })
      .catch(() => undefined);
  });
  expect(capped.join("\n")).not.toContain("OKM2008");
});

test("onWarning replaces the console and repeats once per call site", async () => {
  const notices: WarningNotice[] = [];
  const client = db({
    onWarning(notice) {
      notices.push(notice);
    },
  });
  const lines = await capture(async () => {
    for (let time = 0; time < 2; time += 1) {
      await client.notes.find({ limit: 4 }).catch(() => undefined);
    }
  });
  expect(lines).toEqual([]);
  expect(notices).toHaveLength(1);
  const notice = notices[0];
  if (notice === undefined) throw new Error("missing notice");
  expect(notice.code).toBe("OKM2005");
  expect(notice.kind).toBe("invalid");
  expect(notice.category).toBe("input");
  expect(notice.level).toBe("warn");
  expect(notice.severity).toBe("high");
  expect(notice.rule).toBe("unordered-limit");
  expect(notice.retryable).toBe(false);
  expect(notice.docs).toBe("docs/errors/OKM2005.md");
  expect(notice.location?.file).toContain("warnings.test.ts");
});

test("find emits offset after limit", async () => {
  const client = connect(pool, { schema: app });
  const sql = await Promise.resolve(
    client.notes.find({ limit: 1, offset: 5, orderBy: { id: "asc" } }).sql(),
  );
  expect(sql.text.indexOf(" limit ")).toBeLessThan(sql.text.indexOf(" offset "));
  const bad = await client.notes
    .find({ limit: 1, offset: -1, orderBy: { id: "asc" } })
    .catch((error: unknown) => error);
  expect(bad).toBeInstanceOf(OkmError);
  expect((bad as OkmError).message).toBe("offset must be an integer from 0 up.");
});
