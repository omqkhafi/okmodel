/**
 * `fn.slugify(col)` is a where and orderBy operand. `.as` follows the return type.
 */

import { expectTypeOf } from "expect-type";

import { fn } from "../src/dialects/pg/fn/index.js";
import { ident, schema, table, text, integer } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";

const notes = table("notes", { id: text(), title: text(), n: integer() });
const app = schema({ tables: [notes] });
declare const db: Connected<typeof app>;

const slugify = fn("slugify", {
  arguments: [{ name: "title", type: "text" }],
  returns: "text",
  language: "sql",
  body: "select lower(title)",
});

const double = fn("double_n", {
  arguments: [{ name: "n", type: "integer" }],
  returns: "integer",
  language: "sql",
  body: "select n * 2",
});

const textRows = db.notes.find({
  where: { title: slugify(ident("title")) },
  select: ["id", slugify(ident("title")).as("slug")] as const,
  limit: 1,
});

const numericRows = db.notes.find({
  select: ["id", double(ident("n")).as("twice")] as const,
  limit: 1,
});

expectTypeOf<keyof Awaited<typeof textRows>[number]>().toEqualTypeOf<"id" | "slug">();
expectTypeOf<Awaited<typeof textRows>[number]["slug"]>().toEqualTypeOf<string>();
expectTypeOf<Awaited<typeof numericRows>[number]["twice"]>().toEqualTypeOf<number>();
