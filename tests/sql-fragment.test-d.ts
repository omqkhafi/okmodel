/**
 * A fragment is a where operand. `.as` adds a numeric select key.
 */

import { expectTypeOf } from "expect-type";

import { fragment, ident, schema, table, text } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";

const notes = table("notes", { id: text(), title: text() });
const app = schema({ tables: [notes] });
declare const db: Connected<typeof app>;

const rows = db.notes.find({
  where: { title: fragment`${ident("title")} ilike ${"%a%"}` },
  select: ["id", fragment`length(${ident("title")})`.as("len")] as const,
  limit: 1,
});

expectTypeOf<keyof Awaited<typeof rows>[number]>().toEqualTypeOf<"id" | "len">();
expectTypeOf<Awaited<typeof rows>[number]["len"]>().toEqualTypeOf<number>();
