/**
 * SQL for the 0.2 operators.
 *
 * Loaded on the first query that uses one, so a client that only compares
 * and filters text does not pay for it at startup. Text `contains` stays in
 * the planner as `LIKE`.
 */

import {
  assertBoundText,
  assertNoControl,
  assertOperatorFits,
  assertRegconfig,
  sqlType,
  textArray,
} from "../dialects/pg/operator-fit.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import {
  isOperator,
  operatorName,
  operatorValue,
  type OperatorName,
} from "../dialects/pg/operators.js";
import { fail, installOperatorSql, isRecord, quote, type Indexed, type Sink } from "./plan.js";
import { emitSqlValue } from "./sql-fragment.js";

/**
 * Compiles one 0.2 operator, or rejects a text operator on the wrong column.
 *
 * @param table - Table the where field belongs to. `ident` resolves against it
 * @param column - Field being filtered
 * @param ref - SQL reference, already quoted
 * @param name - Operator name
 * @param value - Operand the helper stored
 * @param sink - Statement builder
 * @param order - Set when the operator is an `orderBy` value. `relevance` then
 *   sorts descending. The same operator in a filter is refused.
 */
function emitStructured(
  table: Indexed,
  column: ColumnModel,
  ref: string,
  name: OperatorName,
  value: unknown,
  sink: Sink,
  order?: true,
): void {
  if (name === "sql") {
    emitSqlValue(table, ref, value, sink);
    return;
  }
  if (name === "contains" || name === "containedBy" || name === "overlaps") {
    emitContainment(column, ref, name, value, sink);
    return;
  }
  if (name === "hasKey" || name === "hasAnyKey") {
    emitJsonKey(column, ref, name, value, sink);
    return;
  }
  if (name === "path") {
    emitPath(column, ref, value, sink);
    return;
  }
  if (name === "matches") {
    emitMatches(column, ref, value, sink);
    return;
  }
  if (name === "relevance") {
    if (order !== true) fail("OKM1121", `relevance on ${column.field} belongs in orderBy.`);
    emitRelevance(column, ref, value, sink);
    sink.text(" desc");
    sink.mark(`o:${column.field}:relevance`);
    return;
  }
  if (name === "similar" || name === "wordSimilar") {
    emitTrigram(column, ref, name, value, sink);
    return;
  }
  assertOperatorFits(column, name);
  fail(
    "OKM1121",
    `${name} is not a value operator on ${column.field}. Use has, none, or every on a relation.`,
  );
}

function emitContainment(
  column: ColumnModel,
  ref: string,
  name: "contains" | "containedBy" | "overlaps",
  value: unknown,
  sink: Sink,
): void {
  assertOperatorFits(column, name);
  const op = name === "contains" ? " @> " : name === "containedBy" ? " <@ " : " && ";
  sink.text(ref);
  sink.text(op);
  sink.param(column.encode(value));
  sink.text("::");
  sink.text(sqlType(column.dataType, column));
}

function emitJsonKey(
  column: ColumnModel,
  ref: string,
  name: "hasKey" | "hasAnyKey",
  value: unknown,
  sink: Sink,
): void {
  assertOperatorFits(column, name);
  if (name === "hasKey") {
    if (typeof value !== "string") fail("OKM1121", `hasKey on ${column.field} needs a key.`);
    assertBoundText(value, `key on ${column.field}`);
    sink.text("jsonb_exists(");
    sink.text(ref);
    sink.text(", ");
    sink.param(value);
    sink.text(")");
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail("OKM1121", `hasAnyKey on ${column.field} needs a list of keys.`);
  }
  sink.text("jsonb_exists_any(");
  sink.text(ref);
  sink.text(", ");
  sink.param(textArray(value, `key on ${column.field}`));
  sink.text("::text[])");
}

function emitPath(column: ColumnModel, ref: string, value: unknown, sink: Sink): void {
  assertOperatorFits(column, "path");
  if (!isRecord(value) || !Array.isArray(value.segments) || !isOperator(value.op)) {
    fail("OKM1121", `path on ${column.field} needs segments and a comparison.`);
  }
  const segments = value.segments;
  if (segments.length === 0 || segments.some((item) => typeof item !== "string")) {
    fail("OKM1121", `path on ${column.field} needs a list of segments.`);
  }
  const opName = operatorName(value.op);
  if (
    opName !== "eq" &&
    opName !== "lt" &&
    opName !== "lte" &&
    opName !== "gt" &&
    opName !== "gte"
  ) {
    fail("OKM1121", `path on ${column.field} compares with eq, lt, lte, gt, or gte.`);
  }
  const operand = operatorValue(value.op);
  const cast = pathCast(column, operand);
  const sql =
    opName === "eq"
      ? " = "
      : opName === "lt"
        ? " < "
        : opName === "lte"
          ? " <= "
          : opName === "gt"
            ? " > "
            : " >= ";
  sink.text("(");
  sink.text(ref);
  sink.text(" #>> ");
  sink.param(textArray(segments, `path on ${column.field}`));
  sink.text("::text[])::");
  sink.text(cast);
  sink.text(sql);
  sink.param(pathParam(operand));
}

