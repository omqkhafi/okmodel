/**
 * The typed validation surface.
 *
 * This program includes `okmodel/validate`, so the augmentation is active.
 * `tests/validate-surface.test.ts` compiles a program that does not import it
 * and checks that the members are absent.
 *
 * The effective setting is the table's `validation`, else the schema's, in
 * boolean or object form. Guarded fields and the tenant key stay off the body.
 */

import { expectTypeOf } from "expect-type";

import type { Input, ValidationIssue } from "../src/contracts/index.js";
import { schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import type { InputBody } from "../src/runtime/validate/surface.js";
import type { Connected } from "../src/runtime/types.js";

const columns = {
  id: uuid(),
  title: text(),
  secret: text().guarded(),
};

const on = schema({ tables: [table("tasks", columns)], validation: true });
const off = schema({ tables: [table("tasks", columns)] });
const objectOn = schema({
  tables: [table("tasks", columns)],
  validation: { onRead: false, style: "section" },
});
const objectOff = schema({ tables: [table("tasks", columns)], validation: { enabled: false } });
const tableOff = schema({
  tables: [table("tasks", columns, { validation: false })],
  validation: true,
});
const tableOn = schema({ tables: [table("tasks", columns, { validation: true })] });
const tableObject = schema({
  tables: [table("tasks", columns, { validation: { enabled: true, style: "inline" } })],
});
const tableObjectOff = schema({
  tables: [table("tasks", columns, { validation: { enabled: false } })],
  validation: true,
});
const tenant = schema({
  tables: [table("tasks", { id: uuid(), title: text() })],
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  validation: true,
});

type HasValidate<T> = T extends { readonly validate: (...args: never[]) => unknown } ? true : false;

expectTypeOf<HasValidate<Connected<typeof on>["tasks"]["insert"]>>().toEqualTypeOf<true>();
expectTypeOf<HasValidate<Connected<typeof off>["tasks"]["insert"]>>().toEqualTypeOf<false>();
expectTypeOf<HasValidate<Connected<typeof objectOn>["tasks"]["insert"]>>().toEqualTypeOf<true>();
expectTypeOf<HasValidate<Connected<typeof objectOff>["tasks"]["insert"]>>().toEqualTypeOf<false>();
expectTypeOf<HasValidate<Connected<typeof tableOff>["tasks"]["insert"]>>().toEqualTypeOf<false>();
expectTypeOf<HasValidate<Connected<typeof tableOn>["tasks"]["insert"]>>().toEqualTypeOf<true>();
expectTypeOf<HasValidate<Connected<typeof tableObject>["tasks"]["insert"]>>().toEqualTypeOf<true>();
expectTypeOf<
  HasValidate<Connected<typeof tableObjectOff>["tasks"]["insert"]>
>().toEqualTypeOf<false>();
expectTypeOf<HasValidate<Connected<typeof on>["tasks"]["update"]>>().toEqualTypeOf<true>();
expectTypeOf<HasValidate<Connected<typeof off>["tasks"]["update"]>>().toEqualTypeOf<false>();
expectTypeOf<HasValidate<Connected<typeof tableOn>["tasks"]["update"]>>().toEqualTypeOf<true>();

type OnInsert = Connected<typeof on>["tasks"]["insert"];
type OnBody = InputBody<typeof on, "tasks">;
type Mark = { readonly "~input"?: true };

expectTypeOf<OnBody>().toEqualTypeOf<
  { readonly id: string; readonly title: string } & Mark extends infer B ? B : never
>();
expectTypeOf<OnBody>().toMatchTypeOf<Input<"tasks", typeof on>>();
expectTypeOf<Extract<keyof OnBody, "secret">>().toEqualTypeOf<never>();
expectTypeOf<Extract<keyof InputBody<typeof tenant, "tasks">, "tenantId">>().toEqualTypeOf<never>();

declare const insert: OnInsert;
expectTypeOf(insert.validate({ id: "a", title: "b" })).resolves.toEqualTypeOf<{
  readonly id: "a";
  readonly title: "b";
}>();
expectTypeOf(insert.validate([{ id: "a", title: "b" }])).resolves.toMatchTypeOf<
  readonly { readonly id: string; readonly title: string }[]
>();
expectTypeOf(insert.check({})).resolves.toEqualTypeOf<readonly ValidationIssue[]>();
expectTypeOf(insert.pick("title").validate({})).resolves.toEqualTypeOf<
  { readonly title: string } & Mark
>();
expectTypeOf(insert.omit("title").validate({})).resolves.toEqualTypeOf<
  { readonly id: string } & Mark
>();
expectTypeOf(insert["~standard"].vendor).toEqualTypeOf<"okmodel">();
expectTypeOf(insert["~standard"].version).toEqualTypeOf<1>();

declare const update: Connected<typeof on>["tasks"]["update"];
expectTypeOf(update.validate({ title: "x" })).resolves.toEqualTypeOf<{ readonly title: "x" }>();
expectTypeOf(update.validate({ set: { title: "x" } })).resolves.toEqualTypeOf<{
  readonly set: { readonly title: "x" };
}>();

// The write methods keep their own signatures.
declare const plain: Connected<typeof off>["tasks"]["insert"];
expectTypeOf(plain).toBeFunction();
expectTypeOf(insert).toBeFunction();

// @ts-expect-error a field the table does not have
insert.pick("missing");
