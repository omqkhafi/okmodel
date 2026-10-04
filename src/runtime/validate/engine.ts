/**
 * Validation engine.
 *
 * Loaded on the first validated write or standalone call. A failed import
 * rejects that call. Nothing here runs when validation is off.
 */

import { OkmError, type ValidationIssue } from "../../contracts/error.js";
import type { ColumnModel, TableModel, ValidationModel } from "../../dialects/pg/model.js";
import { isOperator } from "../../dialects/pg/operators.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import { validationGate } from "./places.js";

const BRAND = Symbol("okmodel.validated");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_TEXT = /^-?\d+$/;

const INTEGER_RANGE: Readonly<Record<string, readonly [bigint, bigint]>> = {
  smallint: [-32_768n, 32_767n],
  integer: [-2_147_483_648n, 2_147_483_647n],
  bigint: [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n],
};

type Op = "insert" | "update";

/**
 * Validates a write input and returns the transformed rows.
 *
 * Branded values are copied and not checked again. The copy stays mutable so
 * insert can fill a client default.
 *
 * @param model - Table model. The gate is stored here on first use
 * @param source - Table whose stored rules are read
 * @param schemaFlag - The schema `validation` option, as stored
 * @param op - Insert or update
 * @param input - One row, a list, or an update target
 * @returns The input with transforms applied
 */
export async function prepare(
  model: TableModel,
  source: AnyTable,
  schemaFlag: unknown,
  op: Op,
  input: unknown,
): Promise<unknown> {
  engage(model, source, schemaFlag);
  if (op === "update") return finishUpdate(model, input);
  return finish(model, "insert", input, false, false, undefined, undefined);
}

/**
 * Standalone `validate` or `check`.
 *
 * `valid` returns a frozen branded value or throws OKM1200. `check` returns
 * the issues and does not throw for a failed check.
 *
 * @param model - Table model. The gate is stored here on first use
 * @param source - Table whose stored rules are read
 * @param schemaFlag - The schema `validation` option, as stored
 * @param op - Insert or update
 * @param body - One row, a list, or an update patch
 * @param mode - Throw, or return issues
 * @param pick - Fields to keep. Omitted, every field is kept
 * @param omit - Fields to drop
 * @returns The branded value, or the issues
 */
export async function stand(
  model: TableModel,
  source: AnyTable,
  schemaFlag: unknown,
  op: Op,
  body: unknown,
  mode: "valid" | "check",
  pick?: readonly string[],
  omit?: readonly string[],
): Promise<unknown> {
  engage(model, source, schemaFlag);
  const input = op === "update" ? patchOf(body) : body;
  if (mode === "check") return issuesOf(model, op, input, pick, omit);
  return finish(model, op, input, true, true, pick, omit);
}

function engage(model: TableModel, source: AnyTable, schemaFlag: unknown): void {
  const gate = validationGate(schemaFlag, source);
  if (gate !== undefined) (model as { validation?: ValidationModel }).validation = gate;
}

async function finishUpdate(model: TableModel, input: unknown): Promise<unknown> {
  if (Array.isArray(input)) {
    const items: unknown[] = [];
    const issues: ValidationIssue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      if (!isRecord(item)) failShape("update expects { where, set } or a list of rows.");
      const set = await oneValue(model, "update", item.set, false, false, undefined, undefined);
      pushIndexed(issues, index, set.issues);
      items.push({ ...item, set: set.row });
    }
    if (issues.length > 0) throwIssues(issues);
    return items;
  }
  if (!isRecord(input) || !isRecord(input.set)) return input;
  const set = await oneValue(model, "update", input.set, false, false, undefined, undefined);
  if (set.issues.length > 0) throwIssues(set.issues);
  return { ...input, set: set.row };
}

async function finish(
  model: TableModel,
  op: Op,
  input: unknown,
  seal: boolean,
  strict: boolean,
  pick: readonly string[] | undefined,
  omit: readonly string[] | undefined,
): Promise<unknown> {
  if (Array.isArray(input)) {
    const rows: Record<string, unknown>[] = [];
    const issues: ValidationIssue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const one = await oneValue(model, op, input[index], seal, strict, pick, omit);
      pushIndexed(issues, index, one.issues);
      rows.push(one.row);
    }
    if (issues.length > 0) throwIssues(issues);
    return seal ? Object.freeze(rows) : rows;
  }
  const one = await oneValue(model, op, input, seal, strict, pick, omit);
  if (one.issues.length > 0) throwIssues(one.issues);
  return one.row;
}

