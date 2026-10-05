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
import { fail, installOperatorSql, isRecord, quote, type Sink } from "./plan.js";

/**
 * Compiles one 0.2 operator, or rejects a text operator on the wrong column.
 *
 * @param column - Field being filtered
 * @param ref - SQL reference, already quoted
 * @param name - Operator name
 * @param value - Operand the helper stored
 * @param sink - Statement builder
 */
function emitStructured(
  column: ColumnModel,
  ref: string,
  name: OperatorName,
  value: unknown,
  sink: Sink,
): void {
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

function emitMatches(column: ColumnModel, ref: string, value: unknown, sink: Sink): void {
  assertOperatorFits(column, "matches");
  if (!isRecord(value) || typeof value.query !== "string") {
    fail("OKM1121", `matches on ${column.field} needs search text.`);
  }
  assertNoControl(value.query, `matches on ${column.field}`);
  const mode = value.mode ?? "websearch";
  const fn =
    mode === "websearch"
      ? "websearch_to_tsquery"
      : mode === "plain"
        ? "plainto_tsquery"
        : mode === "phrase"
          ? "phraseto_tsquery"
          : undefined;
  if (fn === undefined) {
    fail("OKM1121", `matches on ${column.field} mode must be websearch, plain, or phrase.`);
  }
  sink.text(ref);
  sink.text(" @@ ");
  sink.text(fn);
  sink.text("(");
  if (typeof value.config === "string") {
    assertRegconfig(value.config);
    sink.param(value.config);
    sink.text("::regconfig, ");
  }
  sink.param(value.query);
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
