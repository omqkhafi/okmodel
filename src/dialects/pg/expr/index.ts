/**
 * `okmodel/expr`.
 *
 * Typed SQL expressions as plain data. A helper returns a node that carries
 * its result type, whether it can be null, and its volatility in its
 * TypeScript type. The SQL is printed in tooling (`okmodel/migrate`), never
 * here, so importing this file adds no SQL printer to an application.
 *
 * A place that needs an immutable expression, such as a generated column or an
 * expression index, takes {@link ImmutableExpr}. A stable helper like `now()`
 * or `setting()` is then a compile error. Comparisons are the `where`
 * operators (`eq`, `lt`, `between`, `or`, `not`), and a column operand
 * compares one column with another: `{ a: lt(col("b")) }`.
 */

import { OkmError } from "../../../contracts/error.js";
import { arrayElement } from "../quote.js";

const EXPR = Symbol.for("okmodel.expr");

/** Output name set by {@link Expr.as}. Not enumerable, so node equality ignores it. */
export const EXPR_AS = Symbol.for("okmodel.expr.as");

/** How much the database may change the answer for the same inputs. */
export type Volatility = "immutable" | "stable" | "volatile";

declare const meta: unique symbol;

/** A timestamp with a time zone. Reading its parts depends on the session zone. */
export type Timestamptz = string & { readonly "~pg": "timestamptz" };
/** A timestamp without a time zone. */
export type Timestamp = string & { readonly "~pg": "timestamp" };
/** A calendar date. */
export type DateText = string & { readonly "~pg": "date" };

/** A where object. Its operands are checked by the scratch database, not by the compiler. */
export type Cond = Readonly<Record<string, unknown>> & { readonly [EXPR]?: never };

/**
 * One expression: a plain data node plus its types.
 *
 * `T` is the TypeScript type, `N` whether the result can be null, and `V`
 * the volatility. The three live only in the type.
 */
export type Expr<T = unknown, N extends boolean = boolean, V extends Volatility = Volatility> = {
  readonly [EXPR]: Node;
  readonly [meta]?: { readonly type: T; readonly nullable: N; readonly volatility: V };
  /**
   * Names this expression as a select column.
   *
   * @param name - Output column name
   * @returns The same expression, named
   */
  as<const Name extends string>(name: Name): Expr<T, N, V> & { readonly "~as": Name };
};

/** An expression a generated column or an index expression accepts. */
export type ImmutableExpr<T = unknown, N extends boolean = boolean> = Expr<T, N, "immutable">;

/** An expression that is stable or better. Fixed per statement, not per row. */
export type StableExpr<T = unknown, N extends boolean = boolean> = Expr<
  T,
  N,
  "immutable" | "stable"
>;

/** What the node is. Printed to SQL by `okmodel/migrate`. */
export type Node =
  | { readonly k: "col"; readonly name: string }
  | { readonly k: "field"; readonly e: Node; readonly name: string }
  | { readonly k: "lit"; readonly v: string | number | bigint | boolean | null }
  | {
      readonly k: "op";
      readonly op: "+" | "-" | "*" | "/" | "%";
      readonly a: Node;
      readonly b: Node;
    }
  | {
      readonly k: "fn";
      readonly name:
        | "lower"
        | "upper"
        | "length"
        | "coalesce"
        | "nullif"
        | "now"
        | "to_tsvector"
        | "setweight";
      readonly args: readonly Node[];
    }
  | { readonly k: "concat"; readonly args: readonly Node[] }
  | { readonly k: "cast"; readonly e: Node; readonly to: CastTo }
  | { readonly k: "json"; readonly e: Node; readonly key: string }
  | { readonly k: "extract"; readonly field: ExtractField; readonly e: Node }
  | { readonly k: "tz"; readonly e: Node; readonly zone: string }
  | {
      readonly k: "case";
      readonly branches: readonly (readonly [Cond, Node])[];
      readonly otherwise: Node;
    }
  | { readonly k: "setting"; readonly name: string; readonly type: SettingType }
  | { readonly k: "and"; readonly parts: readonly (Cond | Node)[] };

type Operand = Expr | string | number | bigint | boolean | null;
/** A column handle. `name` is the SQL name. */
type Named = { readonly name: string };

