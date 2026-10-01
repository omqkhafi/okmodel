/**
 * Physical plan.
 *
 * Only a query {@link verify} accepted can be planned. The brand is checked
 * at runtime as well as in the type.
 */

import { SafetyError, violation } from "./errors.js";
import { quoteIdentifier } from "./identifier.js";
import { type BoolExpr, type Catalog, type Escape, type Predicate, tableByName } from "./model.js";
import { isVerified, type VerifiedQuery, walkPredicates } from "./verify.js";

/**
 * One statement the spike would send.
 *
 * Parameter values are not in the text. Sensitive parameters are shown as
 * `[redacted]` in `inspect`.
 */
export type PhysicalPlan = {
  readonly statements: 1;
  readonly text: string;
  readonly params: readonly string[];
  readonly redacted: readonly string[];
  readonly escapes: readonly Escape[];
  readonly applied: readonly string[];
  readonly inspect: readonly string[];
};

/**
 * Plans a verified query.
 *
 * @param query - Query the verifier accepted
 * @param catalog - Trusted catalog
 * @returns One SQL statement and the safety record
 */
export function plan(query: VerifiedQuery, catalog: Catalog): PhysicalPlan {
  if (!isVerified(query)) {
    throw new SafetyError([
      violation(
        "OKM1190",
        "unverified",
        "",
        "A physical plan requires a verified query.",
        "missing",
      ),
    ]);
  }
  for (const name of query.tables) {
    if (tableByName(catalog, name) === undefined) {
      throw new SafetyError([
        violation("OKM1190", "tenant", name, `Unknown table ${name}.`, "missing"),
      ]);
    }
  }
  const where = canonicalize(query.where);
  const params = unique(
    walkPredicates(where)
      .map((predicate) => predicate.parameter)
      .filter((parameter): parameter is string => parameter !== undefined),
  );
  const projection = query.projection.map((column) => quoteIdentifier(column));
  const from = quoteIdentifier(query.tables[0] ?? "");
  const renderedWhere = renderExpr(where);
  const limit =
    query.op === "find" && query.limit !== undefined ? ` limit ${String(query.limit)}` : "";
  const text = `${query.op} ${projection.join(", ")} from ${from} where ${renderedWhere}${limit}`;
  const sensitive = new Set(query.redacted);
  return {
    statements: 1,
    text,
    params,
    redacted: query.redacted,
    escapes: query.escapes,
    applied: query.contributions
      .map((contribution) => contribution.id)
      .sort((left, right) => left.localeCompare(right)),
    inspect: walkPredicates(where).map((predicate) => inspectLine(predicate, sensitive)),
  };
}

function inspectLine(predicate: Predicate, sensitive: ReadonlySet<string>): string {
  const shown = sensitive.has(predicate.column)
    ? "[redacted]"
    : (predicate.parameter ?? predicate.op);
  return `${predicate.provenance.kind} ${predicate.table}.${predicate.column} ${predicate.op} ${shown}`;
}

function renderExpr(expr: BoolExpr): string {
  switch (expr.kind) {
    case "pred":
      return renderPredicate(expr.predicate);
    case "and":
      if (expr.args.length === 0) {
        return "true";
      }
      return expr.args.map((child) => renderExpr(child)).join(" and ");
    case "or":
      if (expr.args.length === 0) {
        return "false";
      }
      return `(${expr.args.map((child) => renderExpr(child)).join(" or ")})`;
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
}

function renderPredicate(predicate: Predicate): string {
  const ident = `${quoteIdentifier(predicate.table)}.${quoteIdentifier(predicate.column)}`;
  switch (predicate.op) {
    case "isNull":
      return `${ident} is null`;
    case "isNotNull":
      return `${ident} is not null`;
    case "eq":
      return `${ident} = ${predicate.parameter ?? "$missing"}`;
    case "lt":
      return `${ident} < ${predicate.parameter ?? "$missing"}`;
    case "lte":
      return `${ident} <= ${predicate.parameter ?? "$missing"}`;
    case "gt":
      return `${ident} > ${predicate.parameter ?? "$missing"}`;
    case "gte":
      return `${ident} >= ${predicate.parameter ?? "$missing"}`;
    case "in":
      return `${ident} = any (${predicate.parameter ?? "$missing"})`;
    case "startsWith":
    case "contains":
      return `${ident} like ${predicate.parameter ?? "$missing"}`;
    default: {
      const unreachable: never = predicate.op;
      return unreachable;
    }
  }
}

function canonicalize(expr: BoolExpr): BoolExpr {
  switch (expr.kind) {
    case "pred":
      return expr;
    case "and":
    case "or": {
      const args = expr.args.map((child) => canonicalize(child));
      args.sort((left, right) => exprKey(left).localeCompare(exprKey(right)));
      return { kind: expr.kind, args };
    }
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
}

function exprKey(expr: BoolExpr): string {
  switch (expr.kind) {
    case "pred":
      return `pred:${expr.predicate.table}:${expr.predicate.column}:${expr.predicate.op}:${expr.predicate.parameter ?? ""}:${expr.predicate.provenance.kind}`;
    case "and":
    case "or":
      return `${expr.kind}:${expr.args.map((child) => exprKey(child)).join(",")}`;
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
