/**
 * Insert, update, and delete.
 *
 * Loaded on the first write. Conflict SQL loads only when `onConflict` is not
 * `"error"`. Chunked writes go through the internal transaction runner.
 */

import type { ExecuteOptions, ExecuteResult, Statement } from "../contracts/driver.js";
import { OkmError, type ValidationIssue } from "../contracts/error.js";
import type { ClientFill, IdGenerators } from "../contracts/generator.js";
import type { ColumnModel, PresetUse } from "../dialects/pg/model.js";
import type { QuerySchema } from "../dialects/pg/model.js";
import type { AnyTable } from "../dialects/pg/table.js";
import { encodeJson } from "../dialects/pg/json.js";
import { arrayElementType, assertOperatorFits, textArray } from "../dialects/pg/operator-fit.js";
import { isOperator, operatorName, operatorValue } from "../dialects/pg/operators.js";
import {
  archiveRules,
  decodeRow,
  emitWhere,
  fail,
  withRowFilters,
  type ArchiveView,
  type CallScope,
  registerFailFix,
  indexes,
  isRecord,
  projectExpr,
  quote,
  rejectKeys,
  selectedColumns,
  takeObject,
  type Indexed,
  type Outputs,
  type Sink,
} from "./plan.js";
import {
  runSafety,
  safetyInstalled,
  type SafetyContribution,
  type SafetyHatch,
} from "./safety-hook.js";
import { stack } from "./preset-stack.js";
import { fieldSealed, sealingTrait, touchFields } from "./trait-read.js";
import { runWrite, type RunHost } from "./tx.js";
import { writeWouldValidate } from "./validate/places.js";

registerFailFix("OKM1102", "Pass where, or call .all(reason) to match every row.");
registerFailFix("OKM1190", "Remove the guarded field. Input cannot set it.");

/** Statements in one insert stay under this many parameters. The protocol limit is 65535. */
export const WRITE_PARAM_BUDGET = 2048;

const REDACTED = "[redacted]";

function encodeColumn(column: ColumnModel, value: unknown): string {
  if (!column.hidden && !column.sensitive) return column.encode(value);
  try {
    return column.encode(value);
  } catch (error) {
    if (error instanceof OkmError) {
      throw new OkmError(error.code, `Field ${column.field} was rejected.`, {
        kind: error.kind,
        fix: error.fix,
      });
    }
    throw error;
  }
}

/** A write the caller asked for. */
export type WriteOp = "insert" | "update" | "delete";

/** Modifiers chained on the write handle. */
export type WriteMods = {
  readonly all?: string;
  readonly expect?: number;
  readonly archive?: ArchiveView | undefined;
  /** Presets chained on the handle. `planWrite` resolves them into `presets`. */
  readonly uses?: PresetUse | undefined;
  /** Filters the chained presets added. Joined after each `where` with AND. */
  readonly presets?: readonly unknown[];
};

/** Pool and schema for one client. The client maps driver errors. */
export type WriteHost = RunHost & {
  readonly schema: QuerySchema;
  readonly generators?: IdGenerators | undefined;
};

/**
 * A planned write: its statements, and what turns their results into the value.
 *
 * `batch` flattens the statements of many operations into one atomic unit and
 * gives each operation back its own slice of the results.
 */
export type PreparedWrite = {
  readonly statements: readonly Statement[];
  readonly options: ExecuteOptions | undefined;
  /** Set when `finish` can refuse a statement that already ran. `batch` refuses such a write (D183). */
  readonly checked?: "restore" | "expect";
  finish(results: readonly ExecuteResult[]): unknown;
};

type Cell =
  | { readonly kind: "default" }
  | { readonly kind: "null"; readonly dataType: string }
  | { readonly kind: "value"; readonly wire: string; readonly dataType: string };

type Planned = {
  readonly statements: readonly Statement[];
  readonly outputs: Outputs;
  readonly shape: "row" | "rows" | "count";
  readonly expect: number | undefined;
  readonly keys: readonly (readonly (string | null)[])[] | undefined;
  readonly keyFields: readonly string[] | undefined;
};

type StoredSchema = QuerySchema & {
  readonly tables?: readonly AnyTable[];
  readonly validation?: unknown;
};

/**
 * Throws OKM1201 before any statement when this write would validate and the
 * validate module did not register.
 *
 * The message module loads only on that throw. A registered hook, a delete,
 * and `{ validate: false }` return without it.
 *
 * @param schema - Connected schema
 * @param op - Insert, update, or delete
 * @param tableName - Table name
 * @param options - Write options
 */