type Num = Expr<number, boolean, Volatility> | number | Named;
type Text = Expr<string, boolean, Volatility> | string | Named;

type VolOf<A> = A extends Expr<unknown, boolean, infer V> ? V : "immutable";
type NullOf<A> = A extends Expr<unknown, infer N, Volatility> ? N : A extends null ? true : false;
type TypeOf<A> =
  A extends Expr<infer T, boolean, Volatility>
    ? T
    : A extends string
      ? string
      : A extends number
        ? number
        : A extends bigint
          ? bigint
          : A extends boolean
            ? boolean
            : never;
type Worst<U extends Volatility> = "volatile" extends U
  ? "volatile"
  : "stable" extends U
    ? "stable"
    : "immutable";
type Any<U extends boolean> = true extends U ? true : false;
type TimeLike = Timestamptz | Timestamp | DateText;

/** Types `cast` can produce. */
export type CastTypes = {
  readonly smallint: number;
  readonly integer: number;
  readonly bigint: bigint;
  readonly numeric: string;
  readonly real: number;
  readonly "double precision": number;
  readonly text: string;
  readonly boolean: boolean;
  readonly date: DateText;
  readonly timestamp: Timestamp;
  readonly timestamptz: Timestamptz;
};
type CastTo = keyof CastTypes;
const CAST_TYPES: ReadonlySet<string> = new Set([
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "text",
  "boolean",
  "date",
  "timestamp",
  "timestamptz",
]);

/** Parts `extract` reads. */
export type ExtractField =
  | "year"
  | "quarter"
  | "month"
  | "week"
  | "day"
  | "dow"
  | "doy"
  | "hour"
  | "minute"
  | "second"
  | "epoch";
const EXTRACT_FIELDS: ReadonlySet<string> = new Set([
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "dow",
  "doy",
  "hour",
  "minute",
  "second",
  "epoch",
]);

/** Types `setting` reads. A list type ends in `[]`. */
export type SettingTypes = {
  readonly text: string;
  readonly integer: number;
  readonly bigint: bigint;
  readonly boolean: boolean;
  readonly uuid: string;
  readonly "text[]": readonly string[];
  readonly "integer[]": readonly number[];
  readonly "uuid[]": readonly string[];
};
type SettingType = keyof SettingTypes;
const SETTING_TYPES: ReadonlySet<string> = new Set([
  "text",
  "integer",
  "bigint",
  "boolean",
  "uuid",
  "text[]",
  "integer[]",
  "uuid[]",
]);

/**
 * Reports whether `value` came from a helper of this module.
 *
 * @param value - Any value
 * @returns `true` for an expression
 */
export function isExpr(value: unknown): value is Expr {
  return typeof value === "object" && value !== null && EXPR in value;
}

function isNamed(value: unknown): value is Named {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    !("text" in value) &&
    !(EXPR in value)
  );
}

/**
 * Reads the plain data node of an expression.
 *
 * @param value - An expression
 * @returns The node `okmodel/migrate` prints
 */
export function nodeOf(value: Expr): Node {
  return value[EXPR];
}

function make<T, N extends boolean, V extends Volatility>(node: Node): Expr<T, N, V> {
  const expr = { [EXPR]: node } as Expr<T, N, V>;
  Object.defineProperty(expr, "as", {
    enumerable: false,
    writable: false,
    value<const Name extends string>(name: Name): Expr<T, N, V> & { readonly "~as": Name } {
      if (typeof name !== "string" || name.length === 0) {
        throw new OkmError("OKM1120", "as() needs a column name.", {
          fix: { summary: "Pass the output column name." },
        });
      }
      const named = make<T, N, V>(node);
      Object.defineProperty(named, EXPR_AS, { value: name, enumerable: false });
      return named as Expr<T, N, V> & { readonly "~as": Name };
    },
  });
  return expr;
}

function lift(value: unknown): Node {
  if (isExpr(value)) return value[EXPR];
  if (isNamed(value)) return { k: "col", name: value.name };
  if (value === null || typeof value === "boolean" || typeof value === "bigint") {
    return { k: "lit", v: value };
  }
  if (typeof value === "string" && !value.includes("\0")) return { k: "lit", v: value };
  if (typeof value === "number" && Number.isFinite(value)) return { k: "lit", v: value };
  throw new OkmError(
    "OKM1120",
    "An expression operand is an expression, a column, a string, a finite number, a bigint, a boolean, or null.",
    {
      fix: { summary: "Pass one of those. Dates and other objects go through cast or a column." },
    },
  );
}

