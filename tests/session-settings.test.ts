/**
 * `okmodel/session` without a server: PGlite is a real Postgres engine, and
 * the other dialect families refuse through the capability registry.
 */

import { expect, test } from "bun:test";

import type { DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { open } from "../src/adapters/pg/pglite.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { SESSION_SETTINGS, assertSessionSettings } from "../src/tooling/capabilities/index.js";

const USER_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const USER_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";

const ctx = sessionSettings({
  userId: { name: "app.user_id", type: "uuid", required: true },
  role: { name: "app.role", type: "text" },
  level: { name: "app.level", type: "int" },
  admin: { name: "app.admin", type: "bool" },
});

const notes = table("notes", {
  id: t.identity(),
  title: t.text(),
  actor: t.text().nullable(),
  level: t.text().nullable(),
});
const plain = schema({ casing: "snake", tables: [notes] });

const cnotes = table("cnotes", { id: t.identity(), title: t.text(), actor: t.text().nullable() });
const columned = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [cnotes],
});

const DDL = [
  `create table notes (
     id bigint generated always as identity primary key,
     title text not null,
     actor text default nullif(current_setting('app.user_id', true), ''),
     level text default nullif(current_setting('app.level', true), '')
   )`,
  `create table cnotes (
     id bigint generated always as identity primary key,
     tenant_id uuid not null,
     title text not null,
     actor text default nullif(current_setting('app.user_id', true), '')
   )`,
];

async function fresh(): Promise<DriverPool> {
  const pool = await open();
  for (const statement of DDL) await pool.execute(statement);
  return pool;
}

async function setting(pool: DriverPool, name: string): Promise<string | null> {
  const result: ExecuteResult = await pool.execute(`select current_setting('${name}', true)`);
  return result.rows[0]?.[0] ?? null;
}

async function rejected(run: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof OkmError ? error.code : String(error);
  }
  return undefined;
}

test("proof:session.local", async () => {
  const pool = await fresh();
  const db = await connect(pool, { schema: plain, session: ctx });
  try {
    const scoped = db.with({ userId: USER_A, level: 4 });
    const inside = await scoped.tx(async (tx) => tx.notes.insert({ title: "in a unit" }));
    expect(inside.actor).toBe(USER_A);
    expect(inside.level).toBe("4");
    expect(await setting(pool, "app.user_id")).toBe("");
    expect(await setting(pool, "app.level")).toBe("");

    let seen: string | null = null;
    const failed = await rejected(() =>
      scoped.tx(async (tx) => {
        seen = (await tx.notes.insert({ title: "rolled back" })).actor;
        throw new Error("undo");
      }),
    );
    expect(failed).toMatchObject({ message: "undo" });
    expect(seen === USER_A).toBe(true);
    expect(await setting(pool, "app.user_id")).toBe("");
    expect(await setting(pool, "app.level")).toBe("");
    const rows = await pool.execute("select title from notes order by id");
    expect(rows.rows.map((row) => row[0])).toEqual(["in a unit"]);
  } finally {
    await db.close();
  }
});

test("a savepoint rollback keeps the setting and a later write sets nothing again", async () => {
  const pool = await fresh();
  const texts: string[] = [];
  const reserve = pool.reserve?.bind(pool);
  if (reserve === undefined) throw new Error("PGlite reserves a connection");
  const spy: DriverPool = {
    ...pool,
    execute: (text, params, options) => {
      texts.push(text);
      return pool.execute(text, params, options);
    },
    reserve: async () => {
      const conn = await reserve();
      return {
        ...conn,
        execute: (text, params, options) => {
          texts.push(text);
          return conn.execute(text, params, options);
        },
        release: () => conn.release(),
      };
    },
    stats: () => pool.stats(),
    close: () => pool.close(),
  };
  const db = await connect(spy, { schema: plain, session: ctx });
  try {
    await db.connected;
    texts.length = 0;
    const actors: (string | null)[] = [];
    await db.with({ userId: USER_B }).tx(async (tx) => {
      expect(
        await rejected(() =>
          tx.tx(async (inner) => {
            actors.push((await inner.notes.insert({ title: "a" })).actor);
            throw new Error("undo");
          }),
        ),
      ).toMatchObject({ message: "undo" });
      actors.push((await tx.notes.insert({ title: "b" })).actor);
    });
    expect(actors).toEqual([USER_B, USER_B]);
    const sets = texts.filter((text) => text.startsWith("select set_config("));
    expect(sets).toHaveLength(1);
    expect(texts.findIndex((text) => text.startsWith("select set_config("))).toBeLessThan(
      texts.findIndex((text) => /^savepoint/i.test(text)),
    );
  } finally {
    await db.close();
  }
});

