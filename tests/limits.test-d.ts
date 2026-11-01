/**
 * Types of `connect({ limits })` (M-7): a key lifts the `limit` requirement for its own call only.
 *
 * A bare call is allowed only when that default covers every required option.
 * `testing()` does not go through `connect`, so it keeps `limit` required.
 */

import { expectTypeOf } from "expect-type";

import type { DriverPool } from "../src/contracts/driver.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import type { Limits } from "../src/runtime/types.js";
import type { Testing } from "../src/tooling/testing/index.js";
import { limitsApp } from "./limits-schema.js";
import { pathApp } from "./tenancy-strategies-schema.js";

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

expectTypeOf(plain.notes.descendants("1")).not.toHaveProperty("then");
expectTypeOf(plain.notes.descendants("1")).toHaveProperty("all");
expectTypeOf(plain.notes.ancestors("1")).not.toHaveProperty("then");
expectTypeOf(findOnly.notes.descendants("1")).toHaveProperty("then");
expectTypeOf(all.notes.ancestors("1")).toHaveProperty("then");
expectTypeOf(maxOnly.notes.descendants("1")).not.toHaveProperty("then");
expectTypeOf(widened.notes.descendants("1")).not.toHaveProperty("then");
expectTypeOf(plain.notes.descendants("1", { limit: 5 })).toHaveProperty("then");
expectTypeOf(plain.notes.descendants("1").all("export")).toHaveProperty("then");

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

const pageOnly = connect(pool, { schema: limitsApp, limits: { page: 50 } });
const includeOnly = connect(pool, { schema: limitsApp, limits: { include: 20 } });
const groupOnly = connect(pool, { schema: limitsApp, limits: { groupBy: 100 } });

expectTypeOf(all.notes.find()).toHaveProperty("then");
expectTypeOf(findOnly.notes.find()).toHaveProperty("then");
expectTypeOf(findOnly.notes.find().all("export")).toHaveProperty("then");
expectTypeOf(all.notes.page()).toHaveProperty("then");
// @ts-expect-error find() needs options unless limits.find is set
void plain.notes.find();
// @ts-expect-error limits.page does not relax find
void pageOnly.notes.find();
// @ts-expect-error limits.include does not relax find
void includeOnly.notes.find();
// @ts-expect-error limits.groupBy does not relax find
void groupOnly.notes.find();
// @ts-expect-error max changes no type
void maxOnly.notes.find();
// @ts-expect-error a widened limits value sets no key
void widened.notes.find();
// @ts-expect-error page() needs options unless limits.page is set
void plain.notes.page();
// @ts-expect-error limits.find does not set a page size
void findOnly.notes.page();
// @ts-expect-error aggregate still needs its options; groupBy is not filled in
void all.notes.aggregate();

const settings = sessionSettings({
  userId: { name: "app.user_id", type: "text", required: true },
});
const sessionDb = connect(pool, { schema: limitsApp, session: settings, limits: { find: 50 } });
expectTypeOf(sessionDb.with({ userId: "ada" }).notes.find()).toHaveProperty("then");
expectTypeOf(sessionDb.notes.find({ limit: 2 })).toHaveProperty("then");

void all.tx(async (tx) => {
  expectTypeOf(tx.notes.find()).toHaveProperty("then");
  expectTypeOf(tx.notes.page()).toHaveProperty("then");
  await tx.tx(async (inner) => {
    expectTypeOf(inner.notes.find()).toHaveProperty("then");
    expectTypeOf(inner.notes.find({ limit: 1 }).all("export")).toHaveProperty("then");
  });
});

const paths = connect(pool, { schema: pathApp, limits: { find: 10, page: 5 } });
const scoped = paths.for({ tenantId: "00000000-0000-7000-8000-000000000001" });
expectTypeOf(scoped.notes.find()).toHaveProperty("then");
expectTypeOf(scoped.projects.find()).toHaveProperty("then");
expectTypeOf(scoped.notes.page()).toHaveProperty("then");
void scoped.tx(async (tx) => {
  expectTypeOf(tx.notes.find()).toHaveProperty("then");
});
const plainPaths = connect(pool, { schema: pathApp }).for({
  tenantId: "00000000-0000-7000-8000-000000000001",
});
// @ts-expect-error the same via() table without limits.find still requires options
void plainPaths.notes.find();

declare const harness: Testing<typeof limitsApp>;
// @ts-expect-error testing() builds a client without connect({ limits })
void harness.db.notes.find();