async function requireValidationImport(
  schema: QuerySchema,
  op: WriteOp,
  tableName: string,
  options: object,
): Promise<void> {
  if (op === "delete" || validationRegistered(schema)) return;
  const stored = schema as StoredSchema;
  const source = stored.tables?.find((item) => item.name === tableName);
  if (source === undefined || !writeWouldValidate(stored.validation, source, options)) return;
  const { refuseMissingValidation } = await import("./validate/closed.js");
  refuseMissingValidation();
}

/** The validate hook sets `~v` when `okmodel/validate` is imported before `schema()`. */
function validationRegistered(schema: QuerySchema): boolean {
  const hooks = schema.hooks;
  if (hooks === undefined) return false;
  for (const hook of hooks) {
    if ((hook as { readonly "~v"?: number })["~v"] === 1) return true;
  }
  return false;
}

const INSERT_OPTIONS = [
  "allow",
  "expect",
  "onConflict",
  "returning",
  "signal",
  "timeout",
  "validate",
] as const;
const FILTER_OPTIONS = ["allow", "expect", "returning", "signal", "timeout", "validate"] as const;
const NO_ALLOW: ReadonlySet<string> = new Set();

/**
 * Runs a write and decodes it.
 *
 * @param host - Client schema and pool
 * @param op - Insert, update, or delete
 * @param table - Table name
 * @param input - Rows, or the update or delete target
 * @param options - Returning, conflict, expect, signal, timeout
 * @param mods - `.all` and `.expect`
 * @param scope - Tenant scope of the client
 * @param plan - Return the {@link PreparedWrite} without running it, for `batch`
 * @returns Rows, one row, or `{ count }`
 */
export async function executeWrite(
  host: WriteHost,
  op: WriteOp,
  table: string,
  input: unknown,
  options: object,
  mods: WriteMods,
  scope?: CallScope,
  plan?: true,
): Promise<unknown> {
  const prepared = await prepareWrite(host, op, table, input, options, mods, scope);
  if (plan !== undefined) return prepared;
  if (prepared.statements.length === 0) return prepared.finish([]);
  const results = await runWrite(host, prepared.statements, prepared.options);
  return prepared.finish(results);
}

/**
 * Plans a write and returns its statements and the function that decodes the results.
 *
 * @param host - Client schema and pool
 * @param op - Insert, update, or delete
 * @param table - Table name
 * @param input - Rows, or the update or delete target
 * @param options - Returning, conflict, expect, signal, timeout
 * @param mods - `.all` and `.expect`
 * @param scope - Tenant scope of the client
 * @returns The statements in order, the call options, and `finish`
 */
async function prepareWrite(
  host: WriteHost,
  op: WriteOp,
  table: string,
  input: unknown,
  options: object,
  mods: WriteMods,
  scope?: CallScope,
): Promise<PreparedWrite> {
  try {
    const planned = await planWrite(
      host.schema,
      host.generators,
      op,
      table,
      input,
      options,
      mods,
      scope,
    );
    return {
      statements: planned.statements,
      options: callOptions(options),
      ...(planned.expect !== undefined ? { checked: "expect" as const } : {}),
      finish: (results) => finish(results, planned, table),
    };
  } catch (error) {
    throw scrubWrite(host.schema, table, input, error);
  }
}

/**
 * Plans a write and does not run it.
 *
 * @param schema - Connected schema
 * @param op - Insert, update, or delete
 * @param table - Table name
 * @param input - Rows, or the update or delete target
 * @param options - Returning, conflict, expect, signal, timeout
 * @param mods - `.all` and `.expect`
 * @param generators - Built-in replacements. Omitted uses the functions stored on the columns
 * @returns The statements in order
 */
export async function explainWrite(
  schema: QuerySchema,
  op: WriteOp,
  table: string,
  input: unknown,
  options: object,
  mods: WriteMods,
  generators?: IdGenerators,
  scope?: CallScope,
): Promise<{ readonly statements: readonly Statement[] }> {
  try {
    const planned = await planWrite(schema, generators, op, table, input, options, mods, scope);
    return { statements: planned.statements };
  } catch (error) {
    throw scrubWrite(schema, table, input, error);
  }
}

