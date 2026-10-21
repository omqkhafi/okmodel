/**
 * Typed `raw(db, sql, params)` on a fake pool: lookup, bind, decode, routing,
 * tenancy, and the lock sources. Real rows are `raw-typed-pg.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DriverPool, ExecuteOptions } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { raw, registerRawLock, schema, t, table, trusted } from "../src/dialects/pg/index.js";
import { rawStatementKey } from "../src/dialects/pg/raw-key.js";
import { RAW_STALE, type RawLockStatement } from "../src/dialects/pg/raw-lock.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { registerRule } from "../src/runtime/safety/index.js";
import type { ObserveEvent } from "../src/runtime/observe-types.js";
import { ERROR_DOCS } from "../src/tooling/errors/registry.js";

const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const MOODS = ["open", "closed"] as const;

const READ =
  "select id, title, done, big, meta, mood, moods, note from tasks where id = $1 and mood = $2";
const WRITE = "insert into tasks (id, meta, mood, big) values ($1, $2, $3, $4)";
const RETURNING = "update tasks set title = $1 returning id";
const MISSING = "select 1 from tasks";

const STATEMENTS: Record<string, RawLockStatement> = {
  [READ]: {
    sql: READ,
    kind: "read",
    params: [{ pgType: "integer" }, { pgType: "mood", enumLabels: MOODS }],
    columns: [
      { name: "id", pgType: "integer", nullable: false },
      { name: "title", pgType: "text", nullable: false },
      { name: "done", pgType: "boolean", nullable: false },
      { name: "big", pgType: "bigint", nullable: false },
      { name: "meta", pgType: "jsonb", nullable: false },
      { name: "mood", pgType: "mood", nullable: false, enumLabels: MOODS },
      { name: "moods", pgType: "mood[]", nullable: false, enumLabels: MOODS },
      { name: "note", pgType: "text", nullable: true },
    ],
  },
  [WRITE]: {
    sql: WRITE,
    kind: "write",
    params: [
      { pgType: "integer" },
      { pgType: "jsonb" },
      { pgType: "mood", enumLabels: MOODS },
      { pgType: "bigint" },
    ],
    columns: [],
  },
  [RETURNING]: {
    sql: RETURNING,
    kind: "write",
    params: [{ pgType: "text" }],
    columns: [{ name: "id", pgType: "integer", nullable: false }],
  },
};

function lockOf(statements: Record<string, RawLockStatement>): object {
  const keyed: Record<string, RawLockStatement> = {};
  for (const [sql, statement] of Object.entries(statements))
    keyed[rawStatementKey(sql)] = statement;
  return { version: 1, dialect: "postgres", catalogHash: "h", statements: keyed };
}

type Call = {
  readonly text: string;
  readonly params: readonly (string | null)[] | undefined;
  readonly options: ExecuteOptions | undefined;
};

function recording(
  calls: Call[],
  rows: readonly (readonly (string | null)[])[] = [],
  reported: number | null = null,
): DriverPool {
  return {
    capabilities: { transactions: "none", stream: false, listen: false, cancel: false },
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
    execute(text, params, options) {
      calls.push({ text, params: params as Call["params"], options });
      if (text.startsWith("select current_setting")) {
        return Promise.resolve({
          rows: [["170000", "PostgreSQL 17.1", null]],
          count: 1,
          notices: [],
        });
      }
      return Promise.resolve({ rows, count: rows.length, reported, notices: [] });
    },
    batch: () => Promise.resolve([]),
  };
}

const READ_ROW = [
  "7",
  "hello",
  "t",
  "9007199254740993",
  '{"a":[1,2]}',
  "open",
  "{open,closed}",
  null,
] as const;

const plain = schema({
  casing: "snake",
  codecs: { bigint: "bigint" },
  tables: [table("tasks", { id: t.integer().primaryKey(), title: t.text() })],
});

const tenant = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [table("tasks", { id: t.integer().primaryKey(), title: t.text() })],
});

const run = raw as unknown as (
  db: object,
  sql: string,
  params: unknown,
) => Promise<readonly Record<string, unknown>[]>;

async function thrown(work: () => Promise<unknown>): Promise<OkmError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) return error;
  }
  throw new Error("expected OkmError");
}

async function open(
  options: { readonly rows?: readonly (readonly (string | null)[])[]; readonly dir?: string } = {},
) {
  const calls: Call[] = [];
  const db = connect(recording(calls, options.rows ?? [READ_ROW]), {
    schema: plain,
    ...(options.dir !== undefined ? { catalogDir: options.dir } : {}),
  });
  await db.connected;
  calls.length = 0;
  return { db, calls };
}

function lockDir(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "okm-raw-typed-"));
  writeFileSync(join(dir, "raw.lock.json"), text);
  return dir;
}

afterEach(() => registerRawLock(undefined));

test("a typed read encodes parameters, decodes columns, and keeps the read route", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const { db, calls } = await open();
  const rows = await run(db, READ, [7, "open"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.text).toBe(READ);
  expect(calls[0]?.params).toEqual(["7", "open"]);
  expect(calls[0]?.options?.route).toBeUndefined();
  expect(rows).toEqual([
    {
      id: 7,
      title: "hello",
      done: true,
      big: 9007199254740993n,
      meta: { a: [1, 2] },
      mood: "open",
      moods: ["open", "closed"],
      note: null,
    },
  ]);
});

test("a typed write encodes each type and runs on the primary", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const { db, calls } = await open({ rows: [] });
  const rows = await run(db, WRITE, [1, { a: [1] }, "closed", 5n]);
  expect(rows).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.params).toEqual(["1", '{"a":[1]}', "closed", "5"]);
  expect(calls[0]?.options?.route).toBe("primary");
});

test("a null parameter is SQL null and an undefined one is refused", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const { db, calls } = await open({ rows: [] });
  await run(db, RETURNING, [null]);
  expect(calls[0]?.params).toEqual([null]);
  const error = await thrown(() => run(db, RETURNING, [undefined]));
  expect(error.code).toBe("OKM1210");
  expect(error.message).toContain("$1");
});

test("the wrong parameter count is OKM1602 and nothing is sent", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const { db, calls } = await open();
  const few = await thrown(() => run(db, READ, [7]));
  expect(few.code).toBe("OKM1602");
  expect(few.message).toContain("2 parameters");
  expect(few.message).toContain("Received 1");
  const none = await thrown(() => run(db, READ, undefined));
  expect(none.code).toBe("OKM1602");
  const many = await thrown(() => run(db, WRITE, [1, 2, 3, 4, 5]));
  expect(many.message).toContain("4 parameters");
  expect(calls).toEqual([]);
});

test("a value a codec rejects names the parameter", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const { db, calls } = await open();
  const label = await thrown(() => run(db, READ, [7, "archived"]));
  expect(label.code).toBe("OKM1210");
  expect(label.message).toContain("$2");
  const integer = await thrown(() => run(db, READ, [1.5, "open"]));
  expect(integer.message).toContain("$1");
  expect(calls).toEqual([]);
});

test("a statement missing from the lock is OKM1601 with the sync fix", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const { db, calls } = await open();
  const error = await thrown(() => run(db, MISSING, []));
  expect(error.code).toBe("OKM1601");
  expect(error.fix.summary).toBe(RAW_STALE.fix);
  expect(error.fix.summary).toContain("okm raw sync");
  expect(error.message).toContain(MISSING);
  expect(calls).toEqual([]);
});

test("the OKM1601 doctor page and the runtime share one fix", () => {
  const doc = ERROR_DOCS.find((item) => item.code === "OKM1601");
  expect(doc?.fix).toBe(RAW_STALE.fix);
  expect(doc?.summary).toBe(RAW_STALE.summary);
});

test("the lock file is read from catalogDir on the first call and not again", async () => {
  const dir = lockDir(JSON.stringify(lockOf(STATEMENTS)));
  const { db, calls } = await open({ dir });
  const rows = await run(db, READ, [7, "open"]);
  expect(rows[0]?.id).toBe(7);
  writeFileSync(join(dir, "raw.lock.json"), "not json");
  expect((await run(db, READ, [7, "open"]))[0]?.id).toBe(7);
  expect(calls).toHaveLength(2);
});

test("a missing lock file and a lock that does not parse are OKM1601", async () => {
  const empty = mkdtempSync(join(tmpdir(), "okm-raw-typed-"));
  const absent = await open({ dir: empty });
  const missing = await thrown(() => run(absent.db, READ, [7, "open"]));
  expect(missing.code).toBe("OKM1601");
  expect(missing.message).toContain("raw.lock.json is missing");
  expect(missing.fix.summary).toContain("okm raw sync");
  const garbage = await open({ dir: lockDir("{") });
  const broken = await thrown(() => run(garbage.db, READ, [7, "open"]));
  expect(broken.code).toBe("OKM1601");
  expect(broken.message).toContain("not valid JSON");
  const wrong = await open({ dir: lockDir(JSON.stringify({ version: 2 })) });
  const shape = await thrown(() => run(wrong.db, READ, [7, "open"]));
  expect(shape.code).toBe("OKM1601");
  expect(absent.calls.concat(garbage.calls, wrong.calls)).toEqual([]);
});

test("registerRawLock needs no file, wins over the file, and refuses a bad value", async () => {
  const dir = lockDir("{");
  const { db } = await open({ dir });
  registerRawLock(lockOf(STATEMENTS));
  expect((await run(db, READ, [7, "open"]))[0]?.id).toBe(7);
  expect(() => registerRawLock({ version: 1 })).toThrow(OkmError);
  try {
    registerRawLock("nope");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1601");
      expect(error.fix.summary).toContain("okm raw sync");
    }
  }
});

test("a lock that no longer matches the result is OKM1601", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const wide = await open({ rows: [[...READ_ROW, "extra"]] });
  const width = await thrown(() => run(wide.db, READ, [7, "open"]));
  expect(width.code).toBe("OKM1601");
  expect(width.message).toContain("9 columns");
  const drifted = await open({
    rows: [["7", "hello", "maybe", "1", "{}", "open", "{open}", null]],
  });
  const decode = await thrown(() => run(drifted.db, READ, [7, "open"]));
  expect(decode.code).toBe("OKM1601");
  expect(decode.message).toContain("done");
  expect(decode.message).toContain("boolean");
  expect(decode.cause).toBeInstanceOf(OkmError);
});

test("a column named __proto__ is an own property", async () => {
  const sql = 'select 1 as "__proto__"';
  registerRawLock(
    lockOf({
      [sql]: {
        sql,
        kind: "read",
        params: [],
        columns: [{ name: "__proto__", pgType: "integer", nullable: false }],
      },
    }),
  );
  const { db } = await open({ rows: [["3"]] });
  const [row] = await run(db, sql, []);
  expect(Object.keys(row ?? {})).toEqual(["__proto__"]);
  expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
});

test("a tenant client and the root client of a tenant schema refuse typed raw", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const calls: Call[] = [];
  const db = connect(recording(calls, [READ_ROW]), { schema: tenant });
  await db.connected;
  calls.length = 0;
  const scoped = db.for({ tenantId: TENANT });
  const refused = await thrown(() => run(scoped, READ, [7, "open"]));
  expect(refused.code).toBe("OKM1702");
  expect(refused.fix.summary).toContain("trusted");
  const root = await thrown(() => run(db, READ, [7, "open"]));
  expect(root.code).toBe("OKM1702");
  expect(calls).toEqual([]);
});

test("trusted() runs typed raw on a tenant client and shows its reason", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const hatches: { readonly name: string; readonly reason: string }[] = [];
  const unregister = registerRule({
    name: "see-hatches",
    contribution: "test",
    check(input) {
      for (const hatch of input.hatches ?? []) hatches.push(hatch);
      return [];
    },
  });
  const events: ObserveEvent[] = [];
  const calls: Call[] = [];
  const db = connect(recording(calls, [], 1), {
    schema: tenant,
    onWrite: (event) => {
      events.push(event);
    },
  });
  try {
    await db.connected;
    calls.length = 0;
    const scoped = db.for({ tenantId: TENANT });
    const open = trusted(scoped, "  nightly backfill  ");
    await run(open, WRITE, [1, {}, "open", 1n]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.route).toBe("primary");
    expect(hatches).toEqual([{ name: "trusted", reason: "nightly backfill" }]);
    const write = events.find((event) => event.type === "write");
    expect(write).toMatchObject({
      type: "write",
      table: null,
      op: "raw",
      source: "raw",
      tenant: null,
      rowCount: 1,
      tag: "trusted: nightly backfill",
    });
    const stillRefused = await thrown(() => run(scoped, WRITE, [1, {}, "open", 1n]));
    expect(stillRefused.code).toBe("OKM1702");
  } finally {
    unregister();
  }
});

test("trusted() needs a reason", () => {
  const db = { tasks: {} };
  for (const reason of ["", "   ", undefined as unknown as string]) {
    try {
      trusted(db, reason);
      throw new Error("expected OKM1702");
    } catch (error) {
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) expect(error.code).toBe("OKM1702");
    }
  }
});

test("an unscoped client may run typed raw, and its reason is a hatch", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const hatches: { readonly name: string; readonly reason: string }[] = [];
  const unregister = registerRule({
    name: "see-hatches-unscoped",
    contribution: "test",
    check(input) {
      for (const hatch of input.hatches ?? []) hatches.push(hatch);
      return [];
    },
  });
  try {
    const calls: Call[] = [];
    const db = connect(recording(calls, [READ_ROW]), { schema: tenant });
    await db.connected;
    const rows = await run(db.unscoped("support lookup"), READ, [7, "open"]);
    expect(rows).toHaveLength(1);
    expect(hatches).toEqual([{ name: "unscoped", reason: "support lookup" }]);
  } finally {
    unregister();
  }
});

test("a schema with no tenancy has no restriction and a read emits no write event", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const events: ObserveEvent[] = [];
  const calls: Call[] = [];
  const db = connect(recording(calls, [READ_ROW]), {
    schema: plain,
    onWrite: (event) => {
      events.push(event);
    },
  });
  await db.connected;
  expect(await run(db, READ, [7, "open"])).toHaveLength(1);
  expect(events).toEqual([]);
});

test("a typed write is a raw event with a returned row count when it has RETURNING", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const events: ObserveEvent[] = [];
  const calls: Call[] = [];
  const db = connect(recording(calls, [["9"]], 1), {
    schema: plain,
    onWrite: (event) => {
      events.push(event);
    },
  });
  await db.connected;
  expect(await run(db, RETURNING, ["x"])).toEqual([{ id: 9 }]);
  const write = events.find((event) => event.type === "write");
  expect(write).toMatchObject({
    table: null,
    op: "raw",
    source: "raw",
    rowCount: 1,
    rowCountMode: "returned",
  });
  expect(write && "tag" in write).toBe(false);
});

test("raw takes the client, a table handle, or a tenant client from tx and for", async () => {
  registerRawLock(lockOf(STATEMENTS));
  const { db } = await open();
  expect(await run((db as unknown as { tasks: object }).tasks, READ, [7, "open"])).toHaveLength(1);
  const error = await thrown(() => run({}, READ, [7, "open"]));
  expect(error.code).toBe("OKM1602");
});
