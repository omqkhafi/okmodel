/**
 * Composed SQL fragments (rule 15, D266).
 *
 * The check-constraint `sql` tag stays a string. A query fragment is a tagged
 * operator named `sql`, so the planner compiles it on the existing lazy
 * operator path. Values are parameters. `ident` stores a name the compiler
 * quotes. `fragment.column` is the where field the fragment is attached to.
 */

import { OkmError } from "../../../contracts/error.js";
import { assertNoControl } from "../operator-fit.js";
import { isOperator, operatorName, operatorValue, tag, type Eq } from "../operators.js";
import type { Window } from "./window.js";

declare const identBrand: unique symbol;
declare const columnBrand: unique symbol;

const IDENT = Symbol("okmodel.sql.ident");
const COLUMN = Symbol("okmodel.sql.column");

/** One piece of a fragment. The compiler walks this list. */
export type FragmentPart =
  | { readonly k: "t"; readonly s: string }
  | { readonly k: "p"; readonly v: string }
  | { readonly k: "n" }
  | { readonly k: "i"; readonly n: string }
  | { readonly k: "c" }
  | { readonly k: "f"; readonly parts: readonly FragmentPart[] };

/** A name `ident` stored. The compiler quotes it. */
export type FragmentIdent = { readonly [identBrand]: string };

/** The where field a fragment is attached to. */
export type FragmentColumn = { readonly [columnBrand]: true };

/**
 * A composed fragment.
 *
 * It is a where operand. `.as(name)` is the select form, and that result is a
 * number.
 */
export type Fragment = Eq<never> & {
  /**
   * Names the select result.
   *
   * @typeParam A - Result key
   * @param name - Result key. Not a column name
   * @returns A select entry
   */
  as<const A extends string>(name: A): Window<A, number>;
};

/**
 * Throws OKM1125.
 *
 * @param message - What is wrong
 * @param fix - What to change
 * @returns Never
 */
function fragmentError(message: string, fix: string): never {
  throw new OkmError("OKM1125", message, { fix: { summary: fix } });
}

/**
 * Reports whether `value` is the part list `fragment` stored.
 *
 * @param value - Operator operand
 * @returns `true` when every part has a known kind
 */
export function isFragmentParts(value: unknown): value is readonly FragmentPart[] {
  return Array.isArray(value) && value.every(isPart);
}

function isPart(value: unknown): value is FragmentPart {
  if (typeof value !== "object" || value === null || !("k" in value)) return false;
  const kind = value.k;
  if (kind === "t") return "s" in value && typeof value.s === "string";
  if (kind === "p") return "v" in value && typeof value.v === "string";
  if (kind === "n" || kind === "c") return true;
  if (kind === "i") return "n" in value && typeof value.n === "string";
  if (kind === "f") return "parts" in value && isFragmentParts(value.parts);
  return false;
}

/**
 * Reads a select fragment.
 *
 * @param value - One `select` entry
 * @returns The result name and the parts, or `undefined` when it is not a fragment
 */
export function readSelectFragment(
  value: unknown,
):
  | { readonly as: string; readonly parts: readonly FragmentPart[]; readonly textual?: true }
  | undefined {
  if (!isOperator(value) || operatorName(value) !== "sql") return undefined;
  const named = value as { readonly as?: unknown; readonly text?: unknown };
  if (typeof named.as !== "string") {
    fragmentError(
      "A select fragment needs as(name).",
      'Call .as("len") and pass that value in select.',
    );
  }
  const stored = operatorValue(value);
  if (!isFragmentParts(stored)) {
    fragmentError("A fragment was not created by fragment``.", "Call fragment`...`.");
  }
  const textual = named.text === true;
  return textual ? { as: named.as, parts: stored, textual: true } : { as: named.as, parts: stored };
}

type Scan = { quote: "'" | '"' | undefined; paren: number };

/**
 * Checks one literal and updates quote and parenthesis depth.
 *
 * An interpolation is refused while a quote is open, so a value cannot land
 * inside a string. `$`, `;`, and comments are refused outside quotes so the
 * fragment cannot close the tenant predicate or number its own parameters.
 *
 * @param literal - One template literal
 * @param state - Quote and depth carried across literals
 */
