/**
 * Types of `schema({ computed })`: the callback is typed from the schema's own
 * tables, a selected name is in the row with its verb's type, and an unselected
 * one is not.
 */

import { expectTypeOf } from "expect-type";

import { gte, schema, table, text } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";
import { app } from "./computed-declared-schema.js";

type Scoped = ReturnType<Connected<typeof app>["for"]>;
declare const a: Scoped;

const rows = a.users.find({
  limit: 5,
  computed: {
    postCount: true,
    maxViews: true,
    recent: (u) => u.posts.count({ where: { createdAt: gte("2024-01-01T00:00:00.000Z") } }),
  },
  where: { postCount: gte(5) },
  orderBy: { postCount: "desc" },
});
type Row = Awaited<typeof rows>[number];
expectTypeOf<Row["postCount"]>().toEqualTypeOf<number>();
expectTypeOf<Row["maxViews"]>().toEqualTypeOf<number | null>();
expectTypeOf<Row["recent"]>().toEqualTypeOf<number>();
expectTypeOf<Row["name"]>().toEqualTypeOf<string>();
expectTypeOf<keyof Row>().not.toHaveProperty("hasDraft");

const only = a.users.find({ select: ["id"], limit: 5, computed: { postCount: true } });
expectTypeOf<keyof Awaited<typeof only>[number]>().toEqualTypeOf<"id" | "postCount">();

const flagged = a.users.one({ computed: { hasDraft: true, weight: true } });
expectTypeOf<NonNullable<Awaited<typeof flagged>>["hasDraft"]>().toEqualTypeOf<boolean>();
expectTypeOf<NonNullable<Awaited<typeof flagged>>["weight"]>().toEqualTypeOf<number | null>();

const own = a.posts.find({ limit: 5, computed: { commentCount: true } });
expectTypeOf<Awaited<typeof own>[number]["commentCount"]>().toEqualTypeOf<number>();

const counted = a.users.count({ where: { postCount: gte(1) }, computed: { postCount: true } });
expectTypeOf<Awaited<typeof counted>>().toEqualTypeOf<number>();

// The callback sees the schema's tables.
const posts = table("posts", { id: text().primaryKey(), authorId: text() });
const users = table("users", { id: text().primaryKey() });
void schema({
  tables: [users, posts],
  computed: {
    users: {
      // @ts-expect-error a field of the related table
      n: (u) => u.posts.sum("nope"),
    },
  },
});
void schema({
  tables: [users, posts],
  // @ts-expect-error a table that is not in the schema
  computed: { nope: { n: () => undefined } },
});