async function planWrite(
  schema: QuerySchema,
  generators: IdGenerators | undefined,
  op: WriteOp,
  tableName: string,
  input: unknown,
  options: object,
  mods: WriteMods,
  scope: CallScope | undefined,
): Promise<Planned> {
  await requireValidationImport(schema, op, tableName, options);
  const table = indexes(schema).get(tableName);
  if (table === undefined) {
    fail("OKM1120", `Table ${tableName} is not in the schema.`);
  }
  if (mods.uses !== undefined && op !== "insert") {
    const { resolve } = await import("./presets.js");
    mods = { ...mods, presets: resolve(schema, tableName, mods.uses).wheres };
  }
  const record = isRecord(options) ? options : {};
  rejectKeys(record, op === "insert" ? INSERT_OPTIONS : FILTER_OPTIONS, op);
  if (op === "insert") {
    return planInsert(table, input, record, mods, generators, scope, schema.tenancy);
  }
  if (op === "update") {
    return withRowFilters(scope, mods.archive, () => {
      noteArchive(table, mods.archive);
      return planUpdate(schema, table, input, record, mods);
    });
  }
  return withRowFilters(scope, mods.archive, () => {
    noteArchive(table, mods.archive);
    return planDelete(schema, table, input, record, mods);
  });
}

async function planInsert(
  table: Indexed,
  input: unknown,
  options: Record<string, unknown>,
  mods: WriteMods,
  generators: IdGenerators | undefined,
  scope: CallScope | undefined,
  tenancy: QuerySchema["tenancy"],
): Promise<Planned> {
  const allow = allowSet(table, options.allow);
  noteGuarded(table, allow, "insert");
  const many = Array.isArray(input);
  const rows = (many ? input : [input]).map((row) => insertRow(table, row, allow, tenancy));
  tenancy?.stamp(table.model.name, rows, scope);
  fillInsert(table, rows, generators);
  const columns = writtenColumns(table, rows, allow, tenancy?.key);
  const returning = selectedColumns(table, options.returning);
  const outputs = outputsOf(returning);
  const clause = returningClause(returning, undefined);
  const expect = expectOf(options, mods);
  const shape = many ? "rows" : "row";
  if (columns.length === 0) {
    const text = `insert into ${quote(table.model.sql)} default values${clause}`;
    return {
      statements: rows.map(() => ({ text })),
      outputs,
      shape,
      expect,
      keys: undefined,
      keyFields: undefined,
    };
  }
  const conflictMod =
    options.onConflict === undefined || options.onConflict === "error"
      ? undefined
      : await import("./conflict.js");
  const conflict = conflictMod?.readConflict(table, options.onConflict, allow);
  const chunks = chunkRows(rows.map((row) => cellsFor(columns, row)));
  const statements: Statement[] = [];
  const keys: (string | null)[][] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const slice = rows.slice(offset, offset + chunk.length);
    offset += chunk.length;
    const built = insertHead(table, columns, chunk);
    if (conflict === undefined || conflictMod === undefined) {
      statements.push(withParams(`${built.text}${clause}`, built.params));
      continue;
    }
    const keyRows =
      conflict.kind === "return" ? slice.map((row) => keyWire(conflict.columns, row)) : [];
    for (const row of keyRows) keys.push([...row]);
    statements.push(
      conflictMod.finishInsert(
        built.text,
        clause,
        built.params ?? [],
        conflict,
        table,
        returning,
        keyRows,
      ),
    );
  }
  return {
    statements,
    outputs,
    shape,
    expect,
    keys: conflict?.kind === "return" ? keys : undefined,
    keyFields:
      conflict?.kind === "return" ? conflict.columns.map((column) => column.field) : undefined,
  };
}

