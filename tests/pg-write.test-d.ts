/**
 * Insert, update, and delete result types.
 */

import { expectTypeOf } from "expect-type";

import { id, inc, integer, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const users = table("users", {
  id: id(),
  email: text().unique(),
  name: text().nullable(),
  role: text().guarded(),
});

const tasks = table("tasks", {
  id: id(),
  ownerId: uuid(),
  title: text(),
  position: integer(),
});

const app = schema({ casing: "snake", tables: [users, tasks] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });
  const row = await db.users.insert({ email: "a@b.c", name: "Ada" });
  expectTypeOf(row).toMatchTypeOf<{
    readonly id: string;
    readonly email: string;
    readonly name: string | null;
  }>();

  const rows = await db.users.insert([{ email: "b@b.c", name: null }]);
  expectTypeOf(rows).toMatchTypeOf<readonly { readonly email: string }[]>();

  // Rows in one list may omit different optional keys, or pass `undefined`.
  void db.users.insert([
    { email: "a@b.c" },
    { email: "b@b.c", name: "Bo" },
    { email: "c@b.c", name: undefined },
  ]);
  // @ts-expect-error a required key is still needed on every row
  void db.users.insert([{ email: "a@b.c" }, { name: "Bo" }]);

  const updated = await db.tasks.update({ where: { title: "ship" }, set: { position: inc(1) } });
  expectTypeOf(updated).toEqualTypeOf<{ readonly count: number }>();

  const removed = await db.tasks.delete({ where: { title: "ship" } });
  expectTypeOf(removed).toEqualTypeOf<{ readonly count: number }>();

  // @ts-expect-error role is guarded and is not an insert field
  void db.users.insert({ email: "a@b.c", role: "admin" });

  // @ts-expect-error update needs a known column
  void db.tasks.update({ where: { title: "ship" }, set: { missing: 1 } });
}

void shapes;
