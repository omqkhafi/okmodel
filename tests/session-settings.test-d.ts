/**
 * `db.with()` takes every required key and the optional ones, with the
 * declared value types, and exists only when `connect` got a session context.
 */

import { expectTypeOf } from "expect-type";

import { schema, t, table } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";
import { sessionSettings, type SessionValues } from "../src/runtime/session/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";

const ctx = sessionSettings({
  userId: { name: "app.user_id", type: "uuid", required: true },
  role: { name: "app.role", type: "text" },
  level: { name: "app.level", type: "int" },
  admin: { name: "app.admin", type: "bool" },
});

type Values = SessionValues<NonNullable<(typeof ctx)["~settings"]>>;

expectTypeOf<Values>().toEqualTypeOf<
  {
    readonly userId: string;
  } & {
    readonly role?: string;
    readonly level?: number;
    readonly admin?: boolean;
  }
>();

const plain = schema({ tables: [table("notes", { id: t.identity(), title: t.text() })] });
const tenanted = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [table("notes", { id: t.identity(), title: t.text() })],
});

type WithSession = Connected<typeof plain, typeof ctx>;
type Without = Connected<typeof plain>;

expectTypeOf<WithSession["with"]>().toBeFunction();
expectTypeOf<WithSession["with"]>().parameter(0).toEqualTypeOf<Values>();
expectTypeOf<"with" extends keyof Without ? true : false>().toEqualTypeOf<false>();

type Scoped = ReturnType<WithSession["with"]>;

expectTypeOf<"with" extends keyof Scoped ? true : false>().toEqualTypeOf<true>();
expectTypeOf<"notes" extends keyof Scoped ? true : false>().toEqualTypeOf<true>();

type TenantRoot = Connected<typeof tenanted, typeof ctx>;

expectTypeOf<TenantRoot["with"]>().toBeFunction();
expectTypeOf<ReturnType<TenantRoot["for"]>["with"]>().toBeFunction();
expectTypeOf<ReturnType<TenantRoot["with"]>["for"]>().toBeFunction();

// @ts-expect-error a required key is missing
expectTypeOf<WithSession["with"]>().toBeCallableWith({ role: "x" });
// @ts-expect-error uuid is a string
expectTypeOf<WithSession["with"]>().toBeCallableWith({ userId: 1 });
// @ts-expect-error int is a number
expectTypeOf<WithSession["with"]>().toBeCallableWith({ userId: "a", level: "1" });
expectTypeOf<WithSession["with"]>().toBeCallableWith({ userId: "a" });
expectTypeOf<WithSession["with"]>().toBeCallableWith({ userId: "a", admin: true, level: 2 });
