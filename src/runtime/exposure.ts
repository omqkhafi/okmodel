/**
 * Redaction for hidden and sensitive fields.
 *
 * Loaded the first time a concealed table is inspected or a read of one fails.
 */

import { OkmError } from "../contracts/error.js";
import type { ColumnModel, QuerySchema, TableModel } from "../dialects/pg/model.js";
import { isOperator, operatorName, operatorValue } from "../dialects/pg/operators.js";
import type { ReadCall } from "./plan.js";
import { runSafety, safetyInstalled } from "./safety-hook.js";
import type { Inspection } from "./types.js";

/** Placeholder for a hidden or sensitive value in `inspect()` and errors. */
const REDACTED = "[redacted]";

const namesOf = new WeakMap<object, ReadonlySet<string>>();

/**
 * Replaces concealed values in an inspection and records the exposure rules.
 *
 * @param schema - Connected schema
 * @param view - Inspection that still holds the real values
 * @param call - The read, used to encode parameter values and to see `select`
 * @returns The inspection a caller can print
 */
export function redactView(schema: QuerySchema, view: Inspection, call: ReadCall): Inspection {
  const model = schema.model[call.table];
  const rules = model === undefined ? view.rules : [...view.rules, ...exposureRules(model, call)];
  if (safetyInstalled()) runSafety(rules, undefined);
  return {
    ...view,
    intent: {
      ...view.intent,
      where: walk(view.intent.where, schema, model),
      include: walk(view.intent.include, schema, model, "include"),
    },
    rules,
    sql: {
      ...view.sql,
      params: redactParams(
        schema,
        { where: call.where, include: call.include },
        view.sql.params,
        call.table,
      ),
    },
  };
}

/**
 * Replaces concealed bound parameters with `[redacted]`.
 *
 * `source` is the read (`where`, `include`) or the write input. A parameter is
 * replaced when it equals a concealed value encoded the way the statement
 * binds it.
 *
 * @param schema - Connected schema
 * @param source - Caller input that may hold hidden or sensitive values
 * @param params - Bound parameters
 * @param table - Table the statement targets. A shared field name uses this table's codec
 * @returns The same array when nothing was concealed, otherwise a copy
 */
export function redactParams(
  schema: QuerySchema,
  source: unknown,
  params: readonly (string | null)[],
  table: string,
): readonly (string | null)[] {
  if (params.length === 0) return params;
  const names = concealedNames(schema);
  if (names.size === 0) return params;
  const secrets = new Set<string>();
  harvest(schema, source, names, undefined, secrets, schema.model[table]);
  if (secrets.size === 0) return params;
  let changed = false;
  const next = params.map((value) => {
    if (value !== null && secrets.has(value)) {
      changed = true;
      return REDACTED;
    }
    return value;
  });
  return changed ? next : params;
}

/**
 * Removes concealed values from a read error.
 *
 * @param error - Failure from the driver or the planner
 * @param schema - Connected schema
 * @param call - The read whose hidden or sensitive values may have been echoed
 * @returns The error, with those values replaced
 */
export function scrubCall(error: OkmError, schema: QuerySchema, call: ReadCall): OkmError {
  const names = concealedNames(schema);
  const secrets = new Set<string>();
  const model = schema.model[call.table];
  harvest(schema, call.where, names, undefined, secrets, model);
  harvest(schema, call.include, names, "include", secrets, model);
  let message = error.message;
  for (const secret of secrets) {
    if (secret.length < 4 || !message.includes(secret)) continue;
    message = message.replaceAll(secret, REDACTED);
  }
  if (message === error.message) return error;
  return new OkmError(error.code, message, {
    kind: error.kind,
    ...(error.table !== undefined ? { table: error.table } : {}),
    ...(error.columns.length > 0 ? { columns: error.columns } : {}),
    fix: error.fix,
  });
}

function concealedNames(schema: QuerySchema): ReadonlySet<string> {
  const cached = namesOf.get(schema);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  for (const model of Object.values(schema.model)) {
    if (model.conceal !== true) continue;
    for (const column of model.columns) {
      if (column.hidden || column.sensitive) names.add(column.field);
    }
  }
  namesOf.set(schema, names);
  return names;
}

