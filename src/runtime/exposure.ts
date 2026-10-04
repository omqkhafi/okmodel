/**
 * Redaction for hidden and sensitive fields.
 *
 * Loaded the first time a concealed table is inspected or a read of one fails.
 */

import { OkmError } from "../contracts/error.js";
import type { QuerySchema, TableModel } from "../dialects/pg/model.js";
import { isOperator, operatorValue } from "../dialects/pg/operators.js";
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
  const names = concealedNames(schema);
  const secrets = new Set<string>();
  harvest(schema, call.where, names, undefined, secrets);
  harvest(schema, call.include, names, undefined, secrets);
  const model = schema.model[call.table];
  const rules = model === undefined ? view.rules : [...view.rules, ...exposureRules(model, call)];
  if (safetyInstalled()) runSafety(rules, undefined);
  return {
    ...view,
    intent: {
      ...view.intent,
      where: walk(view.intent.where, names),
      include: walk(view.intent.include, names),
    },
    rules,
    sql: {
      ...view.sql,
      params: view.sql.params.map((value) =>
        value !== null && secrets.has(value) ? REDACTED : value,
      ),
    },
  };
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
  harvest(schema, call.where, names, undefined, secrets);
  harvest(schema, call.include, names, undefined, secrets);
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
): void {
  if (Array.isArray(value)) {
    for (const item of value) harvest(schema, item, names, key, into);
    return;
  }
  if (isOperator(value)) {
    harvest(schema, operatorValue(value), names, key, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const child of Object.keys(record)) harvest(schema, record[child], names, child, into);
    return;
  }
  if (key === undefined || !names.has(key)) return;
  const encode = encodeOf(schema, key);
  if (encode === undefined) return;
  try {
    into.add(encode(value));
  } catch {
    // The codec already refused the value.
  }
}

function encodeOf(schema: QuerySchema, field: string): ((value: unknown) => string) | undefined {
  for (const model of Object.values(schema.model)) {
    for (const column of model.columns) {
      if (column.field === field && (column.hidden || column.sensitive)) {
        return column.encode as (value: unknown) => string;
      }
    }
  }
  return undefined;
}

function walk(value: unknown, names: ReadonlySet<string>, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, names, key));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.op === "string" && "value" in record) {
      return { op: record.op, value: walk(record.value, names, key) };
    }
    const out: Record<string, unknown> = {};
    for (const child of Object.keys(record)) out[child] = walk(record[child], names, child);
    return out;
  }
  if (key !== undefined && names.has(key)) return REDACTED;
  return value;
}
