/**
 * Register autocomplete: row lookup and reference names.
 */

import { expectTypeOf } from "expect-type";

import { type Insert, type Row, type TableName, type Update } from "okmodel";
import { appSchema } from "./schema.js";

expectTypeOf<Row<"tasks">>().toEqualTypeOf<Row<"tasks", typeof appSchema>>();
expectTypeOf<Insert<"tasks">>().toEqualTypeOf<Insert<"tasks", typeof appSchema>>();
expectTypeOf<Update<"users">>().toEqualTypeOf<Update<"users", typeof appSchema>>();
expectTypeOf<TableName>().toEqualTypeOf<"tasks" | "users">();
expectTypeOf<Row<"users">>().toEqualTypeOf<{
  readonly id: string;
  readonly email: string;
}>();
