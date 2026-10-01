/**
 * Allowlisted client filters.
 *
 * `parse` is the only place a JSON body becomes a tagged operator. Hidden
 * fields cannot be allowlisted. A field or operator outside the list throws.
 */

import { SafetyError, violation } from "./errors.js";
import { assertKnownField } from "./identifier.js";
import {
  type Catalog,
  type CompareOp,
  type DraftPredicate,
  type TableMeta,
  tableByName,
} from "./model.js";
import { OPERATOR_NAMES, type OperatorName, readFilterInput } from "./operators.js";

/** Operators a client filter may name. Relation operators are separate. */
const SCALAR_OPS: readonly OperatorName[] = [
  "lt",
  "lte",
  "gt",
  "gte",
  "startsWith",
  "contains",
  "inList",
];

const SCALAR_SET: ReadonlySet<string> = new Set([...SCALAR_OPS, "in"]);
const RELATION_OPS: ReadonlySet<string> = new Set(["has", "none", "every"]);

/**
 * Allowlist for {@link defineFilters}.
 *
 * Field names are columns. Relation keys are relation names on the table.
 * Their values are the only fields of the related table that may be filtered.
 */
export type FilterSpec = {
  readonly allow: Readonly<Record<string, readonly string[]>>;
  readonly sort?: readonly string[];
  readonly relations?: Readonly<Record<string, readonly string[]>>;
};

/** Predicates produced from a client payload. */
export type ParsedFilters = {
  readonly predicates: readonly ParsedPredicate[];
  readonly sort: readonly string[];
  readonly touched: readonly string[];
};

/** One predicate, still without provenance. The pipeline stamps that. */
export type ParsedPredicate = DraftPredicate & {
  readonly table: string;
};

/**
 * Checks an allowlist against the catalog and returns a parser.
 *
 * Hidden fields on the target table, including related tables, throw here
 * rather than at parse time.
 *
 * @param catalog - Spike catalog
 * @param tableName - Table that owns the filter
 * @param spec - Allowlist
 * @returns A parser
 */
export function defineFilters(
  catalog: Catalog,
  tableName: string,
  spec: FilterSpec,
): {
  readonly spec: FilterSpec;
  parse: (payload: unknown) => ParsedFilters;
} {
  const table = requireTable(catalog, tableName);
  assertAllowlist(catalog, table, spec);
  return {
    spec,
    parse: (payload: unknown) => parseFilters(catalog, table, spec, payload),
  };
}

/**
 * Parses a client payload with an allowlist that has already been checked.
 *
 * @param catalog - Spike catalog
 * @param table - Owning table
 * @param spec - Allowlist
 * @param payload - JSON-shaped input
 * @returns Predicates and the tables they touch
 */
export function parseFilters(
  catalog: Catalog,
  table: TableMeta,
  spec: FilterSpec,
  payload: unknown,
): ParsedFilters {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw objectInput("Filter payload must be an object.");
  }
  const record = payload as Record<string, unknown>;
  const where = record.where;
  const predicates: ParsedPredicate[] = [];
  const touched = new Set<string>();
  if (where !== undefined) {
    if (typeof where !== "object" || where === null || Array.isArray(where)) {
      throw objectInput("Filter where must be an object.");
    }
    for (const [field, raw] of Object.entries(where)) {
      predicates.push(...parseField(catalog, table, spec, field, raw, touched));
    }
  }
  const sort = parseSort(table, spec, record.sort);
  return { predicates, sort, touched: [...touched] };
}

function assertAllowlist(catalog: Catalog, table: TableMeta, spec: FilterSpec): void {
  const hidden = new Set(table.fields.filter((field) => field.hidden).map((field) => field.name));
  for (const name of Object.keys(spec.allow)) {
    assertKnownField(
      table.fields.map((field) => field.name),
      name,
      "where",
    );
    if (hidden.has(name)) {
      throw hiddenRejected(table.name, name);
    }
    for (const op of spec.allow[name] ?? []) {
      if (op !== "eq" && !SCALAR_SET.has(op)) {
        throw new SafetyError([
          violation(
            "OKM1121",
            "filter",
            table.name,
            `Operator ${op} is not a client filter operator.`,
            "filter",
          ),
        ]);
      }
    }
  }
  for (const column of spec.sort ?? []) {
    assertKnownField(
      table.fields.map((field) => field.name),
      column,
      "orderBy",
    );
    if (hidden.has(column)) {
      throw hiddenRejected(table.name, column);
    }
  }
  for (const [relation, fields] of Object.entries(spec.relations ?? {})) {
    const targetName = table.relations[relation];
    if (targetName === undefined) {
      throw new SafetyError([
        violation(
          "OKM1120",
          "unknown-field",
          table.name,
          `Unknown relation ${relation}.`,
          "filter",
        ),
      ]);
    }
    const target = requireTable(catalog, targetName);
    const targetHidden = new Set(
      target.fields.filter((field) => field.hidden).map((field) => field.name),
    );
    for (const field of fields) {
      assertKnownField(
        target.fields.map((entry) => entry.name),
        field,
        "where",
      );
      if (targetHidden.has(field)) {
        throw hiddenRejected(target.name, field);
      }
    }
  }
}

