/**
 * `update` with `{ allow, returning: true }` returns the rows.
 * `delete` with `{ returning: true }` is OKM1120 and writes nothing.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, text } from "../src/dialects/pg/index.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";

const notes = table("notes", {
  id: text().primaryKey(),
  title: text(),
  rank: text().guarded(),
});

const app = schema({ tables: [notes] });

test("update returning: true with allow returns rows, and delete refuses true", async () => {
  const pool = await openPglite();
  try {
    await pool.execute(
      "create table notes (id text primary key, title text not null, rank text not null default '0')",
    );
    const db = await connectPglite(pool, { schema: app });
    await db.connected;
    await db.notes.insert({ id: "a", title: "one" });
    const rows = await db.notes.update(
      { where: { id: "a" }, set: { rank: "1" } },
      { allow: ["rank"], returning: true },
    );
    expect(rows).toEqual([{ id: "a", title: "one", rank: "1" }]);

    const refused = await db.notes
      .delete({ where: { id: "a" } }, { returning: true } as never)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(OkmError);
    if (!(refused instanceof OkmError)) throw new Error("expected OKM1120");
    expect(refused.code).toBe("OKM1120");
    expect(refused.message).toContain("returning: true");
    expect(await db.notes.one({ where: { id: "a" } })).toEqual({
      id: "a",
      title: "one",
      rank: "1",
    });
    await db.close();
  } finally {
    await pool.close();
  }
});