function scanLiteral(literal: string, state: Scan): void {
  for (let index = 0; index < literal.length; index += 1) {
    const char = literal[index] ?? "";
    const code = literal.charCodeAt(index);
    if (state.quote !== undefined) {
      if (char !== state.quote) continue;
      if (literal[index + 1] === state.quote) {
        index += 1;
        continue;
      }
      state.quote = undefined;
      continue;
    }
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      fragmentError(
        "A fragment literal contains a control character.",
        "Remove NUL and other control characters. A newline, tab, or return is allowed.",
      );
    }
    if (char === "'" || char === '"') {
      state.quote = char;
      continue;
    }
    if (char === "(") {
      state.paren += 1;
      continue;
    }
    if (char === ")") {
      state.paren -= 1;
      if (state.paren < 0) {
        fragmentError(
          "A fragment has unbalanced SQL.",
          "Keep parentheses and quotes balanced. A fragment cannot close the surrounding predicate.",
        );
      }
      continue;
    }
    if (char === ";") {
      fragmentError(
        "A fragment cannot include a semicolon.",
        "Pass the value as an interpolation. The fragment is one expression.",
      );
    }
    if (char === "$") {
      fragmentError(
        "A fragment cannot include a dollar quote or a parameter marker.",
        "Interpolate the value. The planner numbers parameters.",
      );
    }
    if (
      (char === "-" && literal[index + 1] === "-") ||
      (char === "/" && literal[index + 1] === "*")
    ) {
      fragmentError(
        "A fragment cannot include a comment.",
        "Remove the comment. A comment can hide the rest of the predicate.",
      );
    }
  }
}

function appendText(parts: FragmentPart[], literal: string): void {
  if (literal.length === 0) return;
  parts.push({ k: "t", s: literal });
}

function appendValue(parts: FragmentPart[], value: unknown): void {
  if (value === null) {
    parts.push({ k: "n" });
    return;
  }
  if (typeof value === "string") {
    parts.push({ k: "p", v: value });
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fragmentError("A fragment needs a finite number.", "Pass a finite number, or leave it out.");
    }
    parts.push({ k: "p", v: String(value) });
    return;
  }
  if (typeof value === "boolean") {
    parts.push({ k: "p", v: value ? "true" : "false" });
    return;
  }
  if (typeof value === "bigint") {
    parts.push({ k: "p", v: String(value) });
    return;
  }
  if (typeof value === "object") {
    if (COLUMN in value) {
      parts.push({ k: "c" });
      return;
    }
    if (IDENT in value) {
      const name = value[IDENT];
      if (typeof name === "string") {
        parts.push({ k: "i", n: name });
        return;
      }
    }
    if (isOperator(value) && operatorName(value) === "sql") {
      const nested = operatorValue(value);
      if (!isFragmentParts(nested)) {
        fragmentError("A fragment was not created by fragment``.", "Call fragment`...`.");
      }
      parts.push({ k: "f", parts: nested });
      return;
    }
  }
  fragmentError(
    "A fragment cannot interpolate that value.",
    "Interpolate a string, number, boolean, null, ident(name), fragment.column, or another fragment.",
  );
}

function hasSql(parts: readonly FragmentPart[]): boolean {
  for (const part of parts) {
    if (part.k === "t") {
      if (part.s.trim().length > 0) return true;
      continue;
    }
    return true;
  }
  return false;
}

function compile(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): readonly FragmentPart[] {
  const state: Scan = { quote: undefined, paren: 0 };
  const parts: FragmentPart[] = [];
  for (let index = 0; index < values.length + 1; index += 1) {
    const literal = strings[index] ?? "";
    scanLiteral(literal, state);
    appendText(parts, literal);
    if (index === values.length) continue;
    if (state.quote !== undefined) {
      fragmentError(
        "A fragment cannot interpolate inside quotes.",
        "Do not put an interpolation inside quotes. Write title = ${name}.",
      );
    }
    appendValue(parts, values[index]);
  }
  if (state.quote !== undefined || state.paren !== 0) {
    fragmentError(
      "A fragment has unbalanced SQL.",
      "Keep parentheses and quotes balanced. A fragment cannot close the surrounding predicate.",
    );
  }
  if (!hasSql(parts)) {
    fragmentError("A fragment needs SQL text.", "Write an expression, or interpolate a value.");
  }
  return parts;
}

