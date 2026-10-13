/**
 * Morph include is a flat union. The reverse many is an ordinary to-many.
 */

import { expectTypeOf } from "expect-type";

import { has, id, morph, morphMany, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";

const tasks = table(
  "tasks",
  { id: id({ default: "none" }), title: text() },
  { relations: { comments: morphMany("comments", "commentable") } },
);
const lists = table(
  "lists",
  { id: id({ default: "none" }), name: text() },
  { relations: { comments: morphMany("comments", "commentable") } },
);
const comments = table(
  "comments",
  {
    id: id({ default: "none" }),
    body: text(),
    commentableType: text(),
    commentableId: uuid(),
  },
  { relations: { commentable: morph("commentable", ["tasks", "lists"]) } },
);
const app = schema({ tables: [tasks, lists, comments] });

declare const db: Connected<typeof app>;

const rows = db.comments.find({ include: { commentable: true }, limit: 1 });
type Item = Awaited<typeof rows>[number]["commentable"];

expectTypeOf<Item>().toEqualTypeOf<
  | {
      readonly id: string;
      readonly title: string;
      readonly commentableType: "tasks";
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly commentableType: "lists";
    }
  | null
>();

void db.tasks.find({
  where: { comments: has({ body: "a" }) },
  include: { comments: { limit: 2, orderBy: { body: "asc" } } },
  limit: 1,
});

// @ts-expect-error a morph include is true; select is not available on the union
void db.comments.find({ include: { commentable: { select: ["id"] } }, limit: 1 });
// @ts-expect-error has, none, and every do not filter a morph union
void db.comments.find({ where: { commentable: has({ title: "a" }) }, limit: 1 });
// @ts-expect-error the reverse many needs a limit
void db.tasks.find({ include: { comments: true }, limit: 1 });
