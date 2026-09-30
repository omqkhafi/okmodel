import { expectTypeOf } from "expect-type";

/** A trivial type the TypeScript 7 typecheck accepts. */
type Trivial = { readonly value: number };

expectTypeOf<Trivial>().toEqualTypeOf<{ readonly value: number }>();