function planUpdate(
  schema: QuerySchema,
  table: Indexed,
  input: unknown,
  options: Record<string, unknown>,
  mods: WriteMods,
): Planned {
  const allow = allowSet(table, options.allow);
  noteGuarded(table, allow, "update");
  const returning = returningOption(table, options.returning);
  const outputs = outputsOf(returning);
  const expect = expectOf(options, mods);
  if (Array.isArray(input)) {
    const rows = input.map((item) => {
      const row = updateItem(table, item, allow, schema.tenancy);
      return { ...row, where: stack(row.where, mods.presets) };
    });
    return {
      statements: updateList(schema, table, rows, returning),
      outputs,
      shape: returning === undefined ? "count" : "rows",
      expect,
      keys: undefined,
      keyFields: undefined,
    };
  }
  if (!isRecord(input)) fail("OKM1121", "update expects { where, set } or a list of rows.");
  const set = writeSet(table, input.set, allow, schema.tenancy);
  requireFilter(table, input.where, mods, "update");
  if (Object.keys(set).length === 0) fail("OKM1120", "update set is empty.");
  const sql = new Sql();
  sql.text("update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  emitSet(sql, table, set, "t");
  emitFilter(schema, table, stack(input.where, mods.presets), sql, "t");
  sql.text(returningClause(returning, "t"));
  return {
    statements: [sql.statement()],
    outputs,
    shape: returning === undefined ? "count" : "rows",
    expect,
    keys: undefined,
    keyFields: undefined,
  };
}

function planDelete(
  schema: QuerySchema,
  table: Indexed,
  input: unknown,
  options: Record<string, unknown>,
  mods: WriteMods,
): Planned {
  if (!isRecord(input)) fail("OKM1121", "delete expects { where }.");
  rejectKeys(input, ["where"], "delete");
  requireFilter(table, input.where, mods, "delete");
  const returning = returningOption(table, options.returning);
  const sql = new Sql();
  sql.text("delete from ");
  sql.text(quote(table.model.sql));
  sql.text(" as t");
  emitFilter(schema, table, stack(input.where, mods.presets), sql, "t");
  sql.text(returningClause(returning, "t"));
  return {
    statements: [sql.statement()],
    outputs: outputsOf(returning),
    shape: returning === undefined ? "count" : "rows",
    expect: expectOf(options, mods),
    keys: undefined,
    keyFields: undefined,
  };
}

function finish(results: readonly ExecuteResult[], planned: Planned, table: string): unknown {
  if (planned.shape === "count") {
    let count = 0;
    for (const result of results) count += result.count;
    checkExpect(count, planned.expect, table, "write");
    return { count };
  }
  const decoded: Record<string, unknown>[] = [];
  for (const result of results) {
    for (const row of result.rows) decoded.push(decodeRow(planned.outputs, row));
  }
  const rows =
    planned.keys === undefined || planned.keyFields === undefined
      ? decoded
      : orderByKeys(decoded, planned.keyFields, planned.keys);
  checkExpect(rows.length, planned.expect, table, "insert");
  if (planned.shape === "row") return rows[0] ?? null;
  return rows;
}

function orderByKeys(
  rows: readonly Record<string, unknown>[],
  fields: readonly string[],
  keys: readonly (readonly (string | null)[])[],
): Record<string, unknown>[] {
  const found = new Map<string, Record<string, unknown>>();
  for (const row of rows) found.set(fields.map((field) => wireKey(row[field])).join("\0"), row);
  const ordered: Record<string, unknown>[] = [];
  for (const key of keys) {
    const row = found.get(key.map((value) => value ?? "").join("\0"));
    if (row !== undefined) ordered.push(row);
  }
  return ordered;
}

function wireKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function insertHead(
  table: Indexed,
  columns: readonly ColumnModel[],
  rows: readonly Cell[][],
): Statement {
  const params: (string | null)[] = [];
  const lists: string[] = [];
  for (const row of rows) {
    const slots: string[] = [];
    for (const cell of row) {
      if (cell.kind === "default") {
        slots.push("default");
        continue;
      }
      params.push(cell.kind === "null" ? null : cell.wire);
      slots.push(`$${String(params.length)}::${cell.dataType}`);
    }
    lists.push(`(${slots.join(", ")})`);
  }
  const names = columns.map((column) => quote(column.sql)).join(", ");
  return {
    text: `insert into ${quote(table.model.sql)} (${names}) values ${lists.join(", ")}`,
    params,
  };
}

function updateList(
  schema: QuerySchema,
  table: Indexed,
  rows: readonly { readonly where: unknown; readonly set: Record<string, unknown> }[],
  returning: readonly ColumnModel[] | undefined,
): readonly Statement[] {
  if (rows.length === 0) return [];
  const width = Math.max(1, Object.keys(rows[0]?.set ?? {}).length + 2);
  const size = Math.max(1, Math.floor(WRITE_PARAM_BUDGET / (width * 2)));
  const statements: Statement[] = [];
  for (let index = 0; index < rows.length; index += size) {
    statements.push(updateSlice(schema, table, rows.slice(index, index + size), returning));
  }
  return statements;
}

function updateSlice(
  schema: QuerySchema,
  table: Indexed,
  rows: readonly { readonly where: unknown; readonly set: Record<string, unknown> }[],
  returning: readonly ColumnModel[] | undefined,
): Statement {
  const fields: ColumnModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.set)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const column = table.columns.get(key);
      if (column !== undefined) fields.push(column);
    }
  }
  if (fields.length === 0) fail("OKM1120", "update set is empty.");
  const sql = new Sql();
  sql.text("update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  for (let field = 0; field < fields.length; field += 1) {
    const column = fields[field];
    if (column === undefined) continue;
    if (field > 0) sql.text(", ");
    sql.text(quote(column.sql));
    sql.text(" = case");
    for (const row of rows) {
      sql.text(" when ");
      emitBare(schema, table, row.where, sql, "t");
      sql.text(" then ");
      const value = row.set[column.field];
      if (value === undefined) sql.text(`t.${quote(column.sql)}`);
      else emitValue(sql, column, value, "t");
    }
    sql.text(" else t.");
    sql.text(quote(column.sql));
    sql.text(" end");
  }
  emitTouch(sql, table, fields.length > 0);
  sql.text(" where ");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (index > 0) sql.text(" or ");
    sql.text("(");
    emitBare(schema, table, row.where, sql, "t");
    sql.text(")");
  }
  sql.text(returningClause(returning, "t"));
  return sql.statement();
}