/**
 * A column of the table the expression sits on.
 *
 * @typeParam T - TypeScript type of the column
 * @typeParam N - `true` when the column can be null
 * @param name - Column name
 * @returns An immutable expression
 */
export function col<T = unknown, N extends boolean = false>(name: string): Expr<T, N, "immutable"> {
  return make({ k: "col", name });
}

/**
 * One field of a composite expression.
 *
 * Prints `(expr)."name"`. Indexes and generated columns use this. A query
 * path `"home.city"` is not this function.
 *
 * @param expr - Composite expression, usually a column
 * @param name - Field name
 * @returns An immutable expression of the field
 */
export function field<T = unknown, N extends boolean = boolean>(
  expr: Expr<unknown, N, "immutable">,
  name: string,
): Expr<T, N, "immutable"> {
  return make({ k: "field", e: expr[EXPR], name });
}

function binary(op: "+" | "-" | "*" | "/" | "%", a: unknown, b: unknown): Expr {
  return make({ k: "op", op, a: lift(a), b: lift(b) });
}

/** `a + b`. */
export function add<const A extends Num, const B extends Num>(
  a: A,
  b: B,
): Expr<number, Any<NullOf<A> | NullOf<B>>, Worst<VolOf<A> | VolOf<B>>> {
  return binary("+", a, b) as never;
}

/** `a - b`. */
export function sub<const A extends Num, const B extends Num>(
  a: A,
  b: B,
): Expr<number, Any<NullOf<A> | NullOf<B>>, Worst<VolOf<A> | VolOf<B>>> {
  return binary("-", a, b) as never;
}

/** `a * b`. */
export function mul<const A extends Num, const B extends Num>(
  a: A,
  b: B,
): Expr<number, Any<NullOf<A> | NullOf<B>>, Worst<VolOf<A> | VolOf<B>>> {
  return binary("*", a, b) as never;
}

/** `a / b`. Integer operands divide as integers. A zero divisor fails when the statement runs. */
export function div<const A extends Num, const B extends Num>(
  a: A,
  b: B,
): Expr<number, Any<NullOf<A> | NullOf<B>>, Worst<VolOf<A> | VolOf<B>>> {
  return binary("/", a, b) as never;
}

/** `a % b`. */
export function mod<const A extends Num, const B extends Num>(
  a: A,
  b: B,
): Expr<number, Any<NullOf<A> | NullOf<B>>, Worst<VolOf<A> | VolOf<B>>> {
  return binary("%", a, b) as never;
}

/**
 * Every part holds. A part is a where object or a boolean expression.
 *
 * Operands inside a where object are not tracked by the type, so Postgres is
 * the judge of those (see `checkScratch`).
 *
 * @param parts - Where objects and boolean expressions
 * @returns A boolean expression
 */
export function and<const P extends readonly (Cond | Expr<boolean>)[]>(
  ...parts: P
): Expr<boolean, false, Worst<VolOf<P[number]>>> {
  return make({ k: "and", parts: parts.map((part) => (isExpr(part) ? part[EXPR] : part)) });
}

/** `lower(text)`. */
export function lower<const A extends Text>(value: A): Expr<string, NullOf<A>, Worst<VolOf<A>>> {
  return make({ k: "fn", name: "lower", args: [lift(value)] });
}

/** `upper(text)`. */
export function upper<const A extends Text>(value: A): Expr<string, NullOf<A>, Worst<VolOf<A>>> {
  return make({ k: "fn", name: "upper", args: [lift(value)] });
}

/** `length(text)`: characters. */
export function length<const A extends Text>(value: A): Expr<number, NullOf<A>, Worst<VolOf<A>>> {
  return make({ k: "fn", name: "length", args: [lift(value)] });
}

/**
 * `to_tsvector(config, text)`.
 *
 * The configuration is a constant, so the call is immutable.
 *
 * @param config - Text search configuration, such as `english`
 * @param value - Text to parse
 * @returns A tsvector expression
 */
