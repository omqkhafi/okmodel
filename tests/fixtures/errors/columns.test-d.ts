import { expectTypeOf } from "expect-type";

import { OkmError } from "../../../src/contracts/error.js";

declare module "../../../src/contracts/rows.js" {
  interface Register {
    readonly schema: {
      readonly "~byName": {
        readonly users: {
          readonly "~name": "users";
          readonly "~row": { readonly id: string; readonly email: string };
          readonly "~insert": { readonly email: string };
          readonly "~update": { readonly email?: string | undefined };
        };
      };
    };
  }
}

declare const error: unknown;

if (OkmError.is(error, "unique", "users")) {
  expectTypeOf(error.kind).toEqualTypeOf<"unique">();
  expectTypeOf(error.table).toEqualTypeOf<"users">();
  expectTypeOf(error.columns).toEqualTypeOf<readonly ("email" | "id")[]>();
}

if (OkmError.is(error, "not_null", "other")) {
  expectTypeOf(error.columns).toEqualTypeOf<readonly string[]>();
}