async function issuesOf(
  model: TableModel,
  op: Op,
  input: unknown,
  pick: readonly string[] | undefined,
  omit: readonly string[] | undefined,
): Promise<readonly ValidationIssue[]> {
  if (Array.isArray(input)) {
    const issues: ValidationIssue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const one = await oneValue(model, op, input[index], false, true, pick, omit);
      pushIndexed(issues, index, one.issues);
    }
    return issues;
  }
  const one = await oneValue(model, op, input, false, true, pick, omit);
  return one.issues;
}

function pushIndexed(
  issues: ValidationIssue[],
  index: number,
  found: readonly ValidationIssue[],
): void {
  for (const issue of found) issues.push({ path: [index, ...issue.path], message: issue.message });
}

async function oneValue(
  model: TableModel,
  op: Op,
  input: unknown,
  seal: boolean,
  strict: boolean,
  pick: readonly string[] | undefined,
  omit: readonly string[] | undefined,
): Promise<{ readonly row: Record<string, unknown>; readonly issues: ValidationIssue[] }> {
  if (!isRecord(input)) failShape("insert expects an object or a list of objects.");
  if (isBranded(input)) {
    const row = copyRow(input);
    keep(row, pick, omit);
    return { row: seal ? sealRow(row) : row, issues: [] };
  }
  const row = acceptKeys(model, op, input, strict);
  keep(row, pick, omit);
  const gate = model.validation;
  const issues: ValidationIssue[] = [];
  if (gate === undefined) return { row, issues };
  for (const column of model.columns) {
    if (!column.writable || (op === "update" && column.guardUpdate)) continue;
    if (!Object.hasOwn(row, column.field)) {
      if (
        op === "insert" &&
        gate.required.includes(column.field) &&
        selected(column.field, pick, omit)
      ) {
        issues.push({ path: [column.field], message: "required" });
      }
      continue;
    }
    if (!selected(column.field, pick, omit)) continue;
    let value = row[column.field];
    if (isOperator(value)) continue;
    if (value === null) {
      if (gate.notNull.includes(column.field))
        issues.push({ path: [column.field], message: "required" });
      continue;
    }
    value = await applyTransforms(gate.fields[column.field], op, value);
    row[column.field] = value;
    issues.push(...derivedIssues(column, gate, value));
    const checked = await checkRules(gate.fields[column.field], op, value, column.field);
    row[column.field] = checked.value;
    issues.push(...checked.issues);
  }
  const rowChecked = await checkRules(gate.row, op, row, undefined);
  issues.push(...rowChecked.issues);
  if (seal && issues.length === 0) return { row: sealRow(row), issues };
  return { row, issues };
}

function acceptKeys(
  model: TableModel,
  op: Op,
  input: Record<string, unknown>,
  strict: boolean,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const column = findColumn(model, key);
    if (column === undefined) continue;
    const blocked = (op === "update" && column.guardUpdate) || !column.writable;
    if (blocked) {
      if (strict) {
        const reason =
          op === "update" && column.guardUpdate
            ? "is a primary key"
            : column.guarded
              ? "is guarded"
              : "cannot be written";
        refuse(model.name, key, reason);
      }
      if (input[key] !== undefined) row[key] = input[key];
      continue;
    }
    if (input[key] !== undefined) row[key] = input[key];
  }
  return row;
}

function refuse(table: string, field: string, reason: string): never {
  throw new OkmError("OKM1190", `Field ${table}.${field} ${reason}. Input cannot set it.`, {
    kind: "invalid",
    fix: { summary: "Remove the guarded field. Input cannot set it." },
  });
}

function keep(
  row: Record<string, unknown>,
  pick: readonly string[] | undefined,
  omit: readonly string[] | undefined,
): void {
  if (pick === undefined && omit === undefined) return;
  for (const key of Object.keys(row)) {
    if (!selected(key, pick, omit)) delete row[key];
  }
}

function selected(
  field: string,
  pick: readonly string[] | undefined,
  omit: readonly string[] | undefined,
): boolean {
  if (pick !== undefined && !pick.includes(field)) return false;
  if (omit !== undefined && omit.includes(field)) return false;
  return true;
}

async function applyTransforms(
  rules: readonly unknown[] | undefined,
  op: Op,
  value: unknown,
): Promise<unknown> {
  if (rules === undefined) return value;
  let phase: Op | undefined;
  let current = value;
  for (const item of rules) {
    const step = active(item, phase);
    phase = step.phase;
    if (step.rule === undefined || (step.limit !== undefined && step.limit !== op)) continue;
    if (isTransform(step.rule)) current = transformValue(step.rule, current);
  }
  return current;
}