function parseField(
  catalog: Catalog,
  table: TableMeta,
  spec: FilterSpec,
  field: string,
  raw: unknown,
  touched: Set<string>,
): readonly ParsedPredicate[] {
  const relationFields = spec.relations?.[field];
  const read = readRelation(raw);
  if (read !== undefined) {
    if (relationFields === undefined) {
      throw new SafetyError([
        violation(
          "OKM1120",
          "unknown-field",
          table.name,
          `Relation ${field} is not filterable.`,
          "filter",
        ),
      ]);
    }
    const targetName = table.relations[field];
    if (targetName === undefined) {
      throw new SafetyError([
        violation("OKM1120", "unknown-field", table.name, `Unknown relation ${field}.`, "filter"),
      ]);
    }
    const target = requireTable(catalog, targetName);
    touched.add(target.name);
    return parseRelation(target, relationFields, read.value);
  }
  const allowed = spec.allow[field];
  if (allowed === undefined) {
    throw new SafetyError([
      violation(
        "OKM1120",
        "unknown-field",
        table.name,
        `Field ${field} is not filterable.`,
        "filter",
      ),
    ]);
  }
  const predicate = parseScalar(table.name, field, raw, allowed);
  return [predicate];
}

function parseRelation(
  target: TableMeta,
  allowedFields: readonly string[],
  value: unknown,
): readonly ParsedPredicate[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw objectInput("A relation filter needs an object of fields.");
  }
  const predicates: ParsedPredicate[] = [];
  for (const [field, raw] of Object.entries(value)) {
    if (!allowedFields.includes(field)) {
      throw new SafetyError([
        violation(
          "OKM1120",
          "unknown-field",
          target.name,
          `Field ${field} is not filterable on ${target.name}.`,
          "filter",
        ),
      ]);
    }
    predicates.push(parseScalar(target.name, field, raw, ["eq", "startsWith", "lt", "gt"]));
  }
  return predicates;
}

function parseScalar(
  table: string,
  column: string,
  raw: unknown,
  allowed: readonly string[],
): ParsedPredicate {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "op" in raw) {
    const op = raw.op;
    if (typeof op !== "string" || !allowed.includes(op)) {
      throw new SafetyError([
        violation(
          "OKM1121",
          "filter",
          table,
          `Operator ${String(op)} is not allowed on ${column}.`,
          "filter",
        ),
      ]);
    }
    const value = "value" in raw ? raw.value : undefined;
    return scalarPredicate(table, column, op, value);
  }
  const read = readFilterInput(raw);
  if (read.kind === "skip") {
    throw new SafetyError([
      violation("OKM1121", "filter", table, `Field ${column} has no value.`, "filter"),
    ]);
  }
  if (!allowed.includes("eq")) {
    throw new SafetyError([
      violation("OKM1121", "filter", table, `Equality is not allowed on ${column}.`, "filter"),
    ]);
  }
  if (read.kind === "null") {
    return { table, column, op: "isNull", parameter: undefined };
  }
  if (read.kind === "eq") {
    return { table, column, op: "eq", parameter: parameterName(table, column) };
  }
  throw new SafetyError([
    violation(
      "OKM1121",
      "filter",
      table,
      "Client JSON cannot carry a tagged operator. Name the operator in the payload.",
      "filter",
    ),
  ]);
}

function scalarPredicate(
  table: string,
  column: string,
  op: string,
  value: unknown,
): ParsedPredicate {
  if (op === "eq" && value === null) {
    return { table, column, op: "isNull", parameter: undefined };
  }
  if (value === undefined || (typeof value === "object" && value !== null)) {
    throw objectInput(`Operator ${op} on ${column} needs a scalar value.`);
  }
  const compare = op === "inList" ? "in" : op;
  if (!isCompare(compare) && compare !== "eq") {
    throw objectInput(`Operator ${op} is not a comparison.`);
  }
  const resolved: CompareOp = compare === "eq" ? "eq" : compare;
  return {
    table,
    column,
    op: resolved,
    parameter: parameterName(table, column),
  };
}

function parseSort(table: TableMeta, spec: FilterSpec, sort: unknown): readonly string[] {
  if (sort === undefined) {
    return [];
  }
  const columns = Array.isArray(sort) ? sort : [sort];
  const allowed = spec.sort ?? [];
  return columns.map((column) => {
    if (typeof column !== "string" || !allowed.includes(column)) {
      throw new SafetyError([
        violation(
          "OKM1120",
          "unknown-field",
          table.name,
          `Sort ${String(column)} is not allowed.`,
          "filter",
        ),
      ]);
    }
    assertKnownField(
      table.fields.map((field) => field.name),
      column,
      "orderBy",
    );
    return column;
  });
}

function readRelation(raw: unknown): { readonly op: string; readonly value: unknown } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("op" in raw)) {
    return undefined;
  }
  const op = raw.op;
  if (typeof op !== "string" || !RELATION_OPS.has(op)) {
    return undefined;
  }
  return { op, value: "value" in raw ? raw.value : undefined };
}

function requireTable(catalog: Catalog, name: string): TableMeta {
  const table = tableByName(catalog, name);
  if (table === undefined) {
    throw new SafetyError([
      violation("OKM1120", "unknown-field", "", `Unknown table ${name}.`, "filter"),
    ]);
  }
  return table;
}

function hiddenRejected(table: string, field: string): SafetyError {
  return new SafetyError([
    violation("OKM1190", "hidden", table, `Hidden field ${field} cannot be allowlisted.`, "filter"),
  ]);
}

function objectInput(detail: string): SafetyError {
  return new SafetyError([violation("OKM1121", "object", "", detail, "filter")]);
}

function parameterName(table: string, column: string): string {
  return `$filter_${table}_${column}`;
}

function isCompare(op: string): op is CompareOp {
  return (
    op === "eq" ||
    op === "isNull" ||
    op === "isNotNull" ||
    op === "lt" ||
    op === "lte" ||
    op === "gt" ||
    op === "gte" ||
    op === "in" ||
    op === "startsWith" ||
    op === "contains"
  );
}

/** Operator names a filter payload may spell. Re-exported for tests. */
export const FILTER_OPERATOR_NAMES: readonly string[] = ["eq", ...OPERATOR_NAMES];
