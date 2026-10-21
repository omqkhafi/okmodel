/**
 * Exported `Insert` and `Update` match `insert()` and `update()`.
 *
 * Defaulted and nullable columns are optional. A missing required column and
 * an unknown key are errors. Trait columns stay off the write types. A tenant
 * key the index callback can name stays off them too.
 */

import { expectTypeOf } from "expect-type";

import { type Insert, type Update } from "../src/contracts/index.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import type { QuerySchema } from "../src/dialects/pg/model.js";
import type { TableApi } from "../src/runtime/types.js";
import { sortable, timestamps, versioned } from "../src/runtime/traits/index.js";
import { appSchema } from "./row-types-schema.js";
import { app as tenantApp } from "./tenancy-schema.js";

const requiredOnly: Insert<"users", typeof appSchema> = { email: "a@b.c" };
expectTypeOf(requiredOnly.email).toEqualTypeOf<string>();

// @ts-expect-error email is required
const missingEmail: Insert<"users", typeof appSchema> = {};
void missingEmail;

const unknownKey: Insert<"users", typeof appSchema> = {
  email: "a@b.c",
  // @ts-expect-error unknown key
  extra: true,
};
void unknownKey;

/** Row element of `insert()`'s list overload, the same shape as one row. */
type InsertParam<S extends QuerySchema, K extends keyof S["~byName"] & string> = Parameters<
  TableApi<S, K>["insert"]
>[0] extends readonly (infer Row)[]
  ? Row
  : never;

expectTypeOf<Insert<"tasks", typeof appSchema>>().toEqualTypeOf<
  InsertParam<typeof appSchema, "tasks">
>();
expectTypeOf<InsertParam<typeof appSchema, "tasks">>().toEqualTypeOf<
  Insert<"tasks", typeof appSchema>
>();

const titleOnly: Update<"tasks", typeof appSchema> = { title: "n" };
const emptyPatch: Update<"tasks", typeof appSchema> = {};
expectTypeOf(titleOnly.title).toEqualTypeOf<string | undefined>();
void emptyPatch;

const notes = table(
  "notes",
  { id: t.text().primaryKey(), title: t.text(), laneId: t.text() },
  { traits: [versioned(), sortable("laneId")] },
);
const stamped = schema({ traits: [timestamps()], tables: [notes] });

type NoteInsert = Insert<"notes", typeof stamped>;
type NoteUpdate = Update<"notes", typeof stamped>;

expectTypeOf<keyof NoteInsert>().toEqualTypeOf<"id" | "title" | "laneId">();
expectTypeOf<keyof NoteUpdate>().toEqualTypeOf<"title" | "laneId">();

type Absent<T, K extends string> = K extends keyof T ? true : false;
expectTypeOf<Absent<NoteInsert, "createdAt">>().toEqualTypeOf<false>();
expectTypeOf<Absent<NoteInsert, "updatedAt">>().toEqualTypeOf<false>();
expectTypeOf<Absent<NoteInsert, "version">>().toEqualTypeOf<false>();
expectTypeOf<Absent<NoteInsert, "position">>().toEqualTypeOf<false>();
expectTypeOf<Absent<NoteUpdate, "createdAt">>().toEqualTypeOf<false>();
expectTypeOf<Absent<NoteUpdate, "updatedAt">>().toEqualTypeOf<false>();
expectTypeOf<Absent<NoteUpdate, "version">>().toEqualTypeOf<false>();
expectTypeOf<Absent<NoteUpdate, "position">>().toEqualTypeOf<false>();

declare const claim: TableApi<typeof stamped, "notes">["update"];
void claim({
  where: { id: "1" },
  set: { title: "b" },
  limit: 1,
  lock: "skip",
  version: "any",
});

type TaskInsert = Insert<"tasks", typeof tenantApp>;
type TaskUpdate = Update<"tasks", typeof tenantApp>;
expectTypeOf<keyof TaskInsert>().toEqualTypeOf<"id" | "title" | "code" | "orgId">();
expectTypeOf<keyof TaskUpdate>().toEqualTypeOf<"title" | "code" | "orgId">();
expectTypeOf<Absent<TaskInsert, "tenantId">>().toEqualTypeOf<false>();
expectTypeOf<Absent<TaskUpdate, "tenantId">>().toEqualTypeOf<false>();