export function toTsvector(
  config: string,
  value: string | Expr<unknown, boolean, Volatility>,
): Expr<string, boolean, "immutable"> {
  if (config.length === 0 || config.includes("'") || config.includes("\0")) {
    throw new OkmError("OKM1120", "toTsvector needs a text search configuration name.", {
      fix: { summary: "Pass a name such as english or simple." },
    });
  }
  return make({
    k: "fn",
    name: "to_tsvector",
    args: [{ k: "lit", v: config }, lift(value)],
  }) as Expr<string, boolean, "immutable">;
}

/**
 * `setweight(vector, weight)`.
 *
 * The weight is a constant `A`, `B`, `C`, or `D`, so the call is immutable.
 *
 * @param value - A tsvector expression
 * @param weight - Weight letter
 * @returns The weighted vector
 */
export function setweight(
  value: Expr<unknown, boolean, Volatility> | Expr<string, boolean, Volatility>,
  weight: "A" | "B" | "C" | "D",
): Expr<string, boolean, "immutable"> {
  return make({
    k: "fn",
    name: "setweight",
    args: [nodeOf(value), { k: "lit", v: weight }],
  }) as Expr<string, boolean, "immutable">;
}

/**
 * Text joined with a missing part read as empty: `coalesce(a, '') || coalesce(b, '')`.
 *
 * This is immutable, unlike SQL `concat()`, so it can sit in a generated column.
 *
 * @param parts - Text operands, at least one
 * @returns A text expression that is never null
 */
export function concat<const P extends readonly [Text, ...Text[]]>(
  ...parts: P
): Expr<string, false, Worst<VolOf<P[number]>>> {
  return make({ k: "concat", args: parts.map(lift) });
}

/** The first operand that is not null. The last one decides whether the result can be null. */
export function coalesce<const A extends Operand, const B extends Operand>(
  a: A,
  b: B,
): Expr<TypeOf<A> | TypeOf<B>, NullOf<B>, Worst<VolOf<A> | VolOf<B>>> {
  return make({ k: "fn", name: "coalesce", args: [lift(a), lift(b)] });
}

/** Null when the operands are equal, otherwise `a`. The result can be null. */
export function nullif<const A extends Operand, const B extends Operand>(
  a: A,
  b: B,
): Expr<TypeOf<A>, true, Worst<VolOf<A> | VolOf<B>>> {
  return make({ k: "fn", name: "nullif", args: [lift(a), lift(b)] });
}

type IsTime<T> = [T] extends [never] ? false : [T] extends [TimeLike] ? true : false;
type CastExtra<A, To extends CastTo> =
  IsTime<TypeOf<A>> extends true ? "stable" : IsTime<CastTypes[To]> extends true ? "stable" : never;

/**
 * `e::type`.
 *
 * A cast to or from a date or time type is stable: it can depend on the
 * session. Any other cast keeps the operand's volatility.
 *
 * @param value - Operand
 * @param to - Target type
 * @returns A typed expression
 */
export function cast<const A extends Operand, const To extends CastTo>(
  value: A,
  to: To,
): Expr<CastTypes[To], NullOf<A>, Worst<VolOf<A> | CastExtra<A, To>>> {
  if (!CAST_TYPES.has(to)) {
    throw new OkmError("OKM1120", `cast does not know the type ${String(to)}.`, {
      fix: { summary: `Cast to one of ${[...CAST_TYPES].join(", ")}.` },
    });
  }
  return make({ k: "cast", e: lift(value), to });
}

/**
 * `jsonb ->> 'key'`: one key of a jsonb document as text. Null when the key is missing.
 *
 * @param value - A jsonb operand
 * @param key - Key name
 * @returns A nullable text expression
 */
export function jsonText<const A extends Expr>(
  value: A,
  key: string,
): Expr<string, true, Worst<VolOf<A>>> {
  return make({ k: "json", e: lift(value), key });
}

type ExtractVol<A> = TypeOf<A> extends Timestamptz ? "stable" : never;

/**
 * `extract(field from e)`.
 *
 * Reading a part of a `timestamptz` depends on the session time zone, so it is
 * stable. On a `timestamp` or a `date` it is immutable.
 *
 * @param field - Part to read
 * @param value - A timestamp or date operand
 * @returns A numeric expression
 */
