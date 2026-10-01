/**
 * Tagged operators are not plain objects, and a plan input is a verified query.
 */

import { expectTypeOf } from "expect-type";

import { type Catalog, type LogicalQuery } from "./model.js";
import { type FilterValue, lt, type TaggedOperator, type Where } from "./operators.js";
import { plan } from "./plan.js";
import { type VerifiedQuery } from "./verify.js";

expectTypeOf(lt(1)).toEqualTypeOf<TaggedOperator<"lt", number>>();

expectTypeOf<{ readonly op: "lt"; readonly value: number }>().not.toMatchTypeOf<
  TaggedOperator<"lt", number>
>();

type Row = { readonly rank: number; readonly title: string };

expectTypeOf<{ readonly rank: TaggedOperator<"lt", number> }>().toMatchTypeOf<Where<Row>>();
expectTypeOf<TaggedOperator<"lt", number>>().toMatchTypeOf<FilterValue<number>>();
expectTypeOf<{ readonly lt: number }>().not.toMatchTypeOf<FilterValue<number>>();

expectTypeOf<LogicalQuery>().not.toMatchTypeOf<VerifiedQuery>();
expectTypeOf(plan).parameters.toEqualTypeOf<[query: VerifiedQuery, catalog: Catalog]>();