function emitSet(sql: Sql, table: Indexed, set: Record<string, unknown>, alias: string): void {
  const keys = Object.keys(set);
  let wrote = false;
  for (const key of keys) {
    const column = table.columns.get(key);
    if (column === undefined) continue;
    if (wrote) sql.text(", ");
    wrote = true;
    sql.text(quote(column.sql));
    sql.text(" = ");
    emitValue(sql, column, set[key], alias);
  }
  wrote = emitTouch(sql, table, wrote);
}

function emitTouch(sql: Sql, table: Indexed, wrote: boolean): boolean {
  const touch = touchFields(table.model);
  if (touch === undefined) return wrote;
  for (const field of touch) {
    const column = table.columns.get(field);
    if (column === undefined) continue;
    if (wrote) sql.text(", ");
    wrote = true;
    sql.text(quote(column.sql));
    sql.text(" = now()");
  }
  return wrote;
}

function emitValue(sql: Sql, column: ColumnModel, value: unknown, alias: string): void {
  if (isOperator(value)) {
    const name = operatorName(value);
    if (name === "inc") {
      const amount = operatorValue(value);
      if (typeof amount === "object" && amount !== null) {
        fail("OKM1121", `inc on ${column.field} needs a value.`);
      }
      sql.text(`${alias}.${quote(column.sql)} + `);
      sql.param(encodeColumn(column, amount), column.dataType);
      return;
    }
    if (name === "json.set") {
      emitJsonSet(sql, column, value, alias);
      return;
    }
    if (name === "arr.append" || name === "arr.remove") {
      emitArrayWrite(sql, column, name, value, alias);
      return;
    }
    fail(
      "OKM1121",
      `Field ${column.field} received an operator. set accepts a value, inc, set, or arr.`,
    );
  }
  if (value === null) {
    sql.text(`null::${column.dataType}`);
    return;
  }
  if (typeof value === "object") takeObject(column, value);
  sql.param(encodeColumn(column, value), column.dataType);
}

function emitJsonSet(sql: Sql, column: ColumnModel, value: unknown, alias: string): void {
  assertOperatorFits(column, "json.set");
  if (!isOperator(value)) fail("OKM1121", `json.set on ${column.field} needs a path and a value.`);
  const stored = operatorValue(value);
  if (!isRecord(stored) || !Array.isArray(stored.path)) {
    fail("OKM1121", `json.set on ${column.field} needs a path and a value.`);
  }
  const path = stored.path;
  if (path.length === 0 || path.some((item) => typeof item !== "string")) {
    fail("OKM1121", `json.set on ${column.field} needs a list of segments.`);
  }
  const encoded = encodeJson(stored.value);
  const ref = `${alias}.${quote(column.sql)}`;
  const target = column.dataType === "json" ? `${ref}::jsonb` : ref;
  sql.text(`jsonb_set(${target}, `);
  sql.param(textArray(path, `path on ${column.field}`), "text[]");
  sql.text(", ");
  sql.param(encoded, "jsonb");
  sql.text(")");
  if (column.dataType === "json") sql.text("::json");
}

function emitArrayWrite(
  sql: Sql,
  column: ColumnModel,
  name: "arr.append" | "arr.remove",
  value: unknown,
  alias: string,
): void {
  assertOperatorFits(column, name);
  const encode = column.elementEncode;
  if (encode === undefined) {
    fail(
      "OKM1124",
      `Operator ${name} does not apply to ${column.dataType} column ${column.field}. Accepted operators: eq, not, lt, lte, gt, gte, between, inList, notIn, inc.`,
    );
  }
  if (!isOperator(value)) {
    fail("OKM1121", `${name} on ${column.field} needs an element.`);
  }
  const fn = name === "arr.append" ? "array_append" : "array_remove";
  sql.text(`${fn}(${alias}.${quote(column.sql)}, `);
  sql.param(encode(operatorValue(value)), arrayElementType(column.dataType, column));
  sql.text(")");
}

