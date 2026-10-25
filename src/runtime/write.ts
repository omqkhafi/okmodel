/**
 * Insert, update, and delete.
 *
 * Loaded on the first write. Conflict SQL loads only when `onConflict` is not
 * `"error"`. Chunked writes go through the internal transaction runner.
 */

import type { ExecuteOptions, ExecuteResult, Statement } from "../contracts/driver.js";
import { OkmError, throwNamed, type ValidationIssue } from "../contracts/error.js";
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
  list,
  projectExpr,
  quote,
  rejectKeys,
  selectedColumns,
  takeObject,
  type Indexed,
  type Outputs,
  type Sink,
} from "./plan.js";
import { assertParamCount } from "./param-limit.js";
import {
  runSafety,
  safetyInstalled,
  type SafetyContribution,
  type SafetyHatch,
} from "./safety-hook.js";
import { stack } from "./preset-stack.js";
import { effectivePredicate } from "./predicate.js";
import { fieldSealed, sealingTrait, touchFields } from "./trait-read.js";
import { assertObserveKeys, observeKeyList } from "./observe-keys.js";
import { runWrite, type RunHost, type WriteObserveMeta } from "./tx.js";
import { writeWouldValidate } from "./validate/places.js";

registerFailFix(
  "OKM1102",
  "Pass a predicate. An undefined-only where is the same as an empty filter.",
);
registerFailFix("OKM1190", "Remove the guarded field. Input cannot set it.");
/** Statements in one insert stay under this many parameters. The shared driver ceiling is 65533 (B-48). */
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
  /**
   * Set when `finish` can refuse a statement that already ran. `batch` refuses such a write (D183).
   * `version` is the exception inside `tx()`: the savepoint rolls back with the transaction.
   */
  readonly checked?: "restore" | "expect" | "parent" | "tree" | "version";
  /** The caller's input, so `batch` can redact sensitive values from observed parameters. */
  readonly input?: unknown;
  /** Observe metadata shared by statements that did not opt into keys. */
  readonly observe?: WriteObserveMeta;
  /**
   * Per-statement observe metadata.
   *
   * Set when `writeObserver({ keys })` includes this table, so a quiet lock
   * does not receive the insert's primary-key columns.
   */
  readonly observeStatements?: readonly WriteObserveMeta[];
  finish(results: readonly ExecuteResult[]): unknown;
  /**
   * More statements once the planned ones have run.
   *
   * First-or-create uses this when the insert returned fewer rows than it was
   * given. Empty means the insert already returned every row.
   */
  follow?(results: readonly ExecuteResult[]): readonly Statement[];
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
  /** Conflict columns, in key order. Used to match a returned row to its input. */
  readonly keyColumns: readonly ColumnModel[] | undefined;
  /** Rows a path insert must return. Fewer means the parent is not in this tenant. */
  readonly parent?: number;
  /** The statement returns matched and updated counts. A shortfall is OKM1705. */
  readonly parentGuard?: boolean;
  /**
   * The statement returns matched and updated counts. A shortfall is a tree cycle
   * (OKM1120): the new parent is this row or one of its descendants.
   */
  readonly treeGuard?: boolean;
  /**
   * Statement indexes whose rows are not part of the write result.
   *
   * A sortable insert locks in one statement, then inserts in the next. The
   * lock returns a row per group. Those rows are not inserted rows.
   */
  readonly quiet?: readonly number[];
  /**
   * Statements to run when the insert did not return every input row.
   *
   * First-or-create only. The lookup is a new statement so it sees a row
   * committed while the insert waited (D246).
   */
  readonly recover?: (rows: readonly Record<string, unknown>[]) => readonly Statement[];
  /**
   * Set when the update checked `version`.
   *
   * The statement returns a stale count in the first column. A positive count
   * means nothing was written.
   */
  readonly versioned?: {
    readonly fields: readonly string[];
    readonly sent: readonly number[];
  };
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
const UPDATE_KEYS = ["set", "where", "limit", "lock", "version"] as const;
const UPDATE_ROW_KEYS = ["id", "set", "where", "version"] as const;
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
  try {
    const prepared = await prepareWrite(host, op, table, input, options, mods, scope);
    if (plan !== undefined) return prepared;
    if (prepared.statements.length === 0) return prepared.finish([]);
    const meta = host.o !== undefined || host.q !== undefined;
    const querying = host.q !== undefined;
    if (querying && wantsQueryParams(host.q)) {
      const { rememberSecrets } = await import("./observe-query.js");
      rememberSecrets(prepared.statements, host.schema, scope, input);
    }
    const observe = statementObserve(meta, prepared);
    const results = await runWrite(host, prepared.statements, prepared.options, undefined, observe);
    const more = prepared.follow?.(results);
    if (more === undefined || more.length === 0)
      return finishQuery(host, querying, [results], () => prepared.finish(results));
    if (querying && wantsQueryParams(host.q)) {
      const { rememberSecrets } = await import("./observe-query.js");
      rememberSecrets(more, host.schema, scope, input);
    }
    const followObserve =
      meta && prepared.observe !== undefined
        ? more.map((statement) =>
            withStatementReturning(prepared.observe as WriteObserveMeta, statement.text),
          )
        : undefined;
    const extra = await runWrite(host, more, prepared.options, undefined, followObserve);
    return finishQuery(host, querying, [results, extra], () =>
      prepared.finish(results.concat(extra)),
    );
  } catch (error) {
    // B-33: postgres.js omits `table` on generic / aborted failures but keeps parameters.
    if (typeof error === "object" && error !== null) Reflect.set(error, "okmTable", table);
    throw error;
  }
}

function wantsQueryParams(handler: object | undefined): boolean {
  return (handler as { observeParams?: boolean } | undefined)?.observeParams === true;
}

async function finishQuery<T>(
  host: WriteHost,
  querying: boolean,
  groups: readonly (readonly ExecuteResult[])[],
  decode: () => T,
): Promise<T> {
  if (!querying) return decode();
  const { finishObserved } = await import("./observe-query.js");
  return finishObserved(host, groups, decode);
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
    const observeKeys = observeKeyList(host.o?.w);
    if (observeKeys !== undefined) assertObserveKeys(host.schema, observeKeys);
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
    const observe = writeObserve(op, table, options, scope, host.schema.tenancy);
    const shaped =
      observeKeys?.includes(table) === true
        ? shapeObserver(indexes(host.schema).get(table) as Indexed, planned, observe)
        : undefined;
    return {
      statements: shaped?.statements ?? planned.statements,
      options: callOptions(options),
      observe,
      ...(shaped === undefined ? {} : { observeStatements: shaped.metas }),
      ...(planned.parentGuard === true
        ? { checked: "parent" as const }
        : planned.treeGuard === true
          ? { checked: "tree" as const }
          : planned.expect !== undefined
            ? { checked: "expect" as const }
            : planned.versioned !== undefined
              ? { checked: "version" as const }
              : {}),
      input,
      ...(planned.recover === undefined
        ? {}
        : {
            follow: (results: readonly ExecuteResult[]) =>
              planned.recover?.(
                decodePlanned(withoutQuiet(results, planned.quiet), planned.outputs),
              ) ?? [],
          }),
      finish: (results) =>
        finish(
          withoutQuiet(
            shaped === undefined ? results : hideObserverRows(results, shaped.hideRows),
            planned.quiet,
          ),
          planned,
          table,
          op,
        ),
    };
  } catch (error) {
    throw scrubWrite(host.schema, table, input, error);
  }
}

/**
 * Plans a write for `sql()`, `inspect()`, or `describe()`.
 *
 * The projection stays here so the connected client does not repeat it.
 *
 * @param host - Schema, generators, scope, and observer keys
 * @param op - Insert, update, or delete
 * @param table - Table name
 * @param input - Rows, or the update or delete target
 * @param options - Returning, conflict, expect, signal, timeout
 * @param mods - `.all` and `.expect`
 * @param kind - Which view to return
 * @returns Statements, or statements plus rules, or described columns
 */
