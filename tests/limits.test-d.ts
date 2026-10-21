/**
 * Types of `connect({ limits })` (M-7): a key lifts the `limit` requirement for its own call only.
 */

import { expectTypeOf } from "expect-type";

import type { DriverPool } from "../src/contracts/driver.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import type { Limits } from "../src/runtime/types.js";
import { limitsApp } from "./limits-schema.js";

declare const pool: DriverPool;

const plain = connect(pool, { schema: limitsApp });
const all = connect(pool, {
  schema: limitsApp,
  limits: { find: 50, include: 20, page: 25, groupBy: 100, max: 1000 },
});
const findOnly = connect(pool, { schema: limitsApp, limits: { find: 50 } });
const maxOnly = connect(pool, { schema: limitsApp, limits: { max: 100 } });
declare const wide: Limits;
const widened = connect(pool, { schema: limitsApp, limits: wide });

const order = { orderBy: { id: "asc" } } as const;

expectTypeOf(plain.notes.find(order)).not.toHaveProperty("then");
expectTypeOf(plain.notes.find(order)).toHaveProperty("all");
expectTypeOf(all.notes.find(order)).toHaveProperty("then");
expectTypeOf(findOnly.notes.find(order)).toHaveProperty("then");
expectTypeOf(maxOnly.notes.find(order)).not.toHaveProperty("then");
expectTypeOf(widened.notes.find(order)).not.toHaveProperty("then");
expectTypeOf(all.notes.find({ ...order, limit: 5 })).toHaveProperty("then");
expectTypeOf(all.notes.find(order).all("export")).toHaveProperty("then");

// @ts-expect-error page needs limit unless limits.page is set
void plain.notes.page({ orderBy: { id: "asc" } });
// @ts-expect-error limits.find does not set a page size
void findOnly.notes.page({ orderBy: { id: "asc" } });
expectTypeOf(all.notes.page(order)).toHaveProperty("then");
expectTypeOf(all.notes.page({ ...order, limit: 5 })).toHaveProperty("then");

expectTypeOf(findOnly.notes.aggregate({ groupBy: ["rank"], count: true })).not.toHaveProperty(
  "then",
);
expectTypeOf(all.notes.aggregate({ groupBy: ["rank"], count: true })).toHaveProperty("then");
expectTypeOf(all.notes.aggregate({ count: true })).toHaveProperty("then");
expectTypeOf(
  all.notes.aggregate({ groupBy: ["rank"], select: { n: { count: true } } }),
).toHaveProperty("then");
expectTypeOf(
  findOnly.notes.aggregate({ groupBy: ["rank"], select: { n: { count: true } } }),
).not.toHaveProperty("then");
expectTypeOf(plain.notes.aggregate({ groupBy: ["rank"], count: true })).not.toHaveProperty("then");

void plain.notes.find({
  orderBy: { id: "asc" },
  limit: 1,
  // @ts-expect-error a to-many include needs a limit
  include: { comments: true },
});
void findOnly.notes.find({
  orderBy: { id: "asc" },
  limit: 1,
  // @ts-expect-error limits.find does not set an include limit
  include: { comments: true },
});
void all.notes.find({ orderBy: { id: "asc" }, limit: 1, include: { comments: true, tags: true } });
void all.notes.find({ orderBy: { id: "asc" }, limit: 1, include: { comments: { limit: 3 } } });
void all.notes.find({ orderBy: { id: "asc" }, limit: 1, include: { comments: {} } });
