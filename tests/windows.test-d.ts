/**
 * Window helpers add their `as` key. A plain `select` stays a field pick.
 * `page` does not take a window.
 */

import { expectTypeOf } from "expect-type";

import {
  denseRank,
  integer,
  numeric,
  rank,
  rowNumber,
  runningTotal,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";

const tasks = table("tasks", {
  id: uuid().primaryKey(),
  status: text(),
  score: integer(),
  amount: numeric(),
});

const app = schema({ tables: [tasks] });
declare const db: Connected<typeof app>;

const plain = db.tasks.find({ select: ["id", "status"] as const, limit: 1 });
expectTypeOf<keyof Awaited<typeof plain>[number]>().toEqualTypeOf<"id" | "status">();

const numbered = db.tasks.find({
  select: [
    "id",
    rowNumber({ partitionBy: ["status"], orderBy: { score: "desc" }, as: "n" }),
    rank({ partitionBy: ["status"], orderBy: { score: "desc" }, as: "r" }),
    denseRank({ partitionBy: ["status"], orderBy: { score: "desc" }, as: "d" }),
  ],
  limit: 1,
});
type Numbered = Awaited<typeof numbered>[number];
expectTypeOf<Numbered["id"]>().toEqualTypeOf<string>();
expectTypeOf<Numbered["n"]>().toEqualTypeOf<number>();
expectTypeOf<Numbered["r"]>().toEqualTypeOf<number>();
expectTypeOf<Numbered["d"]>().toEqualTypeOf<number>();

const totaled = db.tasks.find({
  select: [
    runningTotal("score", { orderBy: { id: "asc" }, as: "countSoFar" }),
    runningTotal("amount", { orderBy: { id: "asc" }, as: "moneySoFar" }),
  ],
  limit: 1,
});
type Totaled = Awaited<typeof totaled>[number];
expectTypeOf<Totaled["countSoFar"]>().toEqualTypeOf<number | null>();
expectTypeOf<Totaled["moneySoFar"]>().toEqualTypeOf<string | null>();

const only = db.tasks.one({
  select: [rowNumber({ orderBy: { id: "asc" }, as: "n" })],
});
expectTypeOf<NonNullable<Awaited<typeof only>>["n"]>().toEqualTypeOf<number>();
