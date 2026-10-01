/**
 * Final safety verification.
 *
 * Runs after composition and before planning. It re-checks the catalog
 * invariants on the query that composition produced. It does not put a missing
 * rule back. A failure throws OKM1190 (or the call-site code for bounds and
 * unfiltered writes) and names every broken rule, in stable order.
 */

import { SafetyError, type Violation, sortViolations, violation, violationKey } from "./errors.js";
import {
  type BoolExpr,
  type Catalog,
  type CompareOp,
  type Contribution,
  type Escape,
  type LogicalQuery,
  type Predicate,
  type ProvenanceKind,
  type TableMeta,
  archiveField,
  provenanceLabel,
  tableByName,
  tenantField,
  usableReason,
} from "./model.js";

const verifiedBrand: unique symbol = Symbol("okmodel.verified");

/**
 * A query {@link verify} accepted.
 *
 * The brand is a runtime symbol. A cast does not add it, so {@link plan} can
 * reject a query that skipped verification.
 */
export type VerifiedQuery = LogicalQuery & { readonly [verifiedBrand]: true };

const PARAMETER = /^\$[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Reports whether {@link verify} branded this query.
 *
 * @param query - Logical query
 * @returns True when the verification symbol is present
 */
export function isVerified(query: LogicalQuery): query is VerifiedQuery {
  return Object.hasOwn(query, verifiedBrand);
}

/**
 * Verifies a logical query against the catalog.
 *
 * @param query - Output of composition, or a mutated query in a test
 * @param catalog - Trusted catalog
 * @returns The same query, branded
 */
export function verify(query: LogicalQuery, catalog: Catalog): VerifiedQuery {
  const violations = collectViolations(query, catalog);
  if (violations.length > 0) {
    throw new SafetyError(violations);
  }
  return { ...query, [verifiedBrand]: true };
}

/**
 * Lists every broken rule.
 *
 * The result is sorted. Check order does not change it.
 *
 * @param query - Logical query
 * @param catalog - Trusted catalog
 * @returns Violations, possibly empty
 */
export function collectViolations(query: LogicalQuery, catalog: Catalog): readonly Violation[] {
  const found: Violation[] = [];
  found.push(...escapeViolations(query));
  found.push(...droppedViolations(query));
  found.push(...parameterViolations(query));
  const trusted = hasHatch(query.escapes, "trusted");
  const unscoped = hasHatch(query.escapes, "unscoped");
  const all = hasHatch(query.escapes, "all");
  for (const name of query.tables) {
    const table = tableByName(catalog, name);
    if (table === undefined) {
      found.push(violation("OKM1190", "tenant", name, `Unknown table ${name}.`, "missing"));
      continue;
    }
    if (!trusted && !unscoped) {
      found.push(...tenantViolations(query, table));
    }
    if (!trusted) {
      found.push(...archiveViolations(query, table));
    }
    found.push(...guardViolations(query, table));
    found.push(...hiddenViolations(query, table));
    found.push(...sensitiveViolations(query, table));
    found.push(...columnViolations(query, table));
  }
  if (query.op === "find" && !all && (query.limit === undefined || query.limit < 1)) {
    found.push(
      violation(
        "OKM1101",
        "bound",
        query.tables[0] ?? "",
        "A read needs a limit or .all(reason).",
        "missing",
      ),
    );
  }
  if ((query.op === "update" || query.op === "delete") && !all && !hasUserPredicate(query.where)) {
    found.push(
      violation(
        "OKM1102",
        "write-filter",
        query.tables[0] ?? "",
        "An update or delete needs a filter or .all(reason).",
        "missing",
      ),
    );
  }
  return dedupe(sortViolations(found));
}

/**
 * Reports whether the expression implies a specific comparison on every OR branch.
 *
 * AND succeeds when any child succeeds. OR succeeds only when every child does.
 * This is structural. It does not prove arbitrary SQL.
 *
 * @param expr - Boolean tree
 * @param match - Predicate test
 * @returns True when the comparison is unavoidable
 */
export function implies(expr: BoolExpr, match: (predicate: Predicate) => boolean): boolean {
  switch (expr.kind) {
    case "pred":
      return match(expr.predicate);
    case "and":
      return expr.args.some((child) => implies(child, match));
    case "or":
      return expr.args.length > 0 && expr.args.every((child) => implies(child, match));
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
}

function tenantViolations(query: LogicalQuery, table: TableMeta): readonly Violation[] {
  if (table.tenancy !== "column") {
    return [];
  }
  const field = tenantField(table);
  if (field === undefined) {
    return [
      violation("OKM1190", "tenant", table.name, "Column tenancy has no tenant key.", "missing"),
    ];
  }
  if (query.op === "insert") {
    const bound = query.values.some(
      (value) =>
        value.table === table.name &&
        value.column === field.name &&
        value.parameter === "$tenant" &&
        value.provenance.kind === "tenancy",
    );
    const found: Violation[] = [];
    if (!bound) {
      found.push(
        violation(
          "OKM1190",
          "tenant",
          table.name,
          `Insert on ${table.name} does not set ${field.name} from context.`,
          "missing",
        ),
      );
    }
    if (query.input.includes(field.name)) {
      found.push(
        violation(
          "OKM1190",
          "tenant",
          table.name,
          `Insert input sets ${field.name}. Context owns the tenant key.`,
          "caller:input",
        ),
      );
    }
    return found;
  }
  const holds = implies(query.where, (predicate) =>
    matches(predicate, table.name, field.name, "eq", "$tenant", "tenancy"),
  );
  if (!holds) {
    return [
      violation(
        "OKM1190",
        "tenant",
        table.name,
        `Missing tenant predicate on ${field.name}.`,
        "missing",
      ),
    ];
  }
  return [];
}

function archiveViolations(query: LogicalQuery, table: TableMeta): readonly Violation[] {
  if (query.op === "insert" || !table.traits.includes("archivable")) {
    return [];
  }
  const field = archiveField(table);
  if (field === undefined) {
    return [
      violation(
        "OKM1190",
        "archive",
        table.name,
        "Archivable table has no archive column.",
        "missing",
      ),
    ];
  }
  if (query.archive === "withArchived") {
    return [];
  }
  const op: CompareOp = query.archive === "onlyArchived" ? "isNotNull" : "isNull";
  const holds = implies(query.where, (predicate) =>
    matches(predicate, table.name, field.name, op, undefined, "archive"),
  );
  if (!holds) {
    return [
      violation(
        "OKM1190",
        "archive",
        table.name,
        `Archive mode ${query.archive} is missing ${field.name} ${op}.`,
        "missing",
      ),
    ];
  }
  return [];
}

function guardViolations(query: LogicalQuery, table: TableMeta): readonly Violation[] {
  if (query.op !== "insert" && query.op !== "update") {
    return [];
  }
  const allowed = new Set(allowFields(query.escapes));
  const found: Violation[] = [];
  for (const column of query.input) {
    const field = table.fields.find((entry) => entry.name === column);
    if (field === undefined || !field.guarded) {
      continue;
    }
    if (field.tenantKey) {
      continue;
    }
    if (!allowed.has(column)) {
      found.push(
        violation(
          "OKM1190",
          "guarded",
          table.name,
          `Guarded field ${column} is in the input.`,
          "missing",
        ),
      );
    }
  }
  if (query.op === "update") {
    const field = tenantField(table);
    if (field !== undefined && query.input.includes(field.name)) {
      found.push(
        violation(
          "OKM1190",
          "tenant",
          table.name,
          `Update input changes ${field.name}.`,
          "caller:input",
        ),
      );
    }
  }
  return found;
}

function hiddenViolations(query: LogicalQuery, table: TableMeta): readonly Violation[] {
  if (query.select !== "default" || table.name !== query.tables[0]) {
    return [];
  }
  return table.fields
    .filter((field) => field.hidden && query.projection.includes(field.name))
    .map((field) =>
      violation(
        "OKM1190",
        "hidden",
        table.name,
        `Hidden field ${field.name} is in the default projection.`,
        "missing",
      ),
    );
}

function sensitiveViolations(query: LogicalQuery, table: TableMeta): readonly Violation[] {
  return table.fields
    .filter((field) => field.sensitive && !query.redacted.includes(field.name))
    .map((field) =>
      violation(
        "OKM1190",
        "sensitive",
        table.name,
        `Sensitive field ${field.name} is not redacted.`,
        "missing",
      ),
    );
}

function columnViolations(query: LogicalQuery, table: TableMeta): readonly Violation[] {
  const names = new Set(table.fields.map((field) => field.name));
  const found: Violation[] = [];
  for (const predicate of walkPredicates(query.where)) {
    if (predicate.table === table.name && !names.has(predicate.column)) {
      found.push(
        violation(
          "OKM1120",
          "unknown-field",
          table.name,
          `Unknown field ${predicate.column}.`,
          provenanceLabel(predicate.provenance),
        ),
      );
    }
  }
  return found;
}

function droppedViolations(query: LogicalQuery): readonly Violation[] {
  const ids = new Set(query.contributions.map((contribution) => contribution.id));
  const found: Violation[] = [];
  for (const id of query.requested) {
    if (!ids.has(id)) {
      found.push(violation("OKM1190", "dropped", "", `Contribution ${id} is missing.`, "missing"));
    }
  }
  for (const contribution of query.contributions) {
    if (!effectHolds(query, contribution)) {
      found.push(
        violation(
          "OKM1190",
          "dropped",
          "",
          `Contribution ${contribution.id} is not in the query.`,
          provenanceLabel(contribution.provenance),
        ),
      );
    }
  }
  return found;
}

function effectHolds(query: LogicalQuery, contribution: Contribution): boolean {
  const effect = contribution.effect;
  switch (effect.kind) {
    case "predicate":
      return walkPredicates(query.where).some((predicate) =>
        samePredicate(predicate, effect.predicate),
      );
    case "value":
      return query.values.some(
        (value) =>
          value.table === effect.table &&
          value.column === effect.column &&
          value.parameter === effect.parameter &&
          value.provenance.kind === "tenancy",
      );
    case "hide":
      return (
        query.select === "explicit" ||
        effect.table !== query.tables[0] ||
        !query.projection.includes(effect.column)
      );
    case "redact":
      return query.redacted.includes(effect.column);
    case "guard":
      return true;
    default: {
      const unreachable: never = effect;
      return unreachable;
    }
  }
}

function parameterViolations(query: LogicalQuery): readonly Violation[] {
  const found: Violation[] = [];
  for (const predicate of walkPredicates(query.where)) {
    found.push(...parameterProblem(predicate));
  }
  for (const value of query.values) {
    if (!PARAMETER.test(value.parameter)) {
      found.push(
        violation(
          "OKM1190",
          "parameter",
          value.table,
          `${value.column} is not a parameter.`,
          provenanceLabel(value.provenance),
        ),
      );
    }
  }
  return found;
}

function dedupe(violations: readonly Violation[]): readonly Violation[] {
  const seen = new Set<string>();
  const unique: Violation[] = [];
  for (const item of violations) {
    const key = violationKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function parameterProblem(predicate: Predicate): readonly Violation[] {
  const nullary = predicate.op === "isNull" || predicate.op === "isNotNull";
  if (nullary) {
    if (predicate.parameter !== undefined) {
      return [
        violation(
          "OKM1190",
          "parameter",
          predicate.table,
          `${predicate.column} ${predicate.op} must not carry a value.`,
          provenanceLabel(predicate.provenance),
        ),
      ];
    }
    return [];
  }
  if (predicate.parameter === undefined || !PARAMETER.test(predicate.parameter)) {
    return [
      violation(
        "OKM1190",
        "parameter",
        predicate.table,
        `${predicate.column} ${predicate.op} is not a parameter.`,
        provenanceLabel(predicate.provenance),
      ),
    ];
  }
  return [];
}

function escapeViolations(query: LogicalQuery): readonly Violation[] {
  const found: Violation[] = [];
  for (const escape of query.escapes) {
    if (escape.hatch === "allow") {
      continue;
    }
    if (!usableReason(escape.reason)) {
      found.push(
        violation(
          "OKM1190",
          "escape",
          "",
          `${escape.hatch} needs a reason.`,
          provenanceLabel(escape.provenance),
        ),
      );
    }
  }
  return found;
}

function hasHatch(escapes: readonly Escape[], hatch: "unscoped" | "all" | "trusted"): boolean {
  return escapes.some((escape) => escape.hatch === hatch && usableReason(escape.reason));
}

function allowFields(escapes: readonly Escape[]): readonly string[] {
  return escapes.flatMap((escape) => (escape.hatch === "allow" ? escape.fields : []));
}

function matches(
  predicate: Predicate,
  table: string,
  column: string,
  op: CompareOp,
  parameter: string | undefined,
  kind: ProvenanceKind,
): boolean {
  return (
    predicate.table === table &&
    predicate.column === column &&
    predicate.op === op &&
    predicate.parameter === parameter &&
    predicate.provenance.kind === kind
  );
}

function samePredicate(left: Predicate, right: Predicate): boolean {
  return (
    left.table === right.table &&
    left.column === right.column &&
    left.op === right.op &&
    left.parameter === right.parameter &&
    left.provenance.kind === right.provenance.kind &&
    left.provenance.name === right.provenance.name
  );
}

function hasUserPredicate(expr: BoolExpr): boolean {
  return walkPredicates(expr).some((predicate) => {
    const kind = predicate.provenance.kind;
    return kind === "caller" || kind === "preset" || kind === "filter";
  });
}

/**
 * Lists every predicate in a boolean tree.
 *
 * @param expr - Boolean tree
 * @returns Predicates in visit order
 */
export function walkPredicates(expr: BoolExpr): readonly Predicate[] {
  switch (expr.kind) {
    case "pred":
      return [expr.predicate];
    case "and":
    case "or":
      return expr.args.flatMap((child) => walkPredicates(child));
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
}