async function checkRules(
  rules: readonly unknown[] | undefined,
  op: Op,
  value: unknown,
  field: string | undefined,
): Promise<{ readonly value: unknown; readonly issues: ValidationIssue[] }> {
  if (rules === undefined) return { value, issues: [] };
  const issues: ValidationIssue[] = [];
  let phase: Op | undefined;
  let current = value;
  for (const item of rules) {
    const step = active(item, phase);
    phase = step.phase;
    if (step.rule === undefined || (step.limit !== undefined && step.limit !== op)) continue;
    const rule = step.rule;
    if (isTransform(rule)) continue;
    if (isStandard(rule)) {
      const result = await rule["~standard"].validate(current);
      if (result.issues === undefined) {
        current = result.value;
        continue;
      }
      for (const issue of result.issues) {
        issues.push({ path: issuePath(field, issue.path), message: issue.message });
      }
      continue;
    }
    if (rule.k === "email" && typeof rule.key === "string") {
      if (typeof current !== "string" || !EMAIL.test(current))
        issues.push(fieldIssue(field, rule.key));
      continue;
    }
    if (rule.k === "min" && typeof rule.n === "number" && typeof rule.key === "string") {
      const ok =
        typeof current === "string"
          ? textLength(current) >= rule.n
          : typeof current === "number" && current >= rule.n;
      if (!ok) issues.push(fieldIssue(field, rule.key));
      continue;
    }
    if (
      rule.k === "rule" &&
      typeof rule.fn === "function" &&
      typeof rule.path === "string" &&
      typeof rule.key === "string" &&
      !rule.fn(current)
    ) {
      issues.push({ path: [rule.path], message: rule.key });
    }
  }
  return { value: current, issues };
}

function fieldIssue(field: string | undefined, message: string): ValidationIssue {
  return { path: field === undefined ? [] : [field], message };
}

function derivedIssues(
  column: ColumnModel,
  gate: ValidationModel,
  value: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = column.dataType.replace(/\[\]/g, "");
  const length = /^(?:varchar|character varying|char|character)\((\d+)\)$/.exec(type);
  if (length !== null && typeof value === "string" && textLength(value) > Number(length[1])) {
    issues.push({ path: [column.field], message: "too_long" });
  }
  const list = gate.pick[column.field];
  if (list !== undefined && (typeof value !== "string" || !list.includes(value))) {
    issues.push({ path: [column.field], message: "picklist" });
  }
  const range = INTEGER_RANGE[type];
  if (range !== undefined && !integerInRange(value, range[0], range[1])) {
    issues.push({ path: [column.field], message: "integer_range" });
  }
  if (
    type === "numeric" ||
    type.startsWith("numeric(") ||
    type === "real" ||
    type === "double precision"
  ) {
    if (!precisionOk(type, value)) issues.push({ path: [column.field], message: "precision" });
  }
  if (type === "uuid" && (typeof value !== "string" || !UUID.test(value))) {
    issues.push({ path: [column.field], message: "uuid" });
  }
  if ((type === "json" || type === "jsonb") && !jsonOk(value)) {
    issues.push({ path: [column.field], message: "json" });
  }
  return issues;
}

function textLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

function integerInRange(value: unknown, low: bigint, high: bigint): boolean {
  const parsed = integerValue(value);
  if (parsed === undefined) return false;
  return parsed >= low && parsed <= high;
}

function integerValue(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && INTEGER_TEXT.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function precisionOk(type: string, value: unknown): boolean {
  if (type === "real" || type === "double precision") {
    return typeof value === "number" && Number.isFinite(value);
  }
  const text =
    typeof value === "number"
      ? Number.isFinite(value)
        ? String(value)
        : ""
      : typeof value === "string"
        ? value
        : "";
  const plain = plainDecimal(text);
  if (plain === undefined) return false;
  const match = /^numeric\((\d+)(?:,(\d+))?\)$/.exec(type);
  if (match === null) return true;
  const precision = Number(match[1]);
  const scale = match[2] === undefined ? 0 : Number(match[2]);
  const [whole, fraction = ""] = plain.replace(/^-/, "").split(".");
  const digits = `${whole === "0" ? "" : whole}${fraction}`.replace(/^0+/, "");
  return (
    fraction.length <= scale &&
    (whole ?? "").replace(/^0+/, "").length <= precision - scale &&
    digits.length <= precision
  );
}

function plainDecimal(text: string): string | undefined {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) return undefined;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exp = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isSafeInteger(exp)) return undefined;
  const digits = `${whole}${fraction}`;
  const point = whole.length + exp;
  let plain: string;
  if (point >= digits.length) plain = digits + "0".repeat(point - digits.length);
  else if (point > 0) plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  else plain = `0.${"0".repeat(-point)}${digits}`;
  return `${match[1] ?? ""}${plain}`;
}

