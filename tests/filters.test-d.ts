/**
 * `filters({ allow })` only names operators `parse` applies.
 */

import { expectTypeOf } from "expect-type";

import { table, t, type FilterOperator } from "../src/dialects/pg/index.js";

expectTypeOf<"eq" extends FilterOperator ? true : false>().toEqualTypeOf<true>();
expectTypeOf<"not" extends FilterOperator ? true : false>().toEqualTypeOf<true>();
expectTypeOf<"containedBy" extends FilterOperator ? true : false>().toEqualTypeOf<true>();
expectTypeOf<"overlaps" extends FilterOperator ? true : false>().toEqualTypeOf<true>();
expectTypeOf<"hasKey" extends FilterOperator ? true : false>().toEqualTypeOf<true>();
expectTypeOf<"hasAnyKey" extends FilterOperator ? true : false>().toEqualTypeOf<true>();
expectTypeOf<"path" extends FilterOperator ? true : false>().toEqualTypeOf<false>();
expectTypeOf<"matches" extends FilterOperator ? true : false>().toEqualTypeOf<false>();
expectTypeOf<"or" extends FilterOperator ? true : false>().toEqualTypeOf<false>();
expectTypeOf<"none" extends FilterOperator ? true : false>().toEqualTypeOf<false>();

const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });

tasks.filters({ allow: { title: ["not", "overlaps", "hasKey"] } });

// @ts-expect-error path is not an operator parse applies
tasks.filters({ allow: { title: ["path"] } });