export function explainHandle(
  host: {
    readonly schema: QuerySchema;
    readonly generators?: IdGenerators | undefined;
    readonly scope?: CallScope | undefined;
    readonly o?: { readonly w: object } | undefined;
  },
  op: WriteOp,
  table: string,
  input: unknown,
  options: object,
  mods: WriteMods,
  kind: "sql" | "inspect" | "describe",
): Promise<
  | { readonly statements: readonly Statement[] }
  | {
      readonly statements: readonly Statement[];
      readonly rules: WriteExplain["rules"];
    }
  | { readonly statements: WriteExplain["described"] }
> {
  return explainWrite(
    host.schema,
    op,
    table,
    input,
    options,
    mods,
    host.generators,
    host.scope,
    observeKeyList(host.o?.w),
  ).then((plan) => {
    if (kind === "describe") return { statements: plan.described };
    if (kind !== "inspect") return { statements: plan.statements };
    return redactStatements(host.schema, table, input, plan.statements).then((statements) => ({
      statements,
      rules: plan.rules,
    }));
  });
}

/**
 * Redacts hidden and sensitive parameters on an `inspect()` plan.
 *
 * `sql()` keeps the bound values. The helper is the one a read `inspect()` uses.
 *
 * @param schema - Connected schema
 * @param table - Table the write targets
 * @param input - Caller input
 * @param statements - Planned statements
 * @returns The same statements when the table has nothing to conceal
 */
function redactStatements(
  schema: QuerySchema,
  table: string,
  input: unknown,
  statements: readonly Statement[],
): Promise<readonly Statement[]> {
  if (schema.model[table]?.conceal !== true) return Promise.resolve(statements);
  return import("./exposure.js").then(({ redactParams }) => {
    let changed = false;
    const next = statements.map((statement) => {
      if (statement.params === undefined) return statement;
      const params = redactParams(schema, input, statement.params);
      if (params === statement.params) return statement;
      changed = true;
      return { ...statement, params };
    });
    return changed ? next : statements;
  });
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
 * @param scope - Tenant scope of the client
 * @param observeKeys - Tables from `writeObserver({ keys })`
 * @returns Statements, described columns, and observer rules
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
  observeKeys?: readonly string[],
): Promise<WriteExplain> {
  try {
    if (observeKeys !== undefined) assertObserveKeys(schema, observeKeys);
    const planned = await planWrite(schema, generators, op, table, input, options, mods, scope);
    const observe = writeObserve(op, table, options, scope, schema.tenancy);
    if (observeKeys?.includes(table) === true) {
      const shaped = shapeObserver(indexes(schema).get(table) as Indexed, planned, observe);
      return {
        statements: shaped.statements,
        described: shaped.described,
        rules: shaped.rules,
      };
    }
    return {
      statements: planned.statements,
      described: callerDescription(planned),
      rules: [],
    };
  } catch (error) {
    throw scrubWrite(schema, table, input, error);
  }
}

/** What {@link explainWrite} returns. `sql()` keeps `statements` only. */
export type WriteExplain = {
  readonly statements: readonly Statement[];
  readonly described: readonly {
    readonly text: string;
    readonly columns: readonly {
      readonly name: string;
      readonly label: "caller" | "observer";
    }[];
  }[];
  readonly rules: readonly {
    readonly rule: string;
    readonly contribution: string;
    readonly provenance: string;
  }[];
};

type ObserverShape = {
  readonly statements: readonly Statement[];
  readonly metas: readonly WriteObserveMeta[];
  readonly hideRows: readonly boolean[];
  readonly described: WriteExplain["described"];
  readonly rules: WriteExplain["rules"];
};

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
    if (traitNamed(table, "versioned")) {
      const { planVersioned } = await import("./version.js");
      return withRowFilters(scope, mods.archive, () => {
        noteArchive(table, mods.archive);
        const planned = planVersioned(schema, table, input, record, mods);
        return { ...planned, keys: undefined, keyColumns: undefined };
      });
    }
    return withRowFilters(scope, mods.archive, () => {
      noteArchive(table, mods.archive);
      return planUpdate(schema, table, input, record, mods, scope);
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
  const columns = writtenColumns(table, rows, allow, tenantKeyList(tenancy));
  const returning = selectedColumns(table, options.returning);
  const outputs = outputsOf(returning);
  const clause = returningClause(returning, undefined);
  const expect = expectOf(options, mods);
  const shape = many ? "rows" : "row";
  const path = tenancy?.isPath?.(table.model.name) === true;
  if (path && options.onConflict !== undefined && options.onConflict !== "error") {
    fail(
      "OKM1120",
      `onConflict on ${table.model.name} is not available. The insert checks the parent.`,
    );
  }
  const sorting = traitNamed(table, "sortable");
  if (columns.length === 0 && !sorting) {
    const text = `insert into ${quote(table.model.sql)} default values${clause}`;
    return {
      statements: rows.map(() => ({ text })),
      outputs,
      shape,
      expect,
      keys: undefined,
      keyColumns: undefined,
    };
  }
  const conflictMod =
    options.onConflict === undefined || options.onConflict === "error"
      ? undefined
      : await import("./conflict.js");
  const conflict = conflictMod?.readConflict(
    table,
    options.onConflict,
    allow,
    tenantKeyList(tenancy),
  );
  if (conflict?.kind === "update" && traitNamed(table, "versioned")) {
    fail(
      "OKM1120",
      `onConflict update on ${table.model.name} does not check the version you read.`,
      "Read the row and update. ignore and return do not change the existing row.",
    );
  }
  const sortMod = sorting ? await import("./sort.js") : undefined;
  const chunks = chunkRows(rows.map((row) => cellsFor(columns, row)));
  const statements: Statement[] = [];
  const quiet: number[] = [];
  const keys: (string | null)[][] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const slice = rows.slice(offset, offset + chunk.length);
    offset += chunk.length;
    const head =
      path || sortMod === undefined
        ? undefined
        : sortMod.insertAtEnd(table, columns, slice, traitGroup(table), tenantKeyList(tenancy));
    const built =
      head ??
      (path
        ? pathInsert(table, columns, chunk, scope, tenancy)
        : insertHead(table, columns, chunk));
    if (head !== undefined) {
      quiet.push(statements.length);
      statements.push(head.lock);
    }
    if (conflict === undefined || conflictMod === undefined) {
      statements.push(withParams(`${built.text}${clause}`, built.params));
      continue;
    }
    if (conflict.kind === "return") {
      for (const row of slice) keys.push(keyWire(conflict.columns, row));
    }
    statements.push(
      conflictMod.finishInsert(built.text, clause, built.params ?? [], conflict, table),
    );
  }
  const conflictColumns = conflict?.kind === "return" ? conflict.columns : undefined;
  return {
    statements,
    outputs,
    shape,
    expect,
    keys: conflictColumns === undefined ? undefined : keys,
    keyColumns: conflictColumns,
    ...(path ? { parent: rows.length } : {}),
    ...(quiet.length > 0 ? { quiet } : {}),
    ...(conflictColumns === undefined || conflictMod === undefined
      ? {}
      : {
          recover: (found: readonly Record<string, unknown>[]) =>
            lookupStatements(
              conflictMod,
              table,
              conflictColumns,
              returning,
              missingKeys(found, conflictColumns, keys),
            ),
        }),
  };
}

