/**
 * `okmodel/expr` carries the result type, nullability, and volatility in the
 * TypeScript type, and a place that needs an immutable expression refuses a
 * stable one at compile time.
 */

import { expectTypeOf } from "expect-type";

import {
  add,
  and,
  atTimeZone,
  caseWhen,
  cast,
  coalesce,
  col,
  concat,
  extract,
  jsonText,
  length,
  lower,
  nullif,
  now,
  setting,
  type Expr,
  type ImmutableExpr,
  type StableExpr,
  type Timestamp,
  type Timestamptz,
} from "../src/dialects/pg/expr/index.js";
import { gt } from "../src/dialects/pg/index.js";

const n = col<number>("n");
const m = col<number, true>("m");
const s = col<string>("s");
const u = col<string, true>("u");
const ts = col<Timestamptz>("ts");
const tn = col<Timestamp>("tn");

// Result types, nullability, and volatility.
expectTypeOf(add(n, 1)).toEqualTypeOf<Expr<number, false, "immutable">>();
expectTypeOf(add(m, 1)).toEqualTypeOf<Expr<number, true, "immutable">>();
expectTypeOf(length(u)).toEqualTypeOf<Expr<number, true, "immutable">>();
expectTypeOf(lower(s)).toEqualTypeOf<Expr<string, false, "immutable">>();
expectTypeOf(concat(s, u)).toEqualTypeOf<Expr<string, false, "immutable">>();
expectTypeOf(coalesce(u, "z")).toEqualTypeOf<Expr<string, false, "immutable">>();
expectTypeOf(nullif(s, "x")).toEqualTypeOf<Expr<string, true, "immutable">>();
expectTypeOf(jsonText(col("j"), "k")).toEqualTypeOf<Expr<string, true, "immutable">>();
expectTypeOf(cast(n, "text")).toEqualTypeOf<Expr<string, false, "immutable">>();
expectTypeOf(atTimeZone(ts, "UTC")).toEqualTypeOf<Expr<Timestamp, false, "immutable">>();
expectTypeOf(and({ n: gt(1) })).toEqualTypeOf<Expr<boolean, false, "immutable">>();
expectTypeOf(caseWhen([[{ n: gt(5) }, "big"]], "small")).toEqualTypeOf<
  Expr<string, false, "immutable">
>();
expectTypeOf(caseWhen([[{ n: gt(5) }, u]], "small")).toEqualTypeOf<
  Expr<string, true, "immutable">
>();

// Stable helpers.
expectTypeOf(now()).toEqualTypeOf<Expr<Timestamptz, false, "stable">>();
expectTypeOf(setting("app.tenant", "text")).toEqualTypeOf<Expr<string, true, "stable">>();
expectTypeOf(setting("app.ids", "text[]")).toEqualTypeOf<
  Expr<readonly string[], false, "stable">
>();
expectTypeOf(extract("hour", ts)).toEqualTypeOf<Expr<number, false, "stable">>();
expectTypeOf(extract("hour", tn)).toEqualTypeOf<Expr<number, false, "immutable">>();
expectTypeOf(cast(ts, "text")).toEqualTypeOf<Expr<string, false, "stable">>();

// Volatility spreads: one stable operand makes the result stable.
expectTypeOf(add(n, extract("hour", ts))).toEqualTypeOf<Expr<number, false, "stable">>();
expectTypeOf(and({ n: gt(1) }, and({ n: gt(2) }))).toEqualTypeOf<
  Expr<boolean, false, "immutable">
>();

// A place that needs an immutable expression.
declare function generated<E extends ImmutableExpr>(expression: E): E;
declare function policy<E extends StableExpr>(expression: E): E;

generated(add(n, 1));
generated(concat(s, u));
generated(extract("hour", tn));
generated(atTimeZone(ts, "UTC"));
// @ts-expect-error now() is stable
generated(now());
// @ts-expect-error a setting is stable
generated(setting("app.tenant", "text"));
// @ts-expect-error a part of a timestamptz depends on the session zone
generated(extract("hour", ts));
// @ts-expect-error one stable operand makes the sum stable
generated(add(n, extract("hour", ts)));
// @ts-expect-error a cast from a timestamptz is stable
generated(cast(ts, "text"));

policy(now());
policy(setting("app.tenant", "text"));
policy(add(n, 1));

// Operands.
// @ts-expect-error add takes numbers
add(s, 1);
// @ts-expect-error lower takes text
lower(n);
// @ts-expect-error extract reads a timestamp or a date
extract("year", n);
// @ts-expect-error a list setting type is closed
setting("app.x", "jsonb");
// @ts-expect-error atTimeZone reads a timestamptz
atTimeZone(tn, "UTC");
// @ts-expect-error and takes where objects and boolean expressions, not a timestamp
and(now());