function isTemplate(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && "raw" in value;
}

function bind(parts: readonly FragmentPart[], textual = false): Fragment {
  const tagged = tag("sql", parts);
  return Object.assign(tagged, {
    as<const A extends string>(name: A): Window<A, number> {
      if (typeof name !== "string" || name.length === 0) {
        fragmentError(
          "as(name) needs a result name.",
          'Call .as("len") with a name that is not a column.',
        );
      }
      assertNoControl(name, "fragment as");
      const selected = Object.assign(tag("sql", parts), { as: name });
      return (textual ? Object.assign(selected, { text: true }) : selected) as unknown as Window<
        A,
        number
      >;
    },
  }) as unknown as Fragment;
}

/**
 * A function call stored as a `sql` fragment.
 *
 * The planner compiles it on the same path as {@link fragment}. `textual`
 * makes `.as(name)` keep the wire string. A numeric call parses a number.
 *
 * @param parts - Expression parts, including the function name
 * @param textual - When true, a select result stays text
 * @returns A where operand. Call `.as(name)` to use it in `select`
 */
export function sqlExpression(parts: readonly FragmentPart[], textual = false): Fragment {
  return bind(parts, textual);
}

/**
 * Reads the field name `ident` stored.
 *
 * @param value - A fragment interpolation
 * @returns The field name, or `undefined` when `value` is not an ident
 */
export function identName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !(IDENT in value)) return undefined;
  const stored = (value as { readonly [IDENT]: unknown })[IDENT];
  return typeof stored === "string" ? stored : undefined;
}

/**
 * Builds a composed SQL fragment.
 *
 * Call it as a template. A string, number, boolean, or null is a parameter.
 * `ident(name)` names a field. The compiler quotes that column. `fragment.column` is the where field.
 * Another fragment is nested and parenthesized. The literal SQL cannot close
 * the surrounding predicate.
 *
 * @param strings - Literal SQL
 * @param values - Parameters, identifiers, the column, or nested fragments
 * @returns A where operand. Call `.as(name)` to use it in `select`
 */
function fragmentTag(strings: TemplateStringsArray, ...values: readonly unknown[]): Fragment {
  if (!isTemplate(strings)) {
    fragmentError(
      "Call fragment as a template: fragment`...`.",
      "Write fragment`length(${fragment.column}) > ${1}`.",
    );
  }
  return bind(compile(strings, values));
}

/**
 * A composed SQL fragment.
 *
 * `column` is the where field this fragment is attached to.
 */
export const fragment: {
  /**
   * Builds a composed SQL fragment.
   *
   * @param strings - Literal SQL
   * @param values - Parameters, identifiers, the column, or nested fragments
   * @returns A where operand
   */
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Fragment;
  /** The where field this fragment is attached to, quoted by the compiler. */
  readonly column: FragmentColumn;
} = Object.assign(fragmentTag, {
  column: { [COLUMN]: true } as unknown as FragmentColumn,
});

/**
 * Stores a field name for a fragment to resolve.
 *
 * The name is the TypeScript field, the same name `where` uses. Casing and
 * `sqlName` are applied when the compiler quotes the column. A hidden field
 * is OKM1120 at planning. Empty names and control characters are OKM1122.
 *
 * @param name - Field name
 * @returns A value `fragment` resolves against the table
 */
export function ident(name: string): FragmentIdent {
  if (typeof name !== "string" || name.length === 0) {
    throw new OkmError("OKM1122", "ident needs a name.", {
      fix: { summary: "Pass the field name, such as title." },
    });
  }
  assertNoControl(name, "ident");
  return { [IDENT]: name } as unknown as FragmentIdent;
}