export function extract<const A extends Expr<TimeLike, boolean, Volatility>>(
  field: ExtractField,
  value: A,
): Expr<number, NullOf<A>, Worst<VolOf<A> | ExtractVol<A>>> {
  if (!EXTRACT_FIELDS.has(field)) {
    throw new OkmError("OKM1120", `extract does not know the part ${String(field)}.`, {
      fix: { summary: `Read one of ${[...EXTRACT_FIELDS].join(", ")}.` },
    });
  }
  return make({ k: "extract", field, e: lift(value) });
}

/**
 * `e AT TIME ZONE 'zone'`: the wall-clock time in a fixed zone. Immutable.
 *
 * @param value - A `timestamptz` operand
 * @param zone - A zone name such as `UTC`, fixed in the expression
 * @returns A `timestamp` expression
 */
export function atTimeZone<const A extends Expr<Timestamptz, boolean, Volatility>>(
  value: A,
  zone: string,
): Expr<Timestamp, NullOf<A>, Worst<VolOf<A>>> {
  if (typeof zone !== "string" || zone.length === 0 || zone.includes("\0")) {
    throw new OkmError("OKM1120", "atTimeZone needs a zone name.", {
      fix: { summary: "Pass a fixed zone such as 'UTC'." },
    });
  }
  return make({ k: "tz", e: lift(value), zone });
}

type Arm = Expr | string | number | bigint | boolean | null;

/**
 * `case when <where> then <value> ... else <otherwise> end`.
 *
 * @param branches - Pairs of a where object and the value it selects
 * @param otherwise - Value when no branch matches
 * @returns A typed expression. It is null-able when any arm is
 */
export function caseWhen<const B extends readonly (readonly [Cond, Arm])[], const E extends Arm>(
  branches: B,
  otherwise: E,
): Expr<
  TypeOf<B[number][1]> | TypeOf<E>,
  Any<NullOf<B[number][1]> | NullOf<E>>,
  Worst<VolOf<B[number][1]> | VolOf<E>>
> {
  return make({
    k: "case",
    branches: branches.map(([when, then]) => [when, lift(then)] as const),
    otherwise: lift(otherwise),
  });
}

/**
 * `now()`: the start of the transaction. Stable, so an index or a generated column refuses it.
 *
 * @returns A `timestamptz` expression
 */
export function now(): Expr<Timestamptz, false, "stable"> {
  return make({ k: "fn", name: "now", args: [] });
}

/**
 * A custom setting such as `app.tenant`, read once per statement.
 *
 * It prints `(select nullif(current_setting('app.tenant', true), '')::type)`, so the planner
 * evaluates it once. A list type prints the cast outside the subselect and
 * reads a missing setting as an empty list. Set a list with {@link settingList}.
 *
 * @param name - Setting name
 * @param type - How to read it
 * @returns A stable expression. A scalar can be null, a list cannot
 */
export function setting<const Ty extends SettingType>(
  name: string,
  type: Ty,
): Expr<SettingTypes[Ty], Ty extends `${string}[]` ? false : true, "stable"> {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/i.test(name)) {
    throw new OkmError("OKM1120", `${name} is not a setting name.`, {
      fix: {
        summary: "Use letters, digits, and underscores, with dots between parts: app.tenant.",
      },
    });
  }
  if (!SETTING_TYPES.has(type)) {
    throw new OkmError("OKM1120", `setting does not know the type ${String(type)}.`, {
      fix: { summary: `Read one of ${[...SETTING_TYPES].join(", ")}.` },
    });
  }
  return make({ k: "setting", name, type });
}

/**
 * The value to store in a list setting.
 *
 * Every element is double-quoted, with a backslash and a double quote escaped,
 * so a comma, a brace, a space, an empty string, and the text `NULL` all
 * survive. `null` is the SQL NULL, unquoted. An empty list is `{}`.
 *
 * @param values - Elements
 * @returns Text for `set_config` or `SET`
 */
export function settingList(values: readonly (string | null)[]): string {
  return `{${values.map((value) => (value === null ? "NULL" : arrayElement(value, false))).join(",")}}`;
}
