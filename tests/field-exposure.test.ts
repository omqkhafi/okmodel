/**
 * Guarded, hidden, and sensitive fields, and input stripping.
 *
 * Hidden columns stay out of default reads and includes. Sensitive values
 * stay out of inspect output and errors. Unknown input keys are dropped.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { many, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const SECRET = "secret-value-should-not-leak";

const users = table(
  "users",
  {
    id: uuid().primaryKey(),
    email: text(),
    role: text().guarded(),
    passwordHash: text().hidden().sensitive(),
  },
  { relations: { sessions: many("sessions") } },
);

const sessions = table(
  "sessions",
  {
    id: uuid().primaryKey(),
    userId: uuid().references("users"),
    token: text().sensitive(),
  },
  { relations: { user: one("users") } },
);

const app = schema({ casing: "snake", tables: [users, sessions] });

async function expectHidden(pending: PromiseLike<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1120");
      expect(error.fix.summary).toContain("hidden({ filterable: true })");
    }
    return;
  }
  throw new Error("expected OKM1120");
}

async function expectCode(pending: PromiseLike<unknown>, code: string): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

const DDL = [
  `create table users (
    id uuid primary key,
    email text not null,
    role text not null default 'member',
    password_hash text not null unique
  )`,
  `create table sessions (
    id uuid primary key,
    user_id uuid not null references users (id),
    token text not null
  )`,
];

test("reads omit hidden fields, writes strip input, and inspect redacts", async () => {
  const pool = await openPglite();
  try {
    for (const statement of DDL) await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    await db.connected;

    const inserted = await db.users.insert({
      id: USER,
      email: "a@b.c",
      passwordHash: SECRET,
      extra: true,
    } as never);
    expect(inserted.email).toBe("a@b.c");
    expect(inserted.role).toBe("member");
    expect("passwordHash" in inserted).toBe(false);
    expect("extra" in inserted).toBe(false);

    await expectCode(
      db.users.insert({ id: USER, email: "b@b.c", passwordHash: "x", role: "admin" } as never),
      "OKM1190",
    );

    const allowed = await db.users.insert(
      { id: SESSION, email: "b@b.c", passwordHash: "other-secret-value", role: "admin" },
      { allow: ["role"] },
    );
    expect(allowed.role).toBe("admin");

    const found = await db.users.find({ where: { email: "a@b.c" }, limit: 1 });
    expect(found).toEqual([{ id: USER, email: "a@b.c", role: "member" }]);
    expect(JSON.stringify(found).includes(SECRET)).toBe(false);

    const selected = (await db.users.find({
      select: ["passwordHash"] as never,
      where: { id: USER },
      limit: 1,
    })) as readonly Record<string, unknown>[];
    expect(selected[0]?.passwordHash).toBe(SECRET);

    await db.sessions.insert({ id: SESSION, userId: USER, token: "session-secret-value" });
    const tokenView = await db.sessions
      .find({ where: { token: "session-secret-value" }, limit: 1 })
      .inspect();
    expect(tokenView.sql.params).toContain("[redacted]");
    expect(JSON.stringify(tokenView).includes("session-secret-value")).toBe(false);
    const included = await db.sessions.find({
      where: { id: SESSION },
      include: { user: { select: ["passwordHash"] as never } },
      limit: 1,
    });
    expect(JSON.stringify(included).includes(SECRET)).toBe(false);
    expect(JSON.stringify(included).includes("passwordHash")).toBe(false);

    const described = await db.users.find({ where: { email: "a@b.c" }, limit: 1 }).inspect();
    expect(JSON.stringify(described).includes(SECRET)).toBe(false);
    expect(
      described.rules.some((rule) => rule.contribution.includes("passwordHash excluded")),
    ).toBe(true);

    await expectHidden(db.users.find({ where: { passwordHash: SECRET } as never, limit: 1 }));
    await expectHidden(db.users.find({ orderBy: { passwordHash: "asc" } as never, limit: 1 }));

    const logged: string[] = [];
    const failing = await connectPglite(pool, {
      schema: app,
      logger: {
        error(entry) {
          logged.push(entry.summary);
        },
      },
    });
    const caught = await failing.users
      .insert({
        id: "33333333-3333-4333-8333-333333333333",
        email: "c@b.c",
        passwordHash: SECRET,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(caught).toBeInstanceOf(OkmError);
    if (caught instanceof OkmError) expect(caught.message.includes(SECRET)).toBe(false);
    expect(logged.join("\n").includes(SECRET)).toBe(false);
    await failing.close();

    await db.users.update({ where: { id: USER }, set: { email: "c@b.c", nope: 1 } as never });
    expect((await db.users.one({ where: { id: USER } }))?.email).toBe("c@b.c");
    await expectCode(
      db.users.update({ where: { id: USER }, set: { role: "owner" } as never }),
      "OKM1190",
    );
    await db.users.update({ where: { id: USER }, set: { role: "owner" } }, { allow: ["role"] });
    expect((await db.users.one({ where: { id: USER } }))?.role).toBe("owner");

    expect(() => users.filters({ allow: { passwordHash: ["eq"] } })).toThrow(OkmError);
    expect(() => users.filters({ sort: ["passwordHash"] })).toThrow(OkmError);
    expect(() => sessions.filters({ relations: { user: ["passwordHash"] } })).toThrow(OkmError);
    try {
      users.filters({ allow: { passwordHash: ["eq"] } });
    } catch (error) {
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1123");
        expect(error.message.includes(SECRET)).toBe(false);
      }
    }

    const parsed = await users.filters({ allow: { email: ["eq"] }, sort: ["email"] }).parse({
      email: "a@b.c",
      sort: "email",
    });
    expect(parsed).toEqual({ where: { email: "a@b.c" }, orderBy: { email: "asc" } });

    await db.close();
  } finally {
    await pool.close();
  }
});
