/**
 * Exclusion constraints.
 *
 * The compiler stays small. It does not import the expression printer: a
 * featureless schema would otherwise load `okmodel/expr`. Range constructors
 * are read off the expression symbol when a table uses one.
 */

import { OkmError } from "../../contracts/error.js";
import type { ExclusionElement, ExclusionOperator } from "../../contracts/catalog/types.js";
import { isOperator, operatorName, operatorValue } from "./operators.js";
import { quoteLiteral } from "./quote.js";

const EXPR = Symbol.for("okmodel.expr");

/** One exclusion a table declares. */
export type ExclusionSpec = {
  readonly on: readonly (readonly [unknown, ExclusionOperator])[];
  readonly where?: unknown;
  readonly deferrable?: "deferred" | "immediate";
  readonly comment?: string;
};

type ColumnInfo = {
  readonly sql: string;
  readonly dataType: string;
};

/**
 * Compiles one exclusion into catalog fields.
 *
 * A tenant key is prefixed as `eq` when the table has that column. A `via()`
 * table has no tenant column, so the exclusion must name a scope column.
 *
 * @param table - Table name
 * @param key - Exclusion key. The stored name is `{table}_{key}_excl`
 * @param spec - Elements, predicate, and deferrability
 * @param columns - SQL name and type by field or SQL name
 * @param tenantKeys - Tenant fields on this table. Empty for a global table
 * @param path - `true` when the table is `via()` and has no tenant column
 * @returns Elements, the predicate, and whether a scalar `eq` needs btree_gist
 */
export function compileExclusion(
  table: string,
  key: string,
  spec: ExclusionSpec,
  columns: ReadonlyMap<string, ColumnInfo>,
  tenantKeys: readonly string[],
  path: boolean,
): {
  readonly elements: readonly ExclusionElement[];
  readonly expression?: string;
  readonly gist: boolean;
} {
  if (spec.on.length === 0) {
    fail(`Exclusion ${table}.${key} needs an element.`);
  }
  const elements: ExclusionElement[] = [];
  let gist = false;
  for (const keyName of tenantKeys) {
    const column = columns.get(keyName);
    if (column === undefined) continue;
    elements.push({ column: column.sql, operator: "eq" });
    gist = true;
  }
  let scope = false;
  for (const pair of spec.on) {
    const target = pair[0];
    const operator = pair[1];
    if (operator !== "eq" && operator !== "overlaps" && operator !== "adjacent") {
      fail(`Exclusion ${table}.${key} operator must be eq, overlaps, or adjacent.`);
    }
    if (typeof target === "string") {
      elements.push({ expression: target, operator });
      continue;
    }
    const column = columnOf(target, columns);
    if (column !== undefined) {
      if (tenantKeys.includes(column.field) && operator === "eq") continue;
      elements.push({ column: column.info.sql, operator });
      if (operator === "eq" && !column.info.dataType.endsWith("range")) gist = true;
      scope = true;
      continue;
    }
    const expression = rangeExpression(target, columns);
    if (expression === undefined) {
      fail(`Exclusion ${table}.${key} needs a column or range().`);
    }
    elements.push({ expression, operator });
  }
  if (path && !scope) {
    fail(`Exclusion ${table}.${key} is on a via() table and needs a scope column.`);
  }
  const expression =
    spec.where === undefined
      ? undefined
      : typeof spec.where === "string"
        ? spec.where
        : printWhere(spec.where, columns, table, key);
  return { elements, ...(expression !== undefined ? { expression } : {}), gist };
}

function columnOf(
  target: unknown,
  columns: ReadonlyMap<string, ColumnInfo>,
): { readonly field: string; readonly info: ColumnInfo } | undefined {
  if (target === null || typeof target !== "object" || !("name" in target)) return undefined;
  if (EXPR in target) return undefined;
  const name = target.name;
  if (typeof name !== "string") return undefined;
  const info = columns.get(name);
  if (info === undefined) return undefined;
  return { field: name, info };
}

function rangeExpression(
  target: unknown,
  columns: ReadonlyMap<string, ColumnInfo>,
): string | undefined {
  if (target === null || typeof target !== "object" || !(EXPR in target)) return undefined;
  const node = (target as { readonly [EXPR]: unknown })[EXPR];
  if (node === null || typeof node !== "object" || !("k" in node) || node.k !== "range") {
    return undefined;
  }
  return printNode(node, columns);
}

function printWhere(
  value: unknown,
  columns: ReadonlyMap<string, ColumnInfo>,
  table: string,
  key: string,
): string {
  refuseMutable(value, `${table}.${key}`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`Exclusion ${table}.${key} where must be an object.`);
  }
  const parts = Object.entries(value as Record<string, unknown>).map(([field, operand]) => {
    const column = columns.get(field);
    if (column === undefined)
      fail(`Exclusion ${table}.${key} where names ${field}, which is not a column.`);
    return `${quoteIdent(column.sql)} ${printOperand(operand)}`;
  });
  if (parts.length === 0) fail(`Exclusion ${table}.${key} where is empty.`);
  return parts.join(" and ");
}

function printOperand(value: unknown): string {
  if (isOperator(value)) {
    const name = operatorName(value);
    const operand = operatorValue(value);
    if (name === "not") return `is distinct from ${printLeaf(operand)}`;
    const op =
      name === "eq"
        ? "="
        : name === "lt"
          ? "<"
          : name === "lte"
            ? "<="
            : name === "gt"
              ? ">"
              : name === "gte"
                ? ">="
                : undefined;
    if (op === undefined) fail(`Exclusion where cannot use ${name}.`);
    return `${op} ${printLeaf(operand)}`;
  }
  if (value === null) return "is null";
  return `= ${printLeaf(value)}`;
}

function printLeaf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return quoteLiteral(value);
  if (isNamed(value)) return quoteIdent(value.name);
  fail("Exclusion where needs a column, a boolean, a number, or text.");
}

function printNode(node: object, columns: ReadonlyMap<string, ColumnInfo>): string {
  if (!("k" in node)) fail("range() is not an expression.");
  if (node.k === "range" && "ctor" in node && "a" in node && "b" in node && "bounds" in node) {
    const ctor = String(node.ctor);
    const bounds = String(node.bounds);
    return `${ctor}(${printNode(node.a as object, columns)}, ${printNode(node.b as object, columns)}, ${quoteLiteral(bounds)})`;
  }
  if (node.k === "col" && "name" in node && typeof node.name === "string") {
    const column = columns.get(node.name);
    return quoteIdent(column?.sql ?? node.name);
  }
  fail("range() needs column handles.");
}

function refuseMutable(value: unknown, label: string): void {
  const text = JSON.stringify(value);
  if (text !== undefined && /\bnow\s*\(/i.test(text)) {
    fail(
      `Exclusion ${label} where calls now(). A predicate must be immutable (42P17). Store the blocked interval in a column.`,
    );
  }
  if (value !== null && typeof value === "object" && EXPR in value) {
    const node = (value as { readonly [EXPR]: { readonly k?: string; readonly name?: string } })[
      EXPR
    ];
    if (node.name === "now" || node.name === "range_agg") {
      fail(`Exclusion ${label} where is not immutable.`);
    }
  }
}

function isNamed(value: unknown): value is { readonly name: string } {
  return (
    value !== null && typeof value === "object" && "name" in value && typeof value.name === "string"
  );
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function fail(message: string): never {
  throw new OkmError("OKM1060", message, { fix: { summary: message } });
}