test("a declaration with a bad name, type, or flag is OKM1709", () => {
  const bad: readonly [string, unknown][] = [
    ["no dot", { a: { name: "user_id", type: "uuid" } }],
    ["tenant prefix", { a: { name: "app.tenant", type: "uuid" } }],
    ["tenant child", { a: { name: "app.tenant.id", type: "uuid" } }],
    ["unscoped", { a: { name: "app.unscoped", type: "text" } }],
    ["upper tenant", { a: { name: "APP.Tenant", type: "text" } }],
    ["plpgsql", { a: { name: "plpgsql.variable_conflict", type: "text" } }],
    ["pg_stat_statements", { a: { name: "pg_stat_statements.track", type: "text" } }],
    ["bad characters", { a: { name: "app.user-id", type: "text" } }],
    ["empty word", { a: { name: "app.", type: "text" } }],
    ["unknown type", { a: { name: "app.a", type: "date" } }],
    ["required false", { a: { name: "app.a", type: "text", required: false } }],
    ["twice", { a: { name: "app.a", type: "text" }, b: { name: "APP.a", type: "text" } }],
    ["not an object", { a: "app.a" }],
    ["array", []],
    ["null", null],
  ];
  for (const [label, input] of bad) {
    expect([label, code(() => sessionSettings(input as never))]).toEqual([label, "OKM1709"]);
  }
  expect(code(() => sessionSettings({ a: { name: "app.a", type: "int", required: true } }))).toBe(
    undefined,
  );
});

test("with() checks every value against its type before any statement", async () => {
  const pool = await fresh();
  let statements = 0;
  const counted: DriverPool = {
    ...pool,
    execute: (text, params, options) => {
      statements += 1;
      return pool.execute(text, params, options);
    },
    batch: (list, options) => {
      statements += 1;
      return pool.batch(list, options);
    },
    stats: () => pool.stats(),
    close: () => pool.close(),
  };
  const db = await connect(counted, { schema: plain, session: ctx });
  try {
    await db.connected;
    statements = 0;
    const attempts: readonly [string, () => unknown][] = [
      ["uuid text", () => db.with({ userId: "not a uuid" })],
      ["uuid number", () => db.with({ userId: 7 as unknown as string })],
      ["int fraction", () => db.with({ userId: USER_A, level: 1.5 })],
      ["int string", () => db.with({ userId: USER_A, level: "1" as unknown as number })],
      ["int unsafe", () => db.with({ userId: USER_A, level: 2 ** 60 })],
      ["bool string", () => db.with({ userId: USER_A, admin: "yes" as unknown as boolean })],
      ["text number", () => db.with({ userId: USER_A, role: 1 as unknown as string })],
      ["text nul", () => db.with({ userId: USER_A, role: "a\0b" })],
      ["unknown key", () => db.with({ userId: USER_A, other: "x" } as never)],
      ["required missing", () => db.with({ role: "x" } as never)],
      ["not an object", () => db.with("x" as never)],
    ];
    for (const [label, run] of attempts) expect([label, code(run)]).toEqual([label, "OKM1709"]);
    expect(statements).toBe(0);
  } finally {
    await db.close();
  }
});

test("OKM1709 says an int and a for every other setting type", async () => {
  const pool = await fresh();
  const db = await connect(pool, { schema: plain, session: ctx });
  try {
    const int = thrown(() => db.with({ userId: USER_A, level: "nope" as never }));
    expect(int.message).toBe("with() level is not an int.");
    expect(int.fix.summary).toBe("Pass an int for level.");
    const uuidError = thrown(() => db.with({ userId: "nope" }));
    expect(uuidError.message).toBe("with() userId is not a uuid.");
    expect(uuidError.fix.summary).toBe("Pass a uuid for userId.");
    const textError = thrown(() => db.with({ userId: USER_A, role: 1 as never }));
    expect(textError.message).toBe("with() role is not a text.");
    expect(textError.fix.summary).toBe("Pass a text for role.");
    const boolError = thrown(() => db.with({ userId: USER_A, admin: "yes" as never }));
    expect(boolError.message).toBe("with() admin is not a bool.");
    expect(boolError.fix.summary).toBe("Pass a bool for admin.");
  } finally {
    await db.close();
  }
});

