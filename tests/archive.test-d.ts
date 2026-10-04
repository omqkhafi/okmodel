/**
 * `archive`, `restore`, and the visibility modifiers exist only on archivable tables.
 */

import { expectTypeOf } from "expect-type";

import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import type { Connected } from "../src/runtime/types.js";
import { app, tenantApp } from "./archive-schema.js";

type Has<T, K extends string> = K extends keyof T ? true : false;

type Db = Connected<typeof app>;

expectTypeOf<Has<Db["lists"], "archive">>().toEqualTypeOf<true>();
expectTypeOf<Has<Db["lists"], "restore">>().toEqualTypeOf<true>();
expectTypeOf<Has<Db["lists"], "withArchived">>().toEqualTypeOf<true>();
expectTypeOf<Has<Db["lists"], "onlyArchived">>().toEqualTypeOf<true>();
expectTypeOf<Has<Db["tasks"], "archive">>().toEqualTypeOf<true>();
expectTypeOf<Has<Db["notes"], "archive">>().toEqualTypeOf<false>();
expectTypeOf<Has<Db["notes"], "restore">>().toEqualTypeOf<false>();
expectTypeOf<Has<Db["notes"], "withArchived">>().toEqualTypeOf<false>();
expectTypeOf<Has<Db["notes"], "onlyArchived">>().toEqualTypeOf<false>();

expectTypeOf<keyof (typeof app)["~byName"]["lists"]["~row"]>().toEqualTypeOf<
  "id" | "name" | "archivedAt" | "archiveId"
>();
expectTypeOf<keyof (typeof app)["~byName"]["lists"]["~insert"]>().toEqualTypeOf<"id" | "name">();
expectTypeOf<keyof (typeof app)["~byName"]["lists"]["~update"]>().toEqualTypeOf<"name">();

expectTypeOf<Has<ReturnType<Db["lists"]["withArchived"]>, "find">>().toEqualTypeOf<true>();
expectTypeOf<Has<ReturnType<Db["lists"]["onlyArchived"]>, "delete">>().toEqualTypeOf<true>();

const marked = table("marked", { id: id({ default: "none" }), name: text() });
const plain = table(
  "plain",
  { id: id({ default: "none" }), body: text() },
  { omitDefaults: "owned outside okmodel" },
);
const inherited = schema({ traits: [archivable()], tables: [marked, plain] });
type Inherited = Connected<typeof inherited>;

expectTypeOf<Has<Inherited["marked"], "archive">>().toEqualTypeOf<true>();
expectTypeOf<Has<Inherited["plain"], "archive">>().toEqualTypeOf<false>();
expectTypeOf<keyof (typeof inherited)["~byName"]["plain"]["~row"]>().toEqualTypeOf<"id" | "body">();

type Scoped = ReturnType<Connected<typeof tenantApp>["for"]>;

expectTypeOf<Has<Scoped["orgs"], "archive">>().toEqualTypeOf<true>();
expectTypeOf<Has<Scoped["orgs"], "restore">>().toEqualTypeOf<true>();
expectTypeOf<Has<Scoped["tasks"], "onlyArchived">>().toEqualTypeOf<true>();