function planUpdate(
  schema: QuerySchema,
  table: Indexed,
  input: unknown,
  options: Record<string, unknown>,
  mods: WriteMods,
  scope: CallScope | undefined,
): Planned {
  if (mentionsVersion(input)) {
    fail(
      "OKM1120",
      `version on ${table.model.name} needs versioned().`,
      "Add versioned() from okmodel/traits, or remove version.",
    );
  }
  const allow = allowSet(table, options.allow);
  noteGuarded(table, allow, "update");
  const returning = returningOption(table, options.returning);
  const outputs = outputsOf(returning);
  const expect = expectOf(options, mods);
  if (Array.isArray(input)) {
    const rows = input.map((item) => {
      const row = updateItem(table, item, allow, schema.tenancy);
      requireFilter(table, row.where, mods, "update");
      pathAssignment(schema.tenancy, table.model.name, row.set, scope);
      return { ...row, where: stack(row.where, mods.presets) };
    });
    rejectDuplicateTargets(table, rows);
    rejectMixedSets(rows);
    for (const row of rows) refuseTreeCycle(table, row.where, row.set, tenantKeys(schema.tenancy));
    const moves = rows.some(
      (row) => pathField(schema.tenancy, table.model.name, row.set) !== undefined,
    );
    if (moves) {
      return {
        statements: [pathListUpdate(schema, table, rows, scope, returning)],
        outputs: parentOutputs(returning),
        shape: returning === undefined ? "count" : "rows",
        expect,
        keys: undefined,
        keyColumns: undefined,
        parentGuard: true,
      };
    }
    return {
      statements: updateList(schema, table, rows, returning),
      outputs,
      shape: returning === undefined ? "count" : "rows",
      expect,
      keys: undefined,
      keyColumns: undefined,
    };
  }
  if (!isRecord(input)) fail("OKM1121", "update expects { where, set } or a list of rows.");
  const claim = readClaim(input);
  rejectUpdateKeys(input, false);
  const set = writeSet(table, input.set, allow, schema.tenancy);
  requireFilter(table, input.where, mods, "update");
  if (Object.keys(set).length === 0) fail("OKM1120", "update set is empty.");
  const keys = tenantKeys(schema.tenancy);
  const cycle = refuseTreeCycle(table, input.where, set, keys);
  const where = stack(input.where, mods.presets);
  const moved = pathAssignment(schema.tenancy, table.model.name, set, scope);
  if (moved !== undefined && claim !== undefined) {
    fail(
      "OKM1120",
      `lock: "skip" on ${table.model.name} cannot change ${moved} in the same claim.`,
      "Claim the row first. Point it at a parent in a later update.",
    );
  }
  if (moved !== undefined) {
    return {
      statements: [pathSetUpdate(schema, table, where, set, scope, returning)],
      outputs: parentOutputs(returning),
      shape: returning === undefined ? "count" : "rows",
      expect,
      keys: undefined,
      keyColumns: undefined,
      parentGuard: true,
    };
  }
  if (claim !== undefined) {
    return {
      statements: [emitClaim(schema, table, where, set, claim, returning)],
      outputs,
      shape: returning === undefined ? "count" : "rows",
      expect,
      keys: undefined,
      keyColumns: undefined,
    };
  }
  if (cycle !== undefined) {
    return {
      statements: [treeSetUpdate(schema, table, where, set, cycle, returning)],
      outputs: parentOutputs(returning),
      shape: returning === undefined ? "count" : "rows",
      expect,
      keys: undefined,
      keyColumns: undefined,
      treeGuard: true,
    };
  }
  const sql = new Sql();
  sql.text("update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  emitSet(sql, table, set, "t");
  emitFilter(schema, table, where, sql, "t");
  schema.tenancy?.noteParent?.(
    table.model.name,
    set,
    sql.sink(),
    scope,
    (field) => table.columns.get(field)?.sql,
  );
  sql.text(returningClause(returning, "t"));
  return {
    statements: [sql.statement()],
    outputs,
    shape: returning === undefined ? "count" : "rows",
    expect,
    keys: undefined,
    keyColumns: undefined,
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
  if (options.returning === true) {
    fail(
      "OKM1120",
      "delete does not accept returning: true.",
      "Pass the field names in returning, or omit returning for a count.",
    );
  }
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
    keyColumns: undefined,
  };
}

function finish(
  results: readonly ExecuteResult[],
  planned: Planned,
  table: string,
  op: WriteOp,
): unknown {
  if (planned.versioned !== undefined) return finishVersioned(results, planned, table);
  if (planned.parentGuard === true) return finishParent(results, planned, table);
  if (planned.treeGuard === true) return finishTree(results, planned, table);
  if (planned.shape === "count") {
    let count = 0;
    for (const result of results) count += result.count;
    checkExpect(count, planned.expect, table, "write");
    return { count };
  }
  const decoded = decodePlanned(results, planned.outputs);
  const rows =
    planned.keys === undefined || planned.keyColumns === undefined
      ? decoded
      : orderByKeys(decoded, planned.keyColumns, planned.keys);
  checkExpect(rows.length, planned.expect, table, op);
  if (planned.parent !== undefined && rows.length < planned.parent) {
    throw new OkmError("OKM1705", `Insert on ${table} did not find a parent in this tenant.`, {
      fix: { summary: "Insert under a parent that belongs to this tenant." },
    });
  }
  if (planned.shape === "row") return rows[0] ?? null;
  return rows;
}

function finishParent(results: readonly ExecuteResult[], planned: Planned, table: string): unknown {
  const row = results[0]?.rows[0];
  const matched = countCell(row?.[0]);
  const updated = countCell(row?.[1]);
  if (updated < matched) {
    throw new OkmError("OKM1705", `Update on ${table} did not find a parent in this tenant.`, {
      fix: { summary: "Point the foreign key at a parent in this tenant." },
    });
  }
  return finishGuarded(results, planned, table, updated);
}

function finishTree(results: readonly ExecuteResult[], planned: Planned, table: string): unknown {
  const row = results[0]?.rows[0];
  const matched = countCell(row?.[0]);
  const updated = countCell(row?.[1]);
  if (updated < matched) {
    fail(
      "OKM1120",
      `update on ${table} cannot point a tree row at itself or its descendant.`,
      "Set the parent to another row that is not under this one. A filter that is not the primary key is not checked.",
    );
  }
  return finishGuarded(results, planned, table, updated);
}

function finishGuarded(
  results: readonly ExecuteResult[],
  planned: Planned,
  table: string,
  updated: number,
): unknown {
  if (planned.shape === "count") {
    checkExpect(updated, planned.expect, table, "write");
    return { count: updated };
  }
  const decoded: Record<string, unknown>[] = [];
  if (updated > 0) {
    for (const result of results) {
      for (const item of result.rows) decoded.push(decodeRow(planned.outputs, item));
    }
  }
  checkExpect(decoded.length, planned.expect, table, "write");
  if (planned.shape === "row") return decoded[0] ?? null;
  return decoded;
}

function finishVersioned(
  results: readonly ExecuteResult[],
  planned: Planned,
  table: string,
): unknown {
  const versioned = planned.versioned;
  const first = results[0]?.rows[0];
  if (versioned !== undefined && first !== undefined && countCell(first[0]) > 0) {
    const fields = versioned.fields.length === 0 ? "the row" : versioned.fields.join(", ");
    const sent = versioned.sent.join(", ");
    throw new OkmError(
      "conflict",
      `update on ${table} tried to write ${fields} at version ${sent}, and the row changed. Reread the row and retry with the version you read.`,
      {
        kind: "conflict",
        columns: ["version"],
        fix: { summary: "Reread the row and retry with the version you read." },
      },
    );
  }
  if (planned.shape === "count") {
    const updated = first === undefined ? 0 : countCell(first[1]);
    checkExpect(updated, planned.expect, table, "write");
    return { count: updated };
  }
  const decoded: Record<string, unknown>[] = [];
  for (const result of results) {
    for (const item of result.rows) {
      if (countCell(item[1]) === 0) continue;
      decoded.push(decodeRow(planned.outputs, item));
    }
  }
  checkExpect(decoded.length, planned.expect, table, "write");
  if (planned.shape === "row") return decoded[0] ?? null;
  return decoded;
}

function countCell(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

function pathField(
  tenancy: QuerySchema["tenancy"],
  table: string,
  set: Readonly<Record<string, unknown>>,
): string | undefined {
  if (tenancy?.isPath?.(table) !== true) return undefined;
  const field = tenancy.pathOf?.(table)?.[0]?.localField;
  if (field === undefined || !Object.hasOwn(set, field)) return undefined;
  return field;
}

function pathAssignment(
  tenancy: QuerySchema["tenancy"],
  table: string,
  set: Readonly<Record<string, unknown>>,
  scope: CallScope | undefined,
): string | undefined {
  const field = pathField(tenancy, table, set);
  if (field === undefined) return undefined;
  const value = set[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new OkmError(
      "OKM1705",
      `Update on ${table} cannot verify ${field}. Pass the parent id as a string.`,
      { fix: { summary: "Pass the parent id as a string so the tenant can be checked." } },
    );
  }
  if (scope === undefined || "unscoped" in scope) {
    throw new OkmError("OKM1705", `Update on ${table} cannot verify ${field} without a tenant.`, {
      fix: { summary: `Call for({ ... }) so ${field} can be checked.` },
    });
  }
  return field;
}

function parentOutputs(returning: readonly ColumnModel[] | undefined): Outputs {
  const outputs = outputsOf(returning);
  if (returning === undefined) return outputs;
  return {
    fields: outputs.fields.map((field) => ({ ...field, at: field.at + 2 })),
    includes: outputs.includes,
  };
}

/**
 * Physical row identity for one alias.
 *
 * `ctid` repeats on another partition and on an inheritance child.
 * `tableoid` names the relation that holds the row.
 *
 * @param alias - Table alias in the statement
 * @returns `alias.tableoid, alias.ctid`
 */
function rowId(alias: string): string {
  return `${alias}.tableoid, ${alias}.ctid`;
}

function pathSetUpdate(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  set: Record<string, unknown>,
  scope: CallScope | undefined,
  returning: readonly ColumnModel[] | undefined,
): Statement {
  const sql = new Sql();
  sql.text("with matched as (select ");
  sql.text(rowId("t"));
  sql.text(" from ");
  sql.text(quote(table.model.sql));
  sql.text(" as t");
  emitFilter(schema, table, where, sql, "t");
  sql.text("), updated as (update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  emitSet(sql, table, set, "t");
  sql.text(" where (");
  sql.text(rowId("t"));
  sql.text(") in (select tableoid, ctid from matched)");
  schema.tenancy?.noteParent?.(
    table.model.name,
    set,
    sql.sink(),
    scope,
    (field) => table.columns.get(field)?.sql,
  );
  endParent(sql, returning);
  return sql.statement();
}

function pathListUpdate(
  schema: QuerySchema,
  table: Indexed,
  rows: readonly { readonly where: unknown; readonly set: Record<string, unknown> }[],
  scope: CallScope | undefined,
  returning: readonly ColumnModel[] | undefined,
): Statement {
  const sql = new Sql();
  sql.text("with matched as (");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (index > 0) sql.text(" union all ");
    sql.text("select t.ctid as tid, ");
    sql.text(String(index));
    sql.text(" as ord from ");
    sql.text(quote(table.model.sql));
    sql.text(" as t where ");
    emitBare(schema, table, row.where, sql, "t");
  }
  sql.text("), rejected as (");
  let rejected = false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (pathField(schema.tenancy, table.model.name, row.set) === undefined) continue;
    if (rejected) sql.text(" union all ");
    rejected = true;
    sql.text("select ");
    sql.text(String(index));
    sql.text(" as ord where exists (select 1 from matched where ord = ");
    sql.text(String(index));
    sql.text(")");
    noteParentNot(schema, table, row.set, scope, sql);
  }
  if (!rejected) sql.text("select 0 as ord where false");
  sql.text("), updated as (");
  updateSliceBody(schema, table, rows, sql, true);
  sql.text(" and not exists (select 1 from rejected)");
  endParent(sql, returning);
  return sql.statement();
}

function noteParentNot(
  schema: QuerySchema,
  table: Indexed,
  set: Readonly<Record<string, unknown>>,
  scope: CallScope | undefined,
  sql: Sql,
): void {
  let first = true;
  schema.tenancy?.noteParent?.(
    table.model.name,
    set,
    {
      text(value) {
        if (first) {
          first = false;
          sql.text(" and not ");
          return;
        }
        sql.text(value);
      },
      param(encoded) {
        sql.param(encoded, "");
      },
      mark() {},
    },
    scope,
    (field) => table.columns.get(field)?.sql,
  );
}

function endParent(sql: Sql, returning: readonly ColumnModel[] | undefined): void {
  if (returning === undefined || returning.length === 0) {
    sql.text(
      " returning 1) select (select count(*)::int from matched), (select count(*)::int from updated)",
    );
    return;
  }
  sql.text(returningClause(returning, "t"));
  sql.text(
    ") select c.matched, c.updated, u.* from (select (select count(*)::int from matched) as matched, (select count(*)::int from updated) as updated) c left join updated u on true",
  );
}

export function updateSliceBody(
  schema: QuerySchema,
  table: Indexed,
  rows: readonly { readonly where: unknown; readonly set: Record<string, unknown> }[],
  sql: Sql,
  wrapWhere = false,
  hooks?: {
    afterWhere?(sql: Sql, index: number): void;
    afterSet?(sql: Sql): void;
  },
): void {
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
  sql.text("update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  for (let field = 0; field < fields.length; field += 1) {
    const column = fields[field];
    if (column === undefined) continue;
    if (field > 0) sql.text(", ");
    sql.text(quote(column.sql));
    sql.text(" = case");
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      sql.text(" when ");
      emitBare(schema, table, row.where, sql, "t");
      hooks?.afterWhere?.(sql, index);
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
  hooks?.afterSet?.(sql);
  sql.text(wrapWhere ? " where (" : " where ");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (index > 0) sql.text(" or ");
    sql.text("(");
    emitBare(schema, table, row.where, sql, "t");
    hooks?.afterWhere?.(sql, index);
    sql.text(")");
  }
  if (wrapWhere) sql.text(")");
}

function decodePlanned(
  results: readonly ExecuteResult[],
  outputs: Outputs,
): Record<string, unknown>[] {
  const decoded: Record<string, unknown>[] = [];
  for (const result of results) {
    for (const row of result.rows) decoded.push(decodeRow(outputs, row));
  }
  return decoded;
}

/**
 * Drops statements that are not part of the write result.
 *
 * @param results - One result per statement, in order
 * @param quiet - Indexes to drop. Omitted keeps every result
 * @returns The results `finish` decodes
 */
function withoutQuiet(
  results: readonly ExecuteResult[],
  quiet: readonly number[] | undefined,
): readonly ExecuteResult[] {
  if (quiet === undefined || quiet.length === 0) return results;
  const hidden = new Set(quiet);
  const kept: ExecuteResult[] = [];
  for (let index = 0; index < results.length; index += 1) {
    if (hidden.has(index)) continue;
    const result = results[index];
    if (result !== undefined) kept.push(result);
  }
  return kept;
}

function lookupStatements(
  mod: typeof import("./conflict.js"),
  table: Indexed,
  columns: readonly ColumnModel[],
  returning: readonly ColumnModel[],
  keyRows: readonly (readonly (string | null)[])[],
): readonly Statement[] {
  if (keyRows.length === 0 || returning.length === 0) return [];
  const width = Math.max(1, columns.length);
  const size = Math.max(1, Math.floor(WRITE_PARAM_BUDGET / width));
  const statements: Statement[] = [];
  for (let index = 0; index < keyRows.length; index += size) {
    statements.push(
      mod.lookupExisting(table, columns, returning, keyRows.slice(index, index + size)),
    );
  }
  return statements;
}

function missingKeys(
  rows: readonly Record<string, unknown>[],
  columns: readonly ColumnModel[],
  keys: readonly (readonly (string | null)[])[],
): (readonly (string | null)[])[] {
  const have = new Set(rows.map((row) => rowKey(columns, row)));
  const missing: (readonly (string | null)[])[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const id = key.map((value) => value ?? "").join("\0");
    if (have.has(id) || seen.has(id)) continue;
    seen.add(id);
    missing.push(key);
  }
  return missing;
}

export function rejectDuplicateTargets(
  table: Indexed,
  rows: readonly { readonly where: unknown }[],
): void {
  if (rows.length < 2) return;
  const seen = new Set<string>();
  for (const row of rows) {
    const key = canonical(row.where);
    if (seen.has(key)) {
      fail(
        "OKM1120",
        `update on ${table.model.name} lists the same target twice.`,
        "List each row once.",
      );
    }
    seen.add(key);
  }
}

/** Distinguishes values that have no stable text. A repeat is not reported as a duplicate. */
let unresolved = 0;

function canonical(value: unknown): string {
  if (isOperator(value)) return `op:${operatorName(value)}:${canonical(operatorValue(value))}`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (isRecord(value)) {
    if (plainRecord(value)) {
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return boxed(value);
  }
  return fresh();
}

function plainRecord(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function boxed(value: object): string {
  if (value instanceof Uint8Array) return `bytes:${hexBytes(value)}`;
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) return fresh();
    return `date:${value.toISOString()}`;
  }
  const read = (value as { readonly toString: () => string }).toString;
  if (read === Object.prototype.toString) return fresh();
  const text = read.call(value);
  if (text.length > 0 && text !== "[object Object]") return `text:${text}`;
  return fresh();
}

function hexBytes(value: Uint8Array): string {
  let hex = "";
  for (const byte of value) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function fresh(): string {
  unresolved += 1;
  return `~${String(unresolved)}`;
}

function orderByKeys(
  rows: readonly Record<string, unknown>[],
  columns: readonly ColumnModel[],
  keys: readonly (readonly (string | null)[])[],
): Record<string, unknown>[] {
  const found = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = rowKey(columns, row);
    if (!found.has(id)) found.set(id, row);
  }
  const ordered: Record<string, unknown>[] = [];
  for (const key of keys) {
    const row = found.get(key.map((value) => value ?? "").join("\0"));
    if (row !== undefined) ordered.push(row);
  }
  return ordered;
}

function rowKey(columns: readonly ColumnModel[], row: Record<string, unknown>): string {
  let id = "";
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    if (column === undefined) continue;
    if (index > 0) id += "\0";
    id += valueKey(column, row[column.field]);
  }
  return id;
}

