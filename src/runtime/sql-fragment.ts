/**
 * SQL for a composed fragment.
 *
 * Loaded with the operator compiler and with a `select` that contains a
 * fragment. A featureless read does not import it. Parameters are bound.
 * `ident` names the TypeScript field, the same name `where` uses. The compiler
 * quotes that column's SQL name. A hidden field is refused. The fragment is
 * parenthesized so it cannot remove the tenant predicate.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import { isFragmentParts, type FragmentPart } from "../dialects/pg/ops/fragment.js";
import { fail, list, quote, refuseHidden, type Indexed, type Sink } from "./plan.js";

/**
 * Writes a where fragment.
 *
 * `ref` is the field the fragment is attached to, already quoted and aliased.
 * `fragment.column` emits that reference.
 *
 * @param table - The table the where field belongs to
 * @param ref - `alias."column"`
 * @param value - Parts the template stored
 * @param sink - Statement builder
 */
export function emitSqlValue(table: Indexed, ref: string, value: unknown, sink: Sink): void {
  const dot = ref.indexOf(".");
  const alias = dot < 0 ? ref : ref.slice(0, dot);
  writeFragment(requireParts(value), sink, alias, ref, table, "where");
}

/**
 * Writes a select fragment.
 *
 * There is no where field, so `fragment.column` is OKM1125.
 *
 * @param table - The read table
 * @param parts - Parts the template stored
 * @param sink - Statement builder
 * @param alias - Table alias, `t` on a root read
 */
export function emitSqlSelect(
  table: Indexed,
  parts: readonly FragmentPart[],
  sink: Sink,
  alias: string,
): void {
  writeFragment(parts, sink, alias, undefined, table, "select");
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
  table: Indexed,
  place: "where" | "select",
): void {
  sink.mark(":g");
  sink.text("(");
  for (const part of parts) writePart(part, sink, alias, ref, table, place);
  sink.mark(":g");
  sink.text(")");
}

function writePart(
  part: FragmentPart,
  sink: Sink,
  alias: string,
  ref: string | undefined,
  table: Indexed,
  place: "where" | "select",
): void {
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
    writeIdent(part.n, table, sink, alias, place);
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
  writeFragment(part.parts, sink, alias, ref, table, place);
}

/**
 * Quotes one field.
 *
 * The name is the TypeScript field, the same key `where` uses. The SQL name
 * already includes casing and `sqlName`. A hidden field is OKM1120. In
 * `select` that includes `hidden({ filterable: true })`.
 *
 * @param name - Field name from `ident`
 * @param table - Table the fragment is compiled against
 * @param sink - Statement builder
 * @param alias - Table alias
 * @param place - `where` allows a filterable hidden field. `select` does not
 */
function writeIdent(
  name: string,
  table: Indexed,
  sink: Sink,
  alias: string,
  place: "where" | "select",
): void {
  const column = table.columns.get(name);
  if (column === undefined) {
    throwNamed(
      "OKM1120",
      name,
      table.names,
      `Field ${name} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
    );
  }
  if (place === "select") {
    if (column.hidden) {
      fail(
        "OKM1120",
        `Field ${column.field} is hidden.`,
        "A select fragment cannot name a hidden field.",
      );
    }
  } else {
    refuseHidden(column);
  }
  sink.mark(`:i:${String(column.field.length)}:${column.field}`);
  sink.text(alias);
  sink.text(".");
  sink.text(quote(column.sql));
}