function jsonOk(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

type StandardSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly validate: (value: unknown) => StandardResult | Promise<StandardResult>;
  };
};

type StandardResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | {
      readonly issues: readonly {
        readonly message: string;
        readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
      }[];
    };

function isStandard(value: unknown): value is StandardSchema {
  if (typeof value !== "object" || value === null || !("~standard" in value)) return false;
  const standard = (
    value as { readonly "~standard": { readonly version?: unknown; readonly validate?: unknown } }
  )["~standard"];
  return (
    typeof standard === "object" &&
    standard !== null &&
    standard.version === 1 &&
    typeof standard.validate === "function"
  );
}

type Active = {
  readonly phase: Op | undefined;
  readonly limit: Op | undefined;
  readonly rule: Rule | StandardSchema | undefined;
};

type Rule = {
  readonly k: string;
  readonly key?: string;
  readonly n?: number;
  readonly path?: string;
  readonly fn?: (value: unknown) => boolean;
  readonly op?: Op;
  readonly rule?: unknown;
};

function active(item: unknown, phase: Op | undefined): Active {
  if (isStandard(item)) return { phase, limit: undefined, rule: item };
  if (!isRule(item)) return { phase, limit: undefined, rule: undefined };
  if (item.k === "phase" && (item.op === "insert" || item.op === "update")) {
    return { phase: item.op, limit: undefined, rule: undefined };
  }
  if (item.k === "when" && (item.op === "insert" || item.op === "update")) {
    const inner = item.rule;
    if (isStandard(inner) || isRule(inner)) return { phase, limit: item.op, rule: inner };
  }
  return { phase, limit: phase, rule: item };
}

function isRule(value: unknown): value is Rule {
  return (
    typeof value === "object" &&
    value !== null &&
    "k" in value &&
    typeof (value as { readonly k: unknown }).k === "string"
  );
}

function isTransform(rule: Rule | StandardSchema): rule is Rule & { readonly k: "trim" | "lower" } {
  return !isStandard(rule) && (rule.k === "trim" || rule.k === "lower");
}

function transformValue(rule: Rule, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (rule.k === "trim") return value.trim();
  if (rule.k === "lower") return value.toLowerCase();
  return value;
}

function issuePath(
  field: string | undefined,
  path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined,
): readonly (string | number)[] {
  const segments: (string | number)[] = [];
  if (field !== undefined) segments.push(field);
  if (path === undefined) return segments;
  for (const part of path) {
    const key = typeof part === "object" && part !== null && "key" in part ? part.key : part;
    if (typeof key === "string" || typeof key === "number") segments.push(key);
  }
  return segments;
}

function patchOf(body: unknown): unknown {
  if (isRecord(body) && isRecord(body.set)) return body.set;
  return body;
}

function copyRow(value: object): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(value)) row[key] = (value as Record<string, unknown>)[key];
  return row;
}

function sealRow(row: Record<string, unknown>): Record<string, unknown> {
  Object.defineProperty(row, BRAND, { value: true });
  return Object.freeze(row);
}

function isBranded(value: object): boolean {
  return Object.hasOwn(value, BRAND) && (value as Record<symbol, unknown>)[BRAND] === true;
}

function findColumn(model: TableModel, field: string): ColumnModel | undefined {
  for (const column of model.columns) if (column.field === field) return column;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failShape(message: string): never {
  throw new OkmError("OKM1121", message, { kind: "invalid" });
}

function throwIssues(issues: readonly ValidationIssue[]): never {
  const columns: string[] = [];
  for (const issue of issues) {
    const field = [...issue.path].reverse().find((part) => typeof part === "string");
    if (typeof field === "string" && !columns.includes(field)) columns.push(field);
  }
  throw new OkmError("OKM1200", "Validation failed.", {
    kind: "invalid",
    ...(columns.length > 0 ? { columns } : {}),
    issues,
    fix: { summary: "Fix the fields named in issues. Each issue message is a key." },
  });
}
