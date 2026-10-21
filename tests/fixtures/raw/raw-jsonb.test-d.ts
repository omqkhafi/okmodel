/**
 * The generated declaration types jsonb, an enum array, and an unmapped type.
 */

import { expectTypeOf } from "expect-type";

import type { RawStatements } from "okmodel/pg";

type Payload = RawStatements["select payload, meta from tasks"];
type Labels = RawStatements["select labels from tasks where mood = any($1)"];
type Area = RawStatements["select area from tasks"];

expectTypeOf<Payload["row"]["payload"]>().toEqualTypeOf<unknown>();
expectTypeOf<Payload["row"]["meta"]>().toEqualTypeOf<unknown>();
expectTypeOf<Payload["params"]>().toEqualTypeOf<readonly []>();
expectTypeOf<Labels["params"]>().toEqualTypeOf<readonly [("open" | "closed")[]]>();
expectTypeOf<Labels["row"]["labels"]>().toEqualTypeOf<("open" | "closed")[]>();
expectTypeOf<Area["row"]["area"]>().toEqualTypeOf<string>();
