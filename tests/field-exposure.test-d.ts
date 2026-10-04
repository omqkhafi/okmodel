/**
 * `{ allow }` puts a guarded field back on the write. Without it, the field is not there.
 */

import { expectTypeOf } from "expect-type";

import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const users = table("users", {
  id: id(),
  email: text(),
  role: text().guarded(),
  passwordHash: text().hidden(),
});

const app = schema({ tables: [users] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });
  const row = await db.users.insert(
    { email: "a@b.c", passwordHash: "x", role: "admin" },
    { allow: ["role"] },
  );
  expectTypeOf(row).toMatchTypeOf<{ readonly email: string; readonly role: string }>();

  await db.users.update({ where: { id: "1" }, set: { role: "owner" } }, { allow: ["role"] });

  // @ts-expect-error role is guarded until allow names it
  await db.users.insert({ email: "a@b.c", passwordHash: "x", role: "admin" });

  expectTypeOf<keyof (typeof users)["~row"]>().toEqualTypeOf<"id" | "email" | "role">();
}

void shapes;