function emitFilter(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  sql: Sql,
  alias: string,
): void {
  emitWhere(schema, table, where, sql.sink(), alias, 0);
}

function emitBare(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  sql: Sql,
  alias: string,
): void {
  let dropped = false;
  const sink: Sink = {
    text(value) {
      if (!dropped) {
        dropped = true;
        if (value === " where " || value === " and ") return;
      }
      sql.text(value);
    },
    param(encoded) {
      sql.param(encoded, "");
    },
    mark() {},
  };
  emitWhere(schema, table, where, sink, alias, 0);
  if (!dropped) {
    fail("OKM1102", `update on ${table.model.name} needs a where for each row.`);
  }
}

class Sql {
  private readonly parts: string[] = [];
  private readonly params: (string | null)[] = [];

  text(value: string): void {
    this.parts.push(value);
  }

  /**
   * Binds one parameter.
   *
   * An empty data type leaves the parameter uncast so `where` can infer it.
   */
  param(wire: string | null, dataType: string): void {
    this.params.push(wire);
    const slot = `$${String(this.params.length)}`;
    this.parts.push(dataType.length === 0 ? slot : `${slot}::${dataType}`);
  }

  sink(): Sink {
    return {
      text: (value) => {
        this.text(value);
      },
      param: (encoded) => {
        this.param(encoded, "");
      },
      mark() {},
    };
  }

  statement(): Statement {
    return this.params.length === 0
      ? { text: this.parts.join("") }
      : { text: this.parts.join(""), params: this.params };
  }
}

function insertRow(
  table: Indexed,
  value: unknown,
  allow: ReadonlySet<string>,
  tenancy: QuerySchema["tenancy"],
): Record<string, unknown> {
  if (!isRecord(value)) fail("OKM1121", "insert expects an object or a list of objects.");
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const column = table.columns.get(key);
    if (column === undefined) continue;
    tenancy?.guard(table.model.name, key, "insert");
    if (!writable(table, column, allow)) refuse(table, column);
    if (value[key] !== undefined) row[key] = value[key];
  }
  return row;
}

function cellsFor(columns: readonly ColumnModel[], row: Record<string, unknown>): Cell[] {
  return columns.map((column) => {
    if (!Object.hasOwn(row, column.field)) return { kind: "default" };
    const value = row[column.field];
    if (value === null) return { kind: "null", dataType: column.dataType };
    if (typeof value === "object") takeObject(column, value);
    return { kind: "value", wire: encodeColumn(column, value), dataType: column.dataType };
  });
}

function fillInsert(
  table: Indexed,
  rows: Record<string, unknown>[],
  generators: IdGenerators | undefined,
): void {
  const fills: ColumnModel[] = [];
  for (const column of table.model.columns) {
    if (column.fill !== undefined) fills.push(column);
  }
  if (fills.length === 0) return;
  for (const row of rows) {
    for (const column of fills) {
      if (Object.hasOwn(row, column.field)) continue;
      const fill = column.fill;
      if (fill === undefined) continue;
      row[column.field] = nextFill(fill, generators);
    }
  }
}

function nextFill(fill: ClientFill, generators: IdGenerators | undefined): unknown {
  if (fill.name === "uuidv4" && generators?.uuidv4 !== undefined) return generators.uuidv4();
  if (fill.name === "uuidv7" && generators?.uuidv7 !== undefined) return generators.uuidv7();
  if (fill.name === "okid" && generators?.okid !== undefined) return generators.okid();
  return fill.call();
}

function writtenColumns(
  table: Indexed,
  rows: readonly Record<string, unknown>[],
  allow: ReadonlySet<string>,
  tenantKey: string | undefined,
): ColumnModel[] {
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) present.add(key);
  }
  const columns: ColumnModel[] = [];
  for (const column of table.model.columns) {
    if (
      present.has(column.field) &&
      (writable(table, column, allow) || column.fill !== undefined || column.field === tenantKey)
    ) {
      columns.push(column);
    }
  }
  return columns;
}

function writeSet(
  table: Indexed,
  value: unknown,
  allow: ReadonlySet<string>,
  tenancy: QuerySchema["tenancy"],
): Record<string, unknown> {
  if (!isRecord(value)) fail("OKM1121", "set must be an object of fields.");
  const set: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    const column = table.columns.get(key);
    if (column === undefined) continue;
    tenancy?.guard(table.model.name, key, "update");
    if (column.guardUpdate || !writable(table, column, allow)) refuse(table, column);
    set[key] = value[key];
  }
  return set;
}

