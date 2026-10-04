/**
 * Tenant tables carry the key on the row, and the root client omits them.
 */

import { expectTypeOf } from "expect-type";

import type { Connected } from "../src/runtime/types.js";
import { app } from "./tenancy-schema.js";

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~row"]>().toEqualTypeOf<
  "id" | "title" | "code" | "orgId" | "tenantId"
>();

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~insert"]>().toEqualTypeOf<
  "id" | "title" | "code" | "orgId"
>();

expectTypeOf<keyof (typeof app)["~byName"]["tasks"]["~update"]>().toEqualTypeOf<
  "title" | "code" | "orgId"
>();

expectTypeOf<keyof (typeof app)["~byName"]["countries"]["~row"]>().toEqualTypeOf<"id" | "name">();

expectTypeOf<keyof (typeof app)["~byName"]["orgs"]["~row"]>().toEqualTypeOf<
  "id" | "name" | "tenantId"
>();

type Root = Connected<typeof app>;

expectTypeOf<"tasks" extends keyof Root ? true : false>().toEqualTypeOf<false>();
expectTypeOf<"orgs" extends keyof Root ? true : false>().toEqualTypeOf<false>();
expectTypeOf<"countries" extends keyof Root ? true : false>().toEqualTypeOf<true>();

type Scoped = ReturnType<Root["for"]>;

expectTypeOf<"tasks" extends keyof Scoped ? true : false>().toEqualTypeOf<true>();
expectTypeOf<"countries" extends keyof Scoped ? true : false>().toEqualTypeOf<true>();