function valueKey(column: ColumnModel, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return wireKey(value);
  }
  return column.encode(value);
}

function wireKey(value: string | number | boolean | bigint): string {
  if (typeof value === "string") return value;
  return String(value);
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
  const sql = new Sql();
  updateSliceBody(schema, table, rows, sql);
  sql.text(returningClause(returning, "t"));
  return sql.statement();
}

/**
 * One update that claims up to `limit` rows and leaves rows another
 * transaction already holds.
 *
 * The write is the statement, so it does not need an outer `tx()`. Inside
 * `tx()` the claim lasts until that transaction ends. The inner read names
 * the physical row, then the update changes that row only. `ctid` repeats on
 * another partition and on an inheritance child, so the match includes
 * `tableoid`. `limit` is bound.
 */
function emitClaim(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  set: Record<string, unknown>,
  limit: number,
  returning: readonly ColumnModel[] | undefined,
): Statement {
  const sql = new Sql();
  sql.text("update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  emitSet(sql, table, set, "t");
  sql.text(" where (");
  sql.text(rowId("t"));
  sql.text(") in (select ");
  sql.text(rowId("s"));
  sql.text(" from ");
  sql.text(quote(table.model.sql));
  sql.text(" as s");
  emitFilter(schema, table, where, sql, "s");
  sql.text(" for update of s skip locked limit ");
  sql.param(String(limit), "integer");
  sql.text(")");
  sql.text(returningClause(returning, "t"));
  return sql.statement();
}

export function emitSet(
  sql: Sql,
  table: Indexed,
  set: Record<string, unknown>,
  alias: string,
): void {
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
      emitIncrement(sql, column, value, alias);
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
      `Field ${column.field} received an operator. set accepts a value, inc, json.set, arr.append, or arr.remove.`,
    );
  }
  if (value === null) {
    sql.text(`null::${column.dataType}`);
    return;
  }
  if (typeof value === "object") takeObject(column, value);
  sql.param(encodeColumn(column, value), column.dataType);
}

