/**
 * A sensitive codec rejection on a read keeps the value out of the error.
 *
 * Write-side encode already says `Field <field> was rejected.` Read where,
 * operators, and update/delete where use the same helper.
 */

import { expect, test } from "bun:test";
import { inspect } from "node:util";

import { open } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { inList, integer, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { explainWrite } from "../src/runtime/write.js";

const SECRET = "SECRET-where";

const sessions = table("sessions", {
  id: text().primaryKey(),
  token: integer().sensitive(),
  plain: integer(),
  label: text(),
});

const app = schema({ tables: [sessions] });

function leakNowhere(error: OkmError, value: string): void {
  expect(error.message).toBe("Field token was rejected.");
  expect(error.code).toBe("OKM1210");
  expect(error.message.includes(value)).toBe(false);
  expect(JSON.stringify(error.toHttp()).includes(value)).toBe(false);
  expect(JSON.stringify(error.log()).includes(value)).toBe(false);
  expect(inspect(error, { depth: 10 }).includes(value)).toBe(false);
  expect(inspect(error.cause, { depth: 10 }).includes(value)).toBe(false);
}

async function rejection(run: () => Promise<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

async function withDb<T>(run: (db: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const pool = await open();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connect(pool, { schema: app });
    try {
      return await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await pool.close();
  }
}

test("read where, operators, and write where redact a sensitive codec rejection", async () => {
  await withDb(async (db) => {
    leakNowhere(
      await rejection(() => db.sessions.find({ where: { token: SECRET }, limit: 1 })),
      SECRET,
    );
    leakNowhere(await rejection(() => db.sessions.one({ where: { token: SECRET } })), SECRET);
    leakNowhere(await rejection(() => db.sessions.count({ where: { token: SECRET } })), SECRET);
    leakNowhere(await rejection(() => db.sessions.exists({ where: { token: SECRET } })), SECRET);
    leakNowhere(
      await rejection(() =>
        db.sessions.find({ where: { token: inList([SECRET] as never) }, limit: 1 }),
      ),
      SECRET,
    );
    leakNowhere(
      await rejection(() => db.sessions.update({ where: { token: SECRET }, set: { label: "x" } })),
      SECRET,
    );
    leakNowhere(await rejection(() => db.sessions.delete({ where: { token: SECRET } })), SECRET);
  });
});

test("an ordinary column still echoes its rejected value", async () => {
  await withDb(async (db) => {
    const error = await rejection(() =>
      db.sessions.find({ where: { plain: "NOT-INT" }, limit: 1 }),
    );
    expect(error.code).toBe("OKM1210");
    expect(error.message).toContain("NOT-INT");
    expect(error.toHttp().body.reason).toContain("NOT-INT");
  });
});

test("insert still redacts a sensitive codec rejection", async () => {
  const error = await rejection(() =>
    explainWrite(app, "insert", "sessions", { id: "1", token: "SECRET-abc" }, {}, {}),
  );
  expect(error.message).toBe("Field token was rejected.");
  expect(error.message.includes("SECRET-abc")).toBe(false);
});
