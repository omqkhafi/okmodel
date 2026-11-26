/**
 * Prints `okmodel/expr` nodes and `where` objects as SQL with no parameters.
 *
 * DDL has no parameters, so an index predicate, a check, or a generated
 * column needs the values written into the statement. A `where` object goes
 * through the same compiler a query uses (`emitWhere`), with a sink that
 * writes each value as a quoted literal. Nothing changes for a query, which
 * still binds parameters.
 */

import { OkmError } from "../../contracts/error.js";
import { printNode } from "../../dialects/pg/expr/print.js";
import { isExpr, nodeOf, type Cond, type Expr, type Node } from "../../dialects/pg/expr/index.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { isOperator, operatorName, operatorValue, tag } from "../../dialects/pg/operators.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import { emitWhere, indexes, type Indexed, type Sink } from "../../runtime/plan.js";

/** The table an expression sits on. Needed for a `where` object inside it. */
export type PrintTable = {
  readonly schema: QuerySchema;
  readonly table: string;
};

/** Stand-in alias. The sink drops it, so a column prints bare. */
const ALIAS = "__okm_where.";
const MARK = "\u0001";

/**
 * Prints a `where` object as a SQL condition with every value inline.
 *
 * Values are quoted literals, so dates, bigints, and text with quotes or
 * backslashes are safe. A value Postgres cannot hold, such as text with a NUL
 * character, or one the column's codec refuses, is refused before any SQL is
 * written. A relation filter is refused: DDL has no second table to join. An
 * `okmodel/expr` expression is a valid operand, which is column-versus-column
 * comparison.
 *
 * @param on - Schema and table name the object filters
 * @param where - A where object, or `or([...])`
 * @returns The condition without the word `where`. `true` for an empty object
 */
export async function printWhere(on: PrintTable, where: unknown): Promise<string> {
  await import("../../runtime/operator-sql.js");
  return whereSql(on, where);
}

/**
 * Prints an expression as SQL.
 *
 * @param expr - A helper's result
 * @param on - Needed when the expression holds a `where` object
 * @returns SQL, parenthesized where precedence could matter
 */
export async function printExpr(expr: Expr, on?: PrintTable): Promise<string> {
  await import("../../runtime/operator-sql.js");
  return nodeSql(nodeOf(expr), on);
}

function whereSql(on: PrintTable, where: unknown): string {
  const table = indexes(on.schema).get(on.table);
  if (table === undefined) {
    throw new OkmError("OKM1120", `The schema has no table ${on.table}.`, {
      fix: { summary: "Name a table the schema declares." },
    });
  }
  const swapped: string[] = [];
  const open = swap(where, swapped, on);
  const columns = new Map(
    [...table.columns].map(([field, column]) => [
      field,
      {
        ...column,
        encode: (value: unknown) =>
          typeof value === "string" && value.startsWith(MARK) ? value : column.encode(value),
      },
    ]),
  );
  const view: Indexed = { ...table, columns, relations: new Map() };
  const parts: string[] = [];
  const sink: Sink = {
    text(value) {
      parts.push(value.startsWith(ALIAS) ? value.slice(ALIAS.length) : value);
    },
    param(encoded) {
      parts.push(literal(encoded, swapped));
    },
    mark() {},
  };
  const bare = { "~byName": {}, model: on.schema.model } satisfies QuerySchema;
  emitWhere(bare, view, open, sink, ALIAS.slice(0, -1), 0, false, undefined, true);
  const text = parts.join("").replace(/^ where /, "");
  return text.length === 0 ? "true" : text;
}

/** Replaces each expression operand with a marker the sink swaps back. */
function swap(value: unknown, found: string[], on: PrintTable): unknown {
  if (isExpr(value)) {
    found.push(nodeSql(nodeOf(value), on));
    return `${MARK}${String(found.length - 1)}${MARK}`;
  }
  if (Array.isArray(value)) return value.map((item) => swap(item, found, on));
  if (isOperator(value)) return tag(operatorName(value), swap(operatorValue(value), found, on));
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, swap(item, found, on)]),
    );
  }
  return value;
}

/**
 * One bound value as a literal.
 *
 * A codec may hand the driver a bigint, a number, or a boolean as is, so the
 * value is not always text.
 */
function literal(encoded: unknown, swapped: readonly string[]): string {
  if (typeof encoded === "bigint") return String(encoded);
  if (typeof encoded === "boolean") return encoded ? "true" : "false";
  if (typeof encoded === "number" && Number.isFinite(encoded)) return String(encoded);
  if (typeof encoded !== "string") {
    throw new OkmError("OKM1120", "That value cannot be written into SQL.", {
      fix: { summary: "Use a string, a finite number, a bigint, a boolean, or null." },
    });
  }
  if (encoded.startsWith(MARK)) {
    const sql = swapped[Number(encoded.slice(1, -1))];
    if (sql !== undefined) return sql;
  }
  if (encoded.includes("\0")) {
    throw new OkmError("OKM1120", "A value with a NUL character cannot be written into SQL.", {
      fix: { summary: "Postgres text cannot hold NUL. Remove it from the value." },
    });
  }
  return quoteLiteral(encoded);
}

function nodeSql(node: Node, on: PrintTable | undefined): string {
  return printNode(
    node,
    (name) => quoteIdent(columnName(name, on)),
    (part) => condSql(part, on),
  );
}

function condSql(where: Cond, on: PrintTable | undefined): string {
  if (on === undefined) {
    throw new OkmError(
      "OKM1120",
      "A where object inside an expression needs the table it filters.",
      {
        fix: { summary: "Pass the schema and table name when you print the expression." },
      },
    );
  }
  return whereSql(on, where);
}

function columnName(name: string, on: PrintTable | undefined): string {
  if (on === undefined) return name;
  return indexes(on.schema).get(on.table)?.columns.get(name)?.sql ?? name;
}