function thrown(run: () => unknown): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a throw");
}

test("a client that never called with() refuses a statement before it reaches the driver", async () => {
  const pool = await fresh();
  let statements = 0;
  const seenTexts: string[] = [];
  const counted: DriverPool = {
    ...pool,
    execute: (text, params, options) => {
      statements += 1;
      seenTexts.push(text);
      return pool.execute(text, params, options);
    },
    stats: () => pool.stats(),
    close: () => pool.close(),
  };
  const db = await connect(counted, { schema: plain, session: ctx });
  try {
    await db.connected;
    statements = 0;
    seenTexts.length = 0;
    expect(await rejected(() => db.notes.find({ limit: 1 }))).toMatchObject({ code: "OKM1709" });
    expect(await rejected(() => db.notes.insert({ title: "x" }))).toMatchObject({
      code: "OKM1709",
    });
    expect(await rejected(() => db.tx(async () => 1))).toMatchObject({ code: "OKM1709" });
    expect(seenTexts).toEqual([]);
  } finally {
    await db.close();
  }
});

test("a setting that is optional and not given is not set, and with() calls merge", async () => {
  const pool = await fresh();
  const optional = sessionSettings({
    userId: { name: "app.user_id", type: "uuid" },
    level: { name: "app.level", type: "int" },
  });
  const db = await connect(pool, { schema: plain, session: optional });
  try {
    const bare = await db.notes.insert({ title: "bare" });
    expect(bare.actor).toBeNull();
    const merged = await db
      .with({ userId: USER_A })
      .with({ userId: USER_B, level: 2 })
      .notes.insert({ title: "merged" });
    expect(merged.actor).toBe(USER_B);
    expect(merged.level).toBe("2");
    const one = await db.with({ level: 9 }).notes.insert({ title: "one" });
    expect(one.actor).toBeNull();
    expect(one.level).toBe("9");
  } finally {
    await db.close();
  }
});

test("for(), with() and unscoped() compose in any order on column tenancy", async () => {
  const pool = await fresh();
  const db = await connect(pool, { schema: columned, session: ctx });
  try {
    const viaFor = db.for({ tenantId: TENANT }).with({ userId: USER_A });
    const viaWith = db.with({ userId: USER_B }).for({ tenantId: TENANT });
    expect((await viaFor.cnotes.insert({ title: "one" })).actor).toBe(USER_A);
    expect((await viaWith.cnotes.insert({ title: "two" })).actor).toBe(USER_B);
    const first = await db.with({ userId: USER_A }).unscoped("audit").cnotes.find({ limit: 10 });
    const second = await db.unscoped("audit").with({ userId: USER_A }).cnotes.find({ limit: 10 });
    expect(first.map((row) => row.title).sort()).toEqual(["one", "two"]);
    expect(second).toHaveLength(2);
    expect(code(() => db.for({ tenantId: TENANT }).with({ role: "x" } as never))).toBe("OKM1709");
  } finally {
    await db.close();
  }
});

test("values with quotes and unicode travel as parameters", async () => {
  const pool = await fresh();
  const texty = sessionSettings({ who: { name: "app.user_id", type: "text" } });
  const db = await connect(pool, { schema: plain, session: texty });
  try {
    const hostile = `x'); drop table notes; --é`;
    const row = await db.with({ who: hostile }).notes.insert({ title: "still here" });
    expect(row.actor).toBe(hostile);
    const count = await pool.execute("select count(*) from notes");
    expect(count.rows[0]?.[0]).toBe("1");
  } finally {
    await db.close();
  }
});

test("mysql and sqlite refuse sessionSettings with the tenancy alternative", () => {
  expect(SESSION_SETTINGS).toEqual({ postgres: "transaction", mysql: "session", sqlite: "none" });
  expect(() => assertSessionSettings("postgres")).not.toThrow();
  for (const dialect of ["mysql", "sqlite"] as const) {
    let caught: unknown;
    try {
      assertSessionSettings(dialect);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OkmError);
    if (!(caught instanceof OkmError)) continue;
    expect(caught.code).toBe("OKM1860");
    expect(caught.message).toContain(
      "This dialect has no transaction-local settings; use column, composite or path tenancy.",
    );
    expect(caught.message).toContain(dialect);
  }
});
