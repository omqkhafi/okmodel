/**
 * `schema({ validation: true })` marks the insert body.
 *
 * The validate methods are added at runtime by importing `okmodel/validate`.
 * They are not on the table type: a per-table method check exceeds the query
 * instantiation ceiling. A table-level `validation: false` still skips the
 * rules at runtime and does not remove the mark.
 *
 * Guarded fields and the tenant key stay off the insert body.
 */

import { expectTypeOf } from "expect-type";

import type { Input } from "../src/contracts/index.js";
import { schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import type { Connected, InsertBody } from "../src/runtime/types.js";

const columns = {
  id: uuid(),
  title: text(),
  secret: text().guarded(),
};

const on = schema({ tables: [table("tasks", columns)], validation: true });
const off = schema({ tables: [table("tasks", columns)] });
const tableOff = schema({
  tables: [table("tasks", columns, { validation: false })],
  validation: true,
});
const tenant = schema({
  tables: [table("tasks", { id: uuid(), title: text() })],
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  validation: true,
});

type OnBody = InsertBody<typeof on, "tasks">;
type OffBody = InsertBody<typeof off, "tasks">;

expectTypeOf<OnBody>().toEqualTypeOf<OffBody & { readonly "~input"?: true }>();
expectTypeOf<OnBody>().toEqualTypeOf<Input<"tasks", typeof on> extends infer I ? I : never>();

type HasValidate<T> = T extends { readonly validate: (...args: never[]) => unknown } ? true : false;

expectTypeOf<HasValidate<Connected<typeof on>["tasks"]["insert"]>>().toEqualTypeOf<false>();
expectTypeOf<HasValidate<Connected<typeof off>["tasks"]["insert"]>>().toEqualTypeOf<false>();
expectTypeOf<HasValidate<Connected<typeof tableOff>["tasks"]["insert"]>>().toEqualTypeOf<false>();
expectTypeOf<InsertBody<typeof tableOff, "tasks">>().toEqualTypeOf<OnBody>();

type OnKeys = keyof OnBody;
expectTypeOf<Extract<OnKeys, "secret">>().toEqualTypeOf<never>();
expectTypeOf<
  Extract<keyof InsertBody<typeof tenant, "tasks">, "tenantId">
>().toEqualTypeOf<never>();