function exposureRules(model: TableModel, call: ReadCall): Inspection["rules"] {
  const named = namedSelect(call.select);
  const source = model.source;
  const rules: Inspection["rules"][number][] = [];
  for (const column of model.columns) {
    if (column.hidden && (named === undefined || !named.has(column.field))) {
      rules.push({
        rule: "hidden",
        contribution: `hidden ${model.name}.${column.field} excluded`,
        provenance: "catalog",
        ...(source !== undefined ? { source } : {}),
      });
    }
    if (column.sensitive) {
      rules.push({
        rule: "sensitive",
        contribution: `sensitive ${model.name}.${column.field} redacted`,
        provenance: "catalog",
        ...(source !== undefined ? { source } : {}),
      });
    }
  }
  return rules;
}

function namedSelect(select: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(select)) return undefined;
  const names = new Set<string>();
  for (const name of select) {
    if (typeof name === "string") names.add(name);
  }
  return names;
}

function harvest(
  schema: QuerySchema,
  value: unknown,
  names: ReadonlySet<string>,
  key: string | undefined,
  into: Set<string>,
  table: TableModel | undefined,
): void {
  if (isOperator(value)) {
    const name = operatorName(value);
    const inner = operatorValue(value);
    if (name === "json.set" && isRecord(inner) && "value" in inner && key !== undefined) {
      addEncoded(table, key, inner.value, into);
    }
    if ((name === "has" || name === "none" || name === "every") && table !== undefined) {
      harvest(schema, inner, names, undefined, into, relationTable(schema, table, key) ?? table);
      return;
    }
    harvest(schema, inner, names, key, into, table);
    return;
  }
  if (Array.isArray(value)) {
    if (key !== undefined && names.has(key)) addEncoded(table, key, value, into);
    for (const item of value) harvest(schema, item, names, key, into, table);
    return;
  }
  if (typeof value === "object" && value !== null) {
    if (key !== undefined && names.has(key)) addEncoded(table, key, value, into);
    const record = value as Record<string, unknown>;
    if (key === "include" && table !== undefined) {
      for (const child of Object.keys(record)) {
        harvest(
          schema,
          record[child],
          names,
          undefined,
          into,
          relationTable(schema, table, child) ?? table,
        );
      }
      return;
    }
    for (const child of Object.keys(record)) {
      harvest(schema, record[child], names, child, into, table);
    }
    return;
  }
  if (key === undefined || !names.has(key)) return;
  addEncoded(table, key, value, into);
}

function addEncoded(
  table: TableModel | undefined,
  key: string,
  value: unknown,
  into: Set<string>,
): void {
  const column = columnOn(table, key);
  if (column === undefined) return;
  pushEncoded(column.encode, value, into);
  if (column.elementEncode !== undefined && column.elementEncode !== column.encode) {
    pushEncoded(column.elementEncode, value, into);
  }
}

function pushEncoded(encode: (value: unknown) => string, value: unknown, into: Set<string>): void {
  try {
    const encoded = encode(value);
    if (typeof encoded === "string") into.add(encoded);
  } catch {
    // The codec refused this shape. Another encoder may still match the parameter.
  }
}

function columnOn(table: TableModel | undefined, field: string): ColumnModel | undefined {
  if (table === undefined) return undefined;
  for (const column of table.columns) {
    if (column.field === field && (column.hidden || column.sensitive)) return column;
  }
  return undefined;
}

function relationTable(
  schema: QuerySchema,
  table: TableModel,
  name: string | undefined,
): TableModel | undefined {
  if (name === undefined) return undefined;
  for (const relation of table.relations) {
    if (relation.name === name) return schema.model[relation.table];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(
  value: unknown,
  schema: QuerySchema,
  table: TableModel | undefined,
  key?: string,
): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, schema, table, key));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.op === "string" && "value" in record) {
      const op = record.op;
      if ((op === "has" || op === "none" || op === "every") && table !== undefined) {
        const related = relationTable(schema, table, key) ?? table;
        return { op, value: walk(record.value, schema, related) };
      }
      return { op, value: walk(record.value, schema, table, key) };
    }
    if (key === "include" && table !== undefined) {
      const out: Record<string, unknown> = {};
      for (const child of Object.keys(record)) {
        const related = relationTable(schema, table, child) ?? table;
        out[child] = walk(record[child], schema, related);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const child of Object.keys(record)) out[child] = walk(record[child], schema, table, child);
    return out;
  }
  if (key !== undefined && columnOn(table, key) !== undefined) return REDACTED;
  return value;
}