/** Number columns `inc` can add to. Array types are not included. */
const NUMBER_TYPE =
  /^(?:smallint|integer|bigint|real|double precision|numeric|decimal)(?:\(\d+(?:,\d+)?\))?$/;

function emitIncrement(sql: Sql, column: ColumnModel, value: unknown, alias: string): void {
  if (!NUMBER_TYPE.test(column.dataType)) {
    fail(
      "OKM1124",
      `inc adds to a number. ${column.field} is a ${column.dataType} column.`,
      "Use inc on an integer, bigint, numeric, or float column.",
    );
  }
  if (!isOperator(value)) fail("OKM1121", `inc on ${column.field} needs a number.`);
  const amount = operatorValue(value);
  if (typeof amount !== "number" && typeof amount !== "bigint" && typeof amount !== "string") {
    fail(
      "OKM1121",
      `inc on ${column.field} needs a number.`,
      "Pass the amount to add. null stores null; it is not an amount.",
    );
  }
  sql.text(`${alias}.${quote(column.sql)} + `);
  sql.param(encodeColumn(column, amount), column.dataType);
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

function traitNamed(table: Indexed, name: string): boolean {
  const traits = table.model.traits;
  if (traits === undefined) return false;
  for (const trait of traits) if (trait.name === name) return true;
  return false;
}

/**
 * Group field `sortable()` stored, when this table has that trait.
 *
 * @param table - Target table
 * @returns The field, or `undefined` when the order is one list
 */
function traitGroup(table: Indexed): string | undefined {
  const traits = table.model.traits;
  if (traits === undefined) return undefined;
  for (const trait of traits) {
    if (trait.name !== "sortable") continue;
    const group = (trait as { readonly group?: unknown }).group;
    return typeof group === "string" ? group : undefined;
  }
  return undefined;
}

function mentionsVersion(input: unknown): boolean {
  if (Array.isArray(input)) {
    for (const item of input) {
      if (isRecord(item) && Object.hasOwn(item, "version")) return true;
    }
    return false;
  }
  return isRecord(input) && Object.hasOwn(input, "version");
}

export class Sql {
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
    assertParamCount(this.params.length);
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
    if (column === undefined) refuseUnknownField(table, key);
    tenancy?.guard(table.model.name, key, "insert");
    if (!writable(table, column, allow, "insert")) refuse(table, column);
    if (value[key] !== undefined) row[key] = value[key];
  }
  refuseHalfMorph(table, row);
  return row;
}

/**
 * Refuses a write field that is not on the table (B-39).
 *
 * @param table - Table being written
 * @param key - Caller key
 */
