import { expectTypeOf } from "expect-type";

expectTypeOf<string>().toEqualTypeOf<number>();
