import { expectTypeOf } from "expect-type";

import { OkmError, type HttpError } from "../src/contracts/index.js";

declare const error: unknown;

if (OkmError.is(error, "unique")) {
  expectTypeOf(error.kind).toEqualTypeOf<"unique">();
}

if (OkmError.is(error, "unique", "users")) {
  expectTypeOf(error.table).toEqualTypeOf<"users">();
  expectTypeOf(error.columns).toEqualTypeOf<readonly string[]>();
}

declare const caught: OkmError;

const matched = caught.match({
  input: (item) => {
    expectTypeOf(item.category).toEqualTypeOf<"input">();
    return item.fields();
  },
  conflict: (item) => {
    expectTypeOf(item.category).toEqualTypeOf<"conflict">();
    return item.fields();
  },
  _: (item) => item.toHttp(),
});

expectTypeOf(matched).toEqualTypeOf<Readonly<Record<string, string>> | HttpError>();