function refuseUnknownField(table: Indexed, key: string): never {
  throwNamed(
    "OKM1120",
    key,
    table.names,
    `Field ${key} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
  );
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
  tenantKeys: readonly string[] | undefined,
): ColumnModel[] {
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) present.add(key);
  }
  const columns: ColumnModel[] = [];
  for (const column of table.model.columns) {
    if (
      present.has(column.field) &&
      (writable(table, column, allow, "insert") ||
        column.fill !== undefined ||
        tenantKeys?.includes(column.field) === true)
    ) {
      columns.push(column);
    }
  }
  return columns;
}

function tenantKeyList(tenancy: QuerySchema["tenancy"]): readonly string[] | undefined {
  if (tenancy === undefined) return undefined;
  if (tenancy.keys !== undefined && tenancy.keys.length > 0) return tenancy.keys;
  return [tenancy.key];
}

/**
 * Per-statement observe metadata when a write observer is registered.
 *
 * Key opt-in uses the list stored on the prepared write. Otherwise every
 * statement shares one meta, with `returning` set from that statement's SQL.
 *
 * @param watching - True when `onWrite` is registered
 * @param prepared - Planned write
 * @returns One meta per statement, or `undefined` when nobody is watching
 */
export function statementObserve(
  watching: boolean,
  prepared: PreparedWrite,
): readonly WriteObserveMeta[] | undefined {
  if (!watching) return undefined;
  if (prepared.observeStatements !== undefined) return prepared.observeStatements;
  if (prepared.observe === undefined) return undefined;
  const base = prepared.observe;
  return prepared.statements.map((statement) => withStatementReturning(base, statement.text));
}

/**
 * Builds observe metadata for one planned write.
 *
 *
 * @param op - Insert, update, or delete
 * @param table - Table name
 * @param options - Caller options (detects upsert via onConflict)
 * @param scope - Tenant scope
 * @param tenancy - Schema tenancy
 * @returns Metadata shared by every statement of this write
 */
function writeObserve(
  op: WriteOp,
  table: string,
  options: object,
  scope: CallScope | undefined,
  tenancy: QuerySchema["tenancy"],
): WriteObserveMeta {
  const conflict = op === "insert" && isRecord(options) ? options["onConflict"] : undefined;
  const observed: WriteObserveMeta["op"] =
    conflict !== undefined && conflict !== "error" ? "upsert" : op;
  return {
    table,
    op: observed,
    tenant: tenantFromScope(scope, tenantKeyList(tenancy)),
    settings: [],
    source: "client",
  };
}

/**
 * Marks a statement whose SQL contains `RETURNING`.
 *
 * Follow-up lookups keep the base meta (no primary-key fields) and only gain
 * the returning flag.
 *
 * @param base - Metadata shared by the write
 * @param text - Statement text
 * @returns The same meta, or a copy with `returning`
 */
function withStatementReturning(base: WriteObserveMeta, text: string): WriteObserveMeta {
  return statementHasReturning(text) ? { ...base, returning: true } : base;
}

/**
 * True when the statement text contains a `RETURNING` clause.
 *
 * @param text - Statement text
 * @returns Whether `RETURNING` ran
 */
function statementHasReturning(text: string): boolean {
  return /\breturning\b/i.test(text);
}

/**
 * Where a `RETURNING` clause sits in SQL this library emitted.
 *
 * A leading `insert`, `update`, or `delete` with no `RETURNING` can gain one.
 * A terminal `RETURNING` can gain columns. A clause whose tail contains
 * `select` (parent guard, versioned close, archive CTE) is left alone.
 *
 * @param text - Statement text
 * @returns `none`, `terminal`, or `nested`
 */
function returningKind(text: string): "none" | "terminal" | "nested" {
  if (!/^\s*(?:insert|update|delete)\b/i.test(text)) return "nested";
  const at = text.toLowerCase().lastIndexOf(" returning ");
  if (at < 0) return "none";
  const suffix = text.toLowerCase().slice(at + " returning ".length);
  if (/\bselect\b/.test(suffix)) return "nested";
  return "terminal";
}

/**
 * Adds primary-key `RETURNING` and the per-statement key metadata.
 *
 * Quiet statements (a sortable lock) are not key statements. Columns the
 * caller already returns keep their indexes. Appended columns are labeled
 * `observer`. When the caller asked for no rows, those result rows are hidden
 * so the caller still receives null or a count.
 *
 * @param table - Planned table
 * @param planned - Planned statements and caller outputs
 * @param base - Observe metadata for this write
 * @returns Shaped statements, metas, and the description
 */
function shapeObserver(table: Indexed, planned: Planned, base: WriteObserveMeta): ObserverShape {
  const primary = primaryColumns(table);
  const user = planned.outputs.fields;
  const userAt = new Map(user.map((field) => [field.key, field]));
  const missing = primary.filter((column) => !userAt.has(column.field));
  const quiet = new Set(planned.quiet ?? []);
  const nextAt = user.reduce((max, field) => Math.max(max, field.at + 1), 0);
  const callerColumns = user.map((field) => ({ name: field.key, label: "caller" as const }));
  let added = false;
  const statements: Statement[] = [];
  const metas: WriteObserveMeta[] = [];
  const hideRows: boolean[] = [];
  const described: WriteExplain["described"][number][] = [];
  for (let index = 0; index < planned.statements.length; index += 1) {
    const statement = planned.statements[index];
    if (statement === undefined) continue;
    if (quiet.has(index)) {
      statements.push(statement);
      hideRows.push(false);
      metas.push(withStatementReturning(base, statement.text));
      described.push({ text: statement.text, columns: [] });
      continue;
    }
    const kind = returningKind(statement.text);
    const canAppend = kind !== "nested" && missing.length > 0;
    const text = canAppend
      ? appendReturning(
          statement.text,
          kind,
          missing.map((column) =>
            keyExpr(column, /^\s*insert\b/i.test(statement.text) ? undefined : "t"),
          ),
        )
      : statement.text;
    if (canAppend) added = true;
    const next = text === statement.text ? statement : { ...statement, text };
    statements.push(next);
    const observerColumns = canAppend
      ? missing.map((column) => ({ name: column.field, label: "observer" as const }))
      : [];
    described.push({ text, columns: [...callerColumns, ...observerColumns] });
    const returning = statementHasReturning(text);
    if (missing.length > 0 && !canAppend) {
      hideRows.push(false);
      metas.push(returning ? { ...base, returning: true } : base);
      continue;
    }
    const keyFields = primary.map((column) => {
      const existing = userAt.get(column.field);
      if (existing !== undefined) {
        return { field: column.field, at: existing.at, decode: existing.decode };
      }
      const offset = missing.findIndex((item) => item.field === column.field);
      return { field: column.field, at: nextAt + offset, decode: column.decode };
    });
    hideRows.push(canAppend && user.length === 0);
    metas.push({ ...base, returning, keyFields });
  }
  return {
    statements,
    metas,
    hideRows,
    described,
    rules: added
      ? [{ rule: "returning", contribution: "primary key", provenance: "observer" }]
      : [],
  };
}

/**
 * Caller columns for a write that did not opt into keys.
 *
 * @param planned - Planned write
 * @returns One description per statement
 */
function callerDescription(planned: Planned): WriteExplain["described"] {
  const columns = planned.outputs.fields.map((field) => ({
    name: field.key,
    label: "caller" as const,
  }));
  return planned.statements.map((statement) => ({ text: statement.text, columns }));
}

/**
 * Drops rows that exist only because the observer added `RETURNING`.
 *
 * @param results - Driver results
 * @param mask - True where the caller asked for no rows
 * @returns Results whose row lists the caller is allowed to see
 */
function hideObserverRows(
  results: readonly ExecuteResult[],
  mask: readonly boolean[],
): readonly ExecuteResult[] {
  if (!mask.some(Boolean)) return results;
  return results.map((result, index) => (mask[index] === true ? { ...result, rows: [] } : result));
}

/**
 * Primary-key columns in catalog order.
 *
 * @param table - Planned table
 * @returns Columns named by `model.primary`
 */
function primaryColumns(table: Indexed): readonly ColumnModel[] {
  const columns: ColumnModel[] = [];
  for (const field of table.model.primary) {
    const column = table.columns.get(field);
    if (column === undefined) {
      throw new OkmError(
        "OKM1890",
        `writeObserver keys cannot include ${table.model.name}: primary key ${field} is not a column.`,
        {
          kind: "invalid",
          table: table.model.name,
          fix: {
            summary: `Add a primary key on ${table.model.name}, or remove it from writeObserver({ keys }).`,
          },
        },
      );
    }
    columns.push(column);
  }
  return columns;
}

/**
 * Appends primary-key expressions to a simple write.
 *
 * @param text - Statement text
 * @param kind - `none` starts the clause. `terminal` extends it
 * @param exprs - Projected primary-key expressions
 * @returns Statement text including the observer columns
 */
function appendReturning(
  text: string,
  kind: "none" | "terminal",
  exprs: readonly string[],
): string {
  const list = exprs.join(", ");
  if (kind === "none") return `${text} returning ${list}`;
  return `${text}, ${list}`;
}

/**
 * SQL for one primary-key column in `RETURNING`.
 *
 * @param column - Primary-key column
 * @param alias - Update and delete use `t`. Insert has none
 * @returns The projected expression
 */
function keyExpr(column: ColumnModel, alias: string | undefined): string {
  const sql = alias === undefined ? quote(column.sql) : `${alias}.${quote(column.sql)}`;
  return projectExpr(sql, column.dataType);
}

/**
 * Scope keys and values for a write event. Unscoped and root clients are null.
 *
 * @param scope - Call scope
 * @param keys - Tenant field names
 * @returns Tenant record or null
 */
export function tenantFromScope(
  scope: CallScope | undefined,
  keys: readonly string[] | undefined,
): Readonly<Record<string, unknown>> | null {
  if (scope === undefined || "unscoped" in scope) return null;
  if (scope.values !== undefined) return scope.values;
  const key = keys?.[0];
  if (key !== undefined) return { [key]: scope.value };
  return { value: scope.value };
}

function pathInsert(
  table: Indexed,
  columns: readonly ColumnModel[],
  rows: readonly Cell[][],
  scope: CallScope | undefined,
  tenancy: QuerySchema["tenancy"],
): Statement {
  const sql = new Sql();
  const names = columns.map((column) => quote(column.sql)).join(", ");
  const selected = columns.map((column) => `v.${quote(column.sql)}`).join(", ");
  sql.text(`insert into ${quote(table.model.sql)} (${names}) select ${selected} from (values `);
  for (let row = 0; row < rows.length; row += 1) {
    const cells = rows[row];
    if (cells === undefined) continue;
    if (row > 0) sql.text(", ");
    sql.text("(");
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      if (index > 0) sql.text(", ");
      if (cell === undefined || cell.kind === "default") {
        sql.text("default");
        continue;
      }
      sql.param(cell.kind === "null" ? null : cell.wire, cell.dataType);
    }
    sql.text(")");
  }
  sql.text(`) as v(${names})`);
  tenancy?.lockPredicate?.({
    table: table.model.name,
    fieldSql: (field) => table.columns.get(field)?.sql,
    encode: table.columns.get(tenancy.key)?.encode,
    alias: "v",
    appended: false,
    scope,
    sink: sql.sink(),
  });
  return sql.statement();
}

export function writeSet(
  table: Indexed,
  value: unknown,
  allow: ReadonlySet<string>,
  tenancy: QuerySchema["tenancy"],
): Record<string, unknown> {
  if (!isRecord(value)) fail("OKM1121", "set must be an object of fields.");
  const group = traitGroup(table);
  if (group !== undefined && Object.hasOwn(value, group) && value[group] !== undefined) {
    fail(
      "OKM1120",
      `update on ${table.model.name} cannot change ${group}. It groups position.`,
      "Move stays in one group.",
    );
  }
  const set: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const column = table.columns.get(key);
    if (column === undefined) refuseUnknownField(table, key);
    if (value[key] === undefined) continue;
    tenancy?.guard(table.model.name, key, "update");
    if (column.guardUpdate || !writable(table, column, allow, "update")) refuse(table, column);
    set[key] = value[key];
  }
  refuseHalfMorph(table, set);
  return set;
}

/** A tree parent move that needs a descendant check at execute time. */
type TreeCycleCheck = {
  readonly own: string;
  readonly parent: string;
  readonly column: ColumnModel;
  readonly identity: ColumnModel;
};

/**
 * Refuses a tree parent that points at the row being updated, and returns a
 * check for a multi-hop cycle when the new parent is another row.
 *
 * The check runs only when `where` is that row's primary key. A filter that
 * is not the key can match many rows, so it is not checked.
 *
 * @param table - The table being updated
 * @param where - The caller's filter, before presets
 * @param set - Fields the update writes
 * @param scopeKeys - Tenancy columns the scope fills
 * @returns A descendant check when the parent is another id, else `undefined`
 */
function refuseTreeCycle(
  table: Indexed,
  where: unknown,
  set: Record<string, unknown>,
  scopeKeys: readonly string[],
): TreeCycleCheck | undefined {
  const keyed = keyedId(table, where, scopeKeys);
  if (keyed === undefined) return undefined;
  let found: TreeCycleCheck | undefined;
  for (const relation of table.model.relations) {
    if (
      relation.kind !== "many" ||
      relation.through !== undefined ||
      relation.morph !== undefined
    ) {
      continue;
    }
    if (relation.table !== table.model.name) continue;
    for (const sql of relation.remote) {
      const column = columnBySql(table, sql);
      if (column === undefined) continue;
      const value = set[column.field];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
        continue;
      }
      const parent = typeof value === "string" ? value : value.toString();
      if (parent === keyed.own) {
        fail(
          "OKM1120",
          `update on ${table.model.name}.${column.field} cannot point a tree row at itself.`,
          "Set the parent to another row. A filter that is not the primary key is not checked.",
        );
      }
      found = { own: keyed.own, parent, column, identity: keyed.identity };
    }
  }
  return found;
}

/**
 * The primary-key value when `where` names that key and nothing else.
 *
 * A tenancy column in the key may be absent: the scope fills it.
 *
 * @param table - The table being updated
 * @param where - The caller's filter
 * @param scopeKeys - Tenancy columns the scope fills, when they are part of the key
 * @returns The key text and identity column, or `undefined` when the filter is not that key
 */
function keyedId(
  table: Indexed,
  where: unknown,
  scopeKeys: readonly string[],
): { readonly own: string; readonly identity: ColumnModel } | undefined {
  if (!isRecord(where)) return undefined;
  const primary = table.model.primary;
  const required = primary.filter((field) => !scopeKeys.includes(field));
  const field = required.length === 1 ? required[0] : undefined;
  if (field === undefined || !Object.hasOwn(where, field)) return undefined;
  for (const key of Object.keys(where)) {
    if (!primary.includes(key)) return undefined;
  }
  const value = where[field];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return undefined;
  }
  const identity = table.columns.get(field);
  if (identity === undefined) return undefined;
  return { own: String(value), identity };
}

function tenantKeys(tenancy: QuerySchema["tenancy"]): readonly string[] {
  if (tenancy === undefined) return [];
  if (tenancy.keys !== undefined && tenancy.keys.length > 0) return tenancy.keys;
  return [tenancy.key];
}

/**
 * Updates a tree parent and refuses when the new parent is a descendant.
 *
 * Matched and updated counts come back like a path parent check. A shortfall
 * is OKM1120 (cycle), not a missing parent.
 *
 * @param schema - Query schema
 * @param table - Table being updated
 * @param where - Filter already stacked with presets
 * @param set - Fields to write
 * @param cycle - Own id, new parent, and columns
 * @param returning - Optional returning columns
 * @returns The guarded update statement
 */
function treeSetUpdate(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  set: Record<string, unknown>,
  cycle: TreeCycleCheck,
  returning: readonly ColumnModel[] | undefined,
): Statement {
  const sql = new Sql();
  sql.text("with matched as (select ");
  sql.text(rowId("t"));
  sql.text(" from ");
  sql.text(quote(table.model.sql));
  sql.text(" as t");
  emitFilter(schema, table, where, sql, "t");
  sql.text("), updated as (update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  emitSet(sql, table, set, "t");
  sql.text(" where (");
  sql.text(rowId("t"));
  sql.text(
    ") in (select tableoid, ctid from matched) and not exists (with recursive d as (select ",
  );
  sql.text(quote(cycle.identity.sql));
  sql.text(" as k from ");
  sql.text(quote(table.model.sql));
  sql.text(" where ");
  sql.text(quote(cycle.column.sql));
  sql.text(" = ");
  sql.param(cycle.own, cycle.identity.dataType);
  sql.text(" union all select c.");
  sql.text(quote(cycle.identity.sql));
  sql.text(" from ");
  sql.text(quote(table.model.sql));
  sql.text(" c join d on c.");
  sql.text(quote(cycle.column.sql));
  sql.text(" = d.k) select 1 from d where d.k = ");
  sql.param(cycle.parent, cycle.identity.dataType);
  sql.text(")");
  endParent(sql, returning);
  return sql.statement();
}

/**
 * The column whose SQL name is `sql`.
 *
 * @param table - The table
 * @param sql - Quoted-free SQL name
 * @returns The column, or `undefined`
 */
function columnBySql(table: Indexed, sql: string): ColumnModel | undefined {
  for (const column of table.model.columns) {
    if (column.sql === sql) return column;
  }
  return undefined;
}

function updateItem(
  table: Indexed,
  value: unknown,
  allow: ReadonlySet<string>,
  tenancy: QuerySchema["tenancy"],
): { readonly where: unknown; readonly set: Record<string, unknown> } {
  if (!isRecord(value)) fail("OKM1121", "update expects { where, set } or a list of rows.");
  rejectUpdateKeys(value, true);
  const set = writeSet(table, value.set, allow, tenancy);
  if (Object.keys(set).length === 0) fail("OKM1120", "update set is empty.");
  if (value.where !== undefined) return { where: value.where, set };
  if (value.id !== undefined) return { where: { id: value.id }, set };
  fail("OKM1102", `update on ${table.model.name} needs id or where for each row.`);
}

/**
 * A list that sets one field with an operator in one row and a plain value,
 * or a different operator, in another.
 */
export function rejectMixedSets(rows: readonly { readonly set: Record<string, unknown> }[]): void {
  const kind = new Map<string, string>();
  for (const row of rows) {
    for (const key of Object.keys(row.set)) {
      const value = row.set[key];
      if (value === undefined) continue;
      const next = isOperator(value) ? operatorName(value) : "value";
      const previous = kind.get(key);
      if (previous === undefined) {
        kind.set(key, next);
        continue;
      }
      if (previous === next) continue;
      const left = previous === "value" ? "a value" : previous;
      const right = next === "value" ? "a value" : next;
      fail(
        "OKM1120",
        `${key} is both ${left} and ${right} in this update.`,
        `Use one value or one operator for ${key} in every row.`,
      );
    }
  }
}

/**
 * `lock: "skip"` with `limit` on one update. Absent when the caller named neither.
 *
 * @param input - The update target
 * @returns The row cap, or `undefined` when this update does not claim
 */
export function readClaim(input: Record<string, unknown>): number | undefined {
  if (Object.hasOwn(input, "wait")) {
    fail(
      "OKM1120",
      'wait belongs on a read. An update claims rows with lock: "skip".',
      'Use lock: "skip" and limit. A read uses wait: "nowait" or "skip" inside tx().',
    );
  }
  const lock = input.lock;
  const limit = input.limit;
  if (lock === undefined && limit === undefined) return undefined;
  if (lock === undefined) {
    fail(
      "OKM1120",
      'limit on an update needs lock: "skip".',
      'Pass lock: "skip" to claim up to limit rows, or remove limit.',
    );
  }
  if (lock !== "skip") {
    const shown = typeof lock === "string" ? lock : (JSON.stringify(lock) ?? "undefined");
    fail(
      "OKM1120",
      `lock on an update must be "skip". ${shown} is not a claim.`,
      'Pass lock: "skip". A read uses lock: "update" or "share", and wait: "nowait" or "skip", inside tx().',
    );
  }
  if (limit === undefined) {
    fail(
      "OKM1120",
      'lock: "skip" needs a limit.',
      "Pass limit so the claim takes a fixed number of rows.",
    );
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 2_147_483_647) {
    fail("OKM1121", "limit must be a whole number from 1 to 2147483647.");
  }
  return limit;
}

export function rejectUpdateKeys(input: Record<string, unknown>, row: boolean): void {
  const accepted = row ? UPDATE_ROW_KEYS : UPDATE_KEYS;
  for (const key of Object.keys(input)) {
    if ((accepted as readonly string[]).includes(key)) continue;
    throwNamed(
      "OKM1120",
      key,
      [...accepted, ...FILTER_OPTIONS],
      `Option ${key} is not accepted by update. Accepted options: ${accepted.join(", ")}. timeout and signal go in the second argument.`,
    );
  }
}

export function requireFilter(table: Indexed, where: unknown, mods: WriteMods, op: WriteOp): void {
  if (mods.all !== undefined) {
    if (mods.all.trim().length === 0) {
      fail("OKM1102", `${op} on ${table.model.name} needs a where. .all needs a reason.`);
    }
    return;
  }
  if (!effectivePredicate(where)) {
    fail("OKM1102", `${op} on ${table.model.name} needs a where. Pass a filter.`);
  }
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
  assertParamCount(params.length);
  return { text, params };
}

function keyWire(columns: readonly ColumnModel[], row: Record<string, unknown>): (string | null)[] {
  return columns.map((column) => {
    const value = row[column.field];
    if (value === undefined || value === null) return null;
    return encodeColumn(column, value);
  });
}

export function returningOption(
  table: Indexed,
  value: unknown,
): readonly ColumnModel[] | undefined {
  if (value === undefined) return undefined;
  if (value === true) return selectedColumns(table, undefined);
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

export function expectOf(options: Record<string, unknown>, mods: WriteMods): number | undefined {
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

/**
 * A morph pair is set together or not at all.
 *
 * One of the two columns, or one null and the other set, is OKM1121.
 * A type value outside the closed list is OKM1120.
 */
function refuseHalfMorph(table: Indexed, row: Record<string, unknown>): void {
  const relations = table.model.relations;
  for (let index = 0; index < relations.length; index += 1) {
    const relation = relations[index];
    const morph = relation?.morph;
    if (relation === undefined || morph === undefined || morph.direction !== "to") continue;
    const typeSet = Object.hasOwn(row, morph.typeField);
    const idSet = Object.hasOwn(row, morph.idField);
    const type = typeSet ? row[morph.typeField] : undefined;
    const id = idSet ? row[morph.idField] : undefined;
    const typeClear = type === null;
    const idClear = id === null;
    if (!typeSet && !idSet) continue;
    if (typeSet !== idSet || typeClear !== idClear) {
      fail(
        "OKM1121",
        `Set ${table.model.name}.${morph.typeField} and ${morph.idField} together, or clear both. Use morphTo("${morph.name}", type, id).`,
      );
    }
    if (typeClear) continue;
    let accepted = false;
    const names: string[] = [];
    for (const target of morph.targets) {
      names.push(target.type);
      if (target.type === type) accepted = true;
    }
    if (!accepted) {
      fail(
        "OKM1120",
        `Relation ${table.model.name}.${relation.name} type ${morph.typeField} is ${typeof type === "string" ? type : typeof type}. Accepted tables: ${names.join(", ")}.`,
      );
    }
  }
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

/**
 * Whether this write may set the column.
 *
 * A writable column is open. A guarded column opens when `allow` names it,
 * except a primary key: that opens on insert only, and only when a client
 * generator fills it. A database default has no fill, so `allow` leaves it
 * closed. Update never changes the key.
 *
 * @param table - Table being written
 * @param column - Column the input names
 * @param allow - Guarded fields this call may set
 * @param op - Insert may supply a client id. Update may not
 * @returns Whether the value is written
 */
function writable(
  table: Indexed,
  column: ColumnModel,
  allow: ReadonlySet<string>,
  op: "insert" | "update",
): boolean {
  if (fieldSealed(table.model, column.field)) return false;
  if (column.writable) return true;
  if (!column.guarded || !allow.has(column.field)) return false;
  if (!table.model.primary.includes(column.field)) return true;
  return op === "insert" && column.fill !== undefined;
}

export function allowSet(table: Indexed, value: unknown): ReadonlySet<string> {
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

export function noteGuarded(
  table: Indexed,
  allow: ReadonlySet<string>,
  op: "insert" | "update",
): void {
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