function updateItem(
  table: Indexed,
  value: unknown,
  allow: ReadonlySet<string>,
  tenancy: QuerySchema["tenancy"],
): { readonly where: unknown; readonly set: Record<string, unknown> } {
  if (!isRecord(value)) fail("OKM1121", "update expects { where, set } or a list of rows.");
  const set = writeSet(table, value.set, allow, tenancy);
  if (value.where !== undefined) return { where: value.where, set };
  if (value.id !== undefined) return { where: { id: value.id }, set };
  fail("OKM1102", `update on ${table.model.name} needs id or where for each row.`);
}

function requireFilter(table: Indexed, where: unknown, mods: WriteMods, op: WriteOp): void {
  if (mods.all !== undefined) {
    if (mods.all.trim().length === 0) {
      fail("OKM1102", `${op} on ${table.model.name} needs a where. .all needs a reason.`);
    }
    return;
  }
  if (isOperator(where)) return;
  if (isRecord(where) && Object.keys(where).length > 0) return;
  fail("OKM1102", `${op} on ${table.model.name} needs a where. Pass a filter, or .all(reason).`);
}

function chunkRows(rows: readonly Cell[][]): Cell[][][] {
  const chunks: Cell[][][] = [];
  let current: Cell[][] = [];
  let count = 0;
  for (const row of rows) {
    let cost = 0;
    for (const cell of row) if (cell.kind !== "default") cost += 1;
    if (current.length > 0 && count + cost > WRITE_PARAM_BUDGET) {
      chunks.push(current);
      current = [];
      count = 0;
    }
    current.push(row);
    count += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function withParams(text: string, params: readonly (string | null)[] | undefined): Statement {
  if (params === undefined || params.length === 0) return { text };
  return { text, params };
}

function keyWire(columns: readonly ColumnModel[], row: Record<string, unknown>): (string | null)[] {
  return columns.map((column) => {
    const value = row[column.field];
    if (value === undefined || value === null) return null;
    return encodeColumn(column, value);
  });
}

function returningOption(table: Indexed, value: unknown): readonly ColumnModel[] | undefined {
  if (value === undefined) return undefined;
  return selectedColumns(table, value);
}

function returningClause(
  columns: readonly ColumnModel[] | undefined,
  alias: string | undefined,
): string {
  if (columns === undefined || columns.length === 0) return "";
  const parts = columns.map((column) => {
    const sql = alias === undefined ? quote(column.sql) : `${alias}.${quote(column.sql)}`;
    return projectExpr(sql, column.dataType);
  });
  return ` returning ${parts.join(", ")}`;
}

function outputsOf(columns: readonly ColumnModel[] | undefined): Outputs {
  const list = columns ?? [];
  return {
    fields: list.map((column, index) => ({
      key: column.field,
      at: index,
      decode: column.decode,
    })),
    includes: [],
  };
}

function expectOf(options: Record<string, unknown>, mods: WriteMods): number | undefined {
  const value = mods.expect ?? options.expect;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OkmError("invalid", "expect must be an integer from 0 up.", { kind: "invalid" });
  }
  return value;
}

function checkExpect(count: number, expected: number | undefined, table: string, op: string): void {
  if (expected === undefined || count === expected) return;
  throw new OkmError(
    "not_found",
    `${op} on ${table} changed ${String(count)} rows. expect was ${String(expected)}.`,
    {
      kind: "not_found",
      table,
      fix: { summary: "Change the filter, or pass the count this write produced." },
    },
  );
}

function callOptions(options: object): ExecuteOptions | undefined {
  if (!isRecord(options)) return undefined;
  const signal = options.signal;
  const timeout = options.timeout;
  const hasSignal = typeof signal === "object" && signal !== null && "aborted" in signal;
  const hasTimeout = typeof timeout === "number";
  if (!hasSignal && !hasTimeout) return undefined;
  return {
    ...(hasSignal ? { signal: signal as AbortSignal } : {}),
    ...(hasTimeout ? { timeout } : {}),
  };
}

function refuse(table: Indexed, column: ColumnModel): never {
  if (fieldSealed(table.model, column.field)) {
    fail(
      "OKM1190",
      `Field ${table.model.name}.${column.field} is set by a trait. Input cannot set it.`,
    );
  }
  if (column.guardUpdate) {
    fail(
      "OKM1190",
      `Field ${table.model.name}.${column.field} is a primary key. Input cannot change it.`,
    );
  }
  if (column.guarded) {
    fail("OKM1190", `Field ${table.model.name}.${column.field} is guarded. Input cannot set it.`);
  }
  fail("OKM1120", `Field ${table.model.name}.${column.field} cannot be written.`);
}

function writable(table: Indexed, column: ColumnModel, allow: ReadonlySet<string>): boolean {
  if (fieldSealed(table.model, column.field)) return false;
  if (column.writable) return true;
  return column.guarded && allow.has(column.field);
}

function allowSet(table: Indexed, value: unknown): ReadonlySet<string> {
  if (value === undefined) return NO_ALLOW;
  if (!Array.isArray(value)) fail("OKM1120", "allow must be a list of field names.");
  const set = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || !table.columns.has(name)) {
      fail("OKM1120", "allow must name fields on the table.");
    }
    set.add(name);
  }
  return set;
}

