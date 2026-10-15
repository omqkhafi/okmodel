/**
 * SQL for a composed fragment.
 *
 * Loaded with the operator compiler and with a `select` that contains a
 * fragment. A featureless read does not import it. Parameters are bound.
 * Identifiers go through {@link quote}. The fragment is parenthesized so it
 * cannot remove the tenant predicate.
 */

import { OkmError } from "../contracts/error.js";
import { isFragmentParts, type FragmentPart } from "../dialects/pg/ops/fragment.js";
import { quote, type Sink } from "./plan.js";

/**
 * Writes a where fragment.
 *
 * `ref` is the field the fragment is attached to, already quoted and aliased.
 * `fragment.column` emits that reference.
 *
 * @param ref - `alias."column"`
 * @param value - Parts the template stored
 * @param sink - Statement builder
 */
export function emitSqlValue(ref: string, value: unknown, sink: Sink): void {
  const dot = ref.indexOf(".");
  const alias = dot < 0 ? ref : ref.slice(0, dot);
  writeFragment(requireParts(value), sink, alias, ref);
}

/**
 * Writes a select fragment.
 *
 * There is no where field, so `fragment.column` is OKM1125.
 *
 * @param parts - Parts the template stored
 * @param sink - Statement builder
 * @param alias - Table alias, `t` on a root read
 */
export function emitSqlSelect(parts: readonly FragmentPart[], sink: Sink, alias: string): void {
  writeFragment(parts, sink, alias, undefined);
}

/**
 * Reads a select fragment as a number.
 *
 * The wire is text. A value that is not a finite number is OKM1125.
 *
 * @param wire - Driver text
 * @returns The number
 */
export function decodeSqlNumber(wire: string): number {
  const parsed = Number(wire);
  if (!Number.isFinite(parsed)) {
    throw new OkmError("OKM1125", "A select fragment must be a number.", {
      fix: { summary: "Use a numeric expression, such as length(title). Text stays in where." },
    });
  }
  return parsed;
}

function requireParts(value: unknown): readonly FragmentPart[] {
  if (!isFragmentParts(value)) {
    throw new OkmError("OKM1125", "A fragment was not created by fragment``.", {
      fix: { summary: "Call fragment`...`." },
    });
  }
  return value;
}

function writeFragment(
  parts: readonly FragmentPart[],
  sink: Sink,
  alias: string,
  ref: string | undefined,
): void {
  sink.mark(":g");
  sink.text("(");
  for (const part of parts) writePart(part, sink, alias, ref);
  sink.mark(":g");
  sink.text(")");
}

function writePart(part: FragmentPart, sink: Sink, alias: string, ref: string | undefined): void {
  if (part.k === "t") {
    sink.mark(`:t:${String(part.s.length)}:${part.s}`);
    sink.text(part.s);
    return;
  }
  if (part.k === "p") {
    sink.mark(":p");
    sink.param(part.v);
    return;
  }
  if (part.k === "n") {
    sink.mark(":n");
    sink.text("null");
    return;
  }
  if (part.k === "i") {
    sink.mark(`:i:${String(part.n.length)}:${part.n}`);
    sink.text(alias);
    sink.text(".");
    sink.text(quote(part.n));
    return;
  }
  if (part.k === "c") {
    if (ref === undefined) {
      throw new OkmError("OKM1125", "fragment.column belongs on a where field.", {
        fix: { summary: "Use ident(name) in select, or put fragment.column on a where field." },
      });
    }
    sink.mark(":c");
    sink.text(ref);
    return;
  }
  writeFragment(part.parts, sink, alias, ref);
}
