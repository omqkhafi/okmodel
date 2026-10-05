/**
 * Presets are typed by their own arguments, chain, and the builder has no
 * method that removes or replaces a predicate.
 */

import { expectTypeOf } from "expect-type";

import { id, schema, table, text } from "../src/dialects/pg/index.js";
import type { PresetQuery } from "../src/dialects/pg/preset.js";
import { trait } from "../src/runtime/traits/index.js";
import type { Connected } from "../src/runtime/types.js";
import { app, tenantApp } from "./presets-schema.js";

type Has<T, K extends string> = K extends keyof T ? true : false;

type Db = Connected<typeof app>;
type Scoped = ReturnType<Connected<typeof tenantApp>["for"]>;

// Each preset is a method on the table handle, with the arguments it declared.
expectTypeOf<Db["tasks"]["pending"]>().parameters.toEqualTypeOf<[]>();
expectTypeOf<Db["tasks"]["ownedBy"]>().parameters.toEqualTypeOf<[owner: string]>();
expectTypeOf<Db["tasks"]["inState"]>().parameters.toEqualTypeOf<[...states: string[]]>();
expectTypeOf<Db["tasks"]["mineOrOpen"]>().parameters.toEqualTypeOf<[owner: string]>();

// A trait's presets are on every table it is on.
expectTypeOf<Has<Db["tasks"], "flagged">>().toEqualTypeOf<true>();
expectTypeOf<Db["tasks"]["flagged"]>().parameters.toEqualTypeOf<[]>();

// A preset returns the table handle, so calls chain and every method stays.
expectTypeOf<ReturnType<Db["tasks"]["pending"]>>().toEqualTypeOf<Db["tasks"]>();
expectTypeOf<ReturnType<ReturnType<Db["tasks"]["pending"]>["ownedBy"]>["find"]>().toEqualTypeOf<
  Db["tasks"]["find"]
>();
expectTypeOf<Has<ReturnType<Db["tasks"]["urgent"]>, "archive">>().toEqualTypeOf<true>();
expectTypeOf<Has<ReturnType<Scoped["tasks"]["pending"]>, "update">>().toEqualTypeOf<true>();

// @ts-expect-error ownedBy takes a string
void ((db: Db) => db.tasks.ownedBy(5));
// @ts-expect-error ownedBy needs its argument
void ((db: Db) => db.tasks.ownedBy());
// @ts-expect-error pending takes no argument
void ((db: Db) => db.tasks.pending("x"));
// @ts-expect-error an unknown preset is not a method
void ((db: Db) => db.tasks.nobody());

// A table with no presets has none of these methods.
const plain = table("plain", { id: id({ default: "none" }), body: text() });
const bare = schema({ tables: [plain] });
type Bare = Connected<typeof bare>;
expectTypeOf<Has<Bare["plain"], "pending">>().toEqualTypeOf<false>();
expectTypeOf<Has<Bare["plain"], "find">>().toEqualTypeOf<true>();

// The builder has one method. Nothing removes or replaces a predicate.
type Row = { readonly status: string; readonly priority: number };
expectTypeOf<keyof PresetQuery<Row>>().toEqualTypeOf<"where">();
expectTypeOf<PresetQuery<Row>["where"]>().returns.toEqualTypeOf<PresetQuery<Row>>();

table(
  "checked",
  { id: id({ default: "none" }), status: text() },
  {
    presets: {
      open: (q) => q.where({ status: "open" }),
      // @ts-expect-error the builder has no method that replaces the filter
      replace: (q) => q.replace({ status: "open" }),
      // @ts-expect-error the builder has no method that clears the filter
      clear: (q) => q.clear(),
      // @ts-expect-error the builder has no method that removes a predicate
      without: (q) => q.without("status"),
      // @ts-expect-error a preset may only filter columns the table has
      nope: (q) => q.where({ missing: 1 }),
      // @ts-expect-error a preset filters with the column's own type
      wrong: (q) => q.where({ status: 5 }),
    },
  },
);

// A reserved or client-method name is a type error.
const reserved = ["find", "one", "page", "aggregate", "count", "exists"] as const;
void reserved;
table(
  "names",
  { id: id({ default: "none" }), status: text() },
  {
    presets: {
      // @ts-expect-error find is a client method
      find: (q) => q.where({ status: "x" }),
      // @ts-expect-error update is a client method
      update: (q) => q.where({ status: "x" }),
      // @ts-expect-error delete is a client method
      delete: (q) => q.where({ status: "x" }),
      // @ts-expect-error insert is a client method
      insert: (q) => q.where({ status: "x" }),
      // @ts-expect-error archive is a client method
      archive: (q) => q.where({ status: "x" }),
      // @ts-expect-error lock is reserved
      lock: (q) => q.where({ status: "x" }),
      // @ts-expect-error watch is reserved
      watch: (q) => q.where({ status: "x" }),
      // @ts-expect-error subscribe is reserved
      subscribe: (q) => q.where({ status: "x" }),
      // @ts-expect-error stream is reserved
      stream: (q) => q.where({ status: "x" }),
      // @ts-expect-error inspect is reserved
      inspect: (q) => q.where({ status: "x" }),
      // @ts-expect-error explain is reserved
      explain: (q) => q.where({ status: "x" }),
      // @ts-expect-error with is reserved
      with: (q) => q.where({ status: "x" }),
      // @ts-expect-error for is reserved
      for: (q) => q.where({ status: "x" }),
      // @ts-expect-error as is reserved
      as: (q) => q.where({ status: "x" }),
    },
  },
);

// A trait's presets see the trait's columns, and a reserved name is a type error too.
trait("owned", {
  fields: { ownerId: text() },
  presets: {
    mine: (q, who: string) => q.where({ ownerId: who }),
    // @ts-expect-error the trait has no column named missing
    nope: (q) => q.where({ missing: 1 }),
    // @ts-expect-error find is a client method
    find: (q) => q.where({ ownerId: "x" }),
  },
});

// A schema-level trait's presets are on every table of the schema.
const everywhere = trait("everywhere", {
  fields: {},
  presets: { recent: (q) => q.where({}) },
});
const shared = schema({ traits: [everywhere], tables: [plain] });
type Shared = Connected<typeof shared>;
expectTypeOf<Has<Shared["plain"], "recent">>().toEqualTypeOf<true>();
expectTypeOf<Shared["plain"]["recent"]>().parameters.toEqualTypeOf<[]>();