function noteArchive(table: Indexed, view: ArchiveView | undefined): void {
  if (!safetyInstalled()) return;
  const rules = archiveRules(table.model, view);
  if (rules === undefined) return;
  runSafety(rules, undefined);
}

function noteGuarded(table: Indexed, allow: ReadonlySet<string>, op: "insert" | "update"): void {
  if (!safetyInstalled()) return;
  const contributions: SafetyContribution[] = [];
  const hatches: SafetyHatch[] = [];
  const touch = touchFields(table.model);
  const source = table.model.source;
  for (const column of table.model.columns) {
    const traitName = sealingTrait(table.model, column.field);
    if (traitName !== undefined) {
      const sets = op === "insert" || touch?.includes(column.field) === true;
      contributions.push({
        rule: traitName,
        contribution: sets
          ? `${traitName} ${table.model.name}.${column.field} set by ${traitName}`
          : `${traitName} ${table.model.name}.${column.field} kept`,
        provenance: "planner",
        ...(source !== undefined ? { source } : {}),
      });
      continue;
    }
    if (!column.guarded) continue;
    const name = `${table.model.name}.${column.field}`;
    if (allow.has(column.field)) {
      contributions.push({
        rule: "guarded",
        contribution: `guarded ${name} allowed`,
        provenance: "allow",
      });
      hatches.push({ name: "allow", reason: name });
    } else {
      contributions.push({
        rule: "guarded",
        contribution: `guarded ${name} absent`,
        provenance: "planner",
      });
    }
  }
  if (contributions.length === 0) return;
  runSafety(contributions, hatches.length === 0 ? undefined : hatches);
}

function scrubWrite(
  schema: QuerySchema,
  tableName: string,
  input: unknown,
  error: unknown,
): unknown {
  if (!(error instanceof OkmError)) return error;
  const table = indexes(schema).get(tableName);
  if (table === undefined || table.model.conceal !== true) return error;
  const secrets: string[] = [];
  const names = new Set<string>();
  for (const column of table.model.columns) {
    if (column.hidden || column.sensitive) names.add(column.field);
  }
  collectSecrets(input, names, secrets);
  if (secrets.length === 0) return error;
  let message = error.message;
  for (const secret of secrets) {
    if (secret.length < 4 || !message.includes(secret)) continue;
    message = message.replaceAll(secret, REDACTED);
  }
  const issues = error.issues === undefined ? undefined : redactIssues(error.issues, secrets);
  if (message === error.message && issues === undefined) return error;
  return new OkmError(error.code, message, {
    kind: error.kind,
    ...(error.table !== undefined ? { table: error.table } : {}),
    ...(error.columns.length > 0 ? { columns: error.columns } : {}),
    ...(error.issues !== undefined ? { issues: issues ?? error.issues } : {}),
    fix: error.fix,
  });
}

function redactIssues(
  issues: readonly ValidationIssue[],
  secrets: readonly string[],
): readonly ValidationIssue[] | undefined {
  let changed = false;
  const next = issues.map((issue) => {
    let message = issue.message;
    for (const secret of secrets) {
      if (secret.length < 4 || !message.includes(secret)) continue;
      message = message.replaceAll(secret, REDACTED);
      changed = true;
    }
    return message === issue.message ? issue : { path: issue.path, message };
  });
  return changed ? next : undefined;
}

function collectSecrets(
  value: unknown,
  names: ReadonlySet<string>,
  found: string[],
  key?: string,
): void {
  if (typeof value === "string") {
    if (key !== undefined && names.has(key)) found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, names, found);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.keys(value)) collectSecrets(value[child], names, found, child);
}
