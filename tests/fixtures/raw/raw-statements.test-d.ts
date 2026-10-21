/**
 * The generated raw declaration types the literal.
 */

import { expectTypeOf } from "expect-type";

import type { RawStatements } from "okmodel/pg";

declare module "okmodel/pg" {
  interface RawStatements {
    "select id from tasks where owner = $1": {
      readonly params: readonly [string];
      readonly row: { readonly id: string };
      readonly kind: "read";
    };
  }
}

type Statement = RawStatements["select id from tasks where owner = $1"];

expectTypeOf<Statement["params"]>().toEqualTypeOf<readonly [string]>();
expectTypeOf<Statement["row"]>().toEqualTypeOf<{ readonly id: string }>();
expectTypeOf<Statement["kind"]>().toEqualTypeOf<"read">();