function pathCast(column: ColumnModel, operand: unknown): "numeric" | "boolean" | "text" {
  if (typeof operand === "number") return "numeric";
  if (typeof operand === "boolean") return "boolean";
  if (typeof operand === "string") return "text";
  fail("OKM1121", `path on ${column.field} compares a string, number, or boolean.`);
}

function pathParam(operand: unknown): string {
  if (typeof operand === "number") return String(operand);
  if (typeof operand === "boolean") return operand ? "true" : "false";
  if (typeof operand === "string") return operand;
  return "";
}

const MATCH_FN: Readonly<Record<string, string>> = {
  natural: "websearch_to_tsquery",
  "all-words": "plainto_tsquery",
  phrase: "phraseto_tsquery",
  advanced: "to_tsquery",
};

type BoundQuery = {
  readonly fn: string;
  readonly language: string | undefined;
  readonly query: string;
};

/**
 * Reads the operand `matches` and `relevance` store.
 *
 * One reader, so both helpers and `search` emit the same function.
 *
 * @param column - Field being searched
 * @param value - Operand the helper stored
 * @param label - `matches` or `relevance`, for the error
 * @returns The SQL function, the language, and the text
 */
function readMatch(column: ColumnModel, value: unknown, label: string): BoundQuery {
  if (!isRecord(value) || typeof value.query !== "string" || value.query.length === 0) {
    fail("OKM1121", `${label} on ${column.field} needs text to look for.`);
  }
  assertNoControl(value.query, `${label} on ${column.field}`);
  const match = value.match ?? "natural";
  const fn = typeof match === "string" ? MATCH_FN[match] : undefined;
  if (fn === undefined) {
    fail(
      "OKM1121",
      `${label} on ${column.field} match must be natural, all-words, phrase, or advanced.`,
    );
  }
  if (value.language === undefined) return { fn, language: undefined, query: value.query };
  if (typeof value.language !== "string") {
    fail("OKM1121", `${label} on ${column.field} language must be a name such as english.`);
  }
  assertRegconfig(value.language);
  return { fn, language: value.language, query: value.query };
}

/**
 * Writes the query function `matches` and `relevance` share.
 *
 * The mark includes the function and whether a language was passed, so two
 * matches do not share a cached statement.
 *
 * @param sink - Statement builder
 * @param query - Function, language, and text
 */
function emitTsquery(sink: Sink, query: BoundQuery): void {
  sink.mark(query.language === undefined ? `:${query.fn}` : `:${query.fn}:lang`);
  sink.text(query.fn);
  sink.text("(");
  if (query.language !== undefined) {
    sink.param(query.language);
    sink.text("::regconfig, ");
  }
  sink.param(query.query);
  sink.text(")");
}

function emitMatches(column: ColumnModel, ref: string, value: unknown, sink: Sink): void {
  assertOperatorFits(column, "matches");
  sink.text(ref);
  sink.text(" @@ ");
  emitTsquery(sink, readMatch(column, value, "matches"));
}

function emitRelevance(column: ColumnModel, ref: string, value: unknown, sink: Sink): void {
  assertOperatorFits(column, "relevance");
  sink.text("ts_rank(");
  sink.text(ref);
  sink.text(", ");
  emitTsquery(sink, readMatch(column, value, "relevance"));
  sink.text(")");
}

function emitTrigram(
  column: ColumnModel,
  ref: string,
  name: "similar" | "wordSimilar",
  value: unknown,
  sink: Sink,
): void {
  if (!isRecord(value) || typeof value.query !== "string" || typeof value.schema !== "string") {
    fail("OKM1121", `${name} on ${column.field} needs query text.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.schema)) {
    fail("OKM1121", `${name} on ${column.field} needs an extension schema name.`);
  }
  sink.text(ref);
  sink.text(" operator(");
  sink.text(quote(value.schema));
  sink.text(name === "similar" ? ".%) " : ".<%) ");
  sink.param(value.query);
}

installOperatorSql(emitStructured);
