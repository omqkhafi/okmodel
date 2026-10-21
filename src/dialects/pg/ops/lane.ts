/**
 * Typed raw SQL and `explain()` (P103, P104, D268).
 *
 * Exported from `okmodel/pg`. An app that does not import them drops this
 * module. The table handle carries the session under `Symbol.for("okm.lane")`.
 * The statement class is explicit. Parameters come from the fragment. The
 * tenant predicate, when it applies, is written outside the fragment.
 */

import type { DriverPool } from "../../../contracts/driver.js";
import { OkmError, throwNamed } from "../../../contracts/error.js";
import type { ColumnModel, QuerySchema, TableModel } from "../model.js";
import { quoteIdent } from "../ddl.js";
import { isFragmentParts, type FragmentPart } from "./fragment.js";
import { isOperator, operatorName, operatorValue } from "../operators.js";
import type { TenantCall, TenancyText } from "../tenancy.js";

/**
 * What `explain()` returns.
 *
 * `plan` is null in production, and `params` is empty there.
 */
export type ExplainResult = {
  /** The statement `explain` describes. */
  readonly text: string;
  /** Bound parameters. Empty in production. */
  readonly params: readonly (string | null)[];
  /** `EXPLAIN` lines, or null when the statement was not sent. */
  readonly plan: readonly string[] | null;
};

type PlannedText = {
  readonly text: string;
  readonly params: readonly (string | null)[];
};

type LaneSession = {
  readonly schema: QuerySchema;
  readonly scope?: TenantCall;
  readonly connected: Promise<void>;
  readonly pool: Pick<DriverPool, "execute">;
  readonly logger?: {
    error?(event: { readonly code: string; readonly summary: string }): void;
  };
};

type Mapped = {
  readonly code: string;
  readonly summary: string;
};

type Lane = {
  readonly session: LaneSession;
  readonly table: string;
  fail(session: LaneSession, error: unknown): Promise<Mapped>;
};

const LANE = Symbol.for("okm.lane");
const READ = "read";
const WRITE = "write";
const BLOCKED = new Set(["__proto__", "constructor", "toString", "hasOwnProperty"]);

/**
 * Runs one typed raw statement on a table handle.
 *
 * `cls` is constructed once per row. Own enumerable keys of that instance, in
 * order, are the result columns. A key that is a field of the table uses that
 * field's decode. Any other key uses the initializer: a number, a boolean, or
 * driver text. `null` stays `null`.
 *
 * @typeParam C - Result class. Each row is an instance
 * @param handle - Table handle (`db.notes`, including one from `for()`)
 * @param cls - Class with an initializer on every result column
 * @param statement - `"read"` or `"write"`
 * @param source - A `fragment` template. Identifiers are `ident(name)`
 * @returns One instance per row
 */
export async function raw<C extends new () => object>(
  handle: object,
  cls: C,
  statement: "read" | "write",
  source: unknown,
): Promise<InstanceType<C>[]> {
  const lane = readLane(handle);
  const kind = readClass(statement);
  const indexed = openTable(lane);
  const parts = readParts(source);
  const compiled = compile(indexed, parts);
  const word = verb(compiled.text);
  if (kind === READ && word !== "select") {
    bad(
      "A raw read starts with select.",
      'Pass "read" and a single select. A leading with is a write.',
    );
  }
  if (kind === WRITE && word !== "insert" && word !== "update" && word !== "delete") {
    bad(
      "A raw write starts with insert, update, or delete.",
      'Pass "write" and one insert, update, or delete.',
    );
  }
  const tenancy = predicateOf(lane.session, indexed);
  if (kind === WRITE && tenancy !== undefined) {
    unverifiable(
      "A raw write on a tenant table cannot keep the tenant predicate.",
      "Use update or delete, or select the primary key with ident(name).",
    );
  }
  const guard = kind === READ ? guardOf(indexed, tenancy, compiled.params.length) : undefined;
  if (guard !== undefined) requireKey(indexed, lane.session.schema.tenancy?.key, parts);
  const text =
    guard === undefined
      ? compiled.text
      : wrap(indexed, lane.session.schema.tenancy?.key, compiled.text, guard.text);
  const params = guard === undefined ? compiled.params : [...compiled.params, ...guard.params];
  await lane.session.connected;
  try {
    const result = await lane.session.pool.execute(
      text,
      params,
      kind === WRITE ? { route: "primary" } : undefined,
    );
    return decodeRows(cls, result.rows, indexed) as InstanceType<C>[];
  } catch (error) {
    return raise(lane, error);
  }
}

/**
 * Describes a query.
 *
 * Outside production this sends `EXPLAIN` and returns the lines. In production
 * (`NODE_ENV` is `"production"`) it does not send the statement. `plan` is
 * null and `params` is empty.
 *
 * @param handle - Table handle that owns the query's session
 * @param query - A query from that table. `sql()` is the statement
 * @returns The statement and, outside production, the plan lines
 */
export async function explain(handle: object, query: object): Promise<ExplainResult> {
  const lane = readLane(handle);
  const got = readPlanned(await readSql(query));
  if (production()) return { text: got.text, params: [], plan: null };
  await lane.session.connected;
  let rows: readonly (readonly (string | null)[])[];
  try {
    const result = await lane.session.pool.execute(`explain ${got.text}`, got.params);
    rows = result.rows;
  } catch (error) {
    return raise(lane, error);
  }
  const plan: string[] = [];
  for (const row of rows) {
    const line = row[0];
    if (typeof line === "string") plan.push(line);
  }
  return { text: got.text, params: got.params, plan };
}

async function raise(lane: Lane, error: unknown): Promise<never> {
  // B-33: stamp the handle's table when the driver omitted it on the error.
  if (typeof error === "object" && error !== null) Reflect.set(error, "okmTable", lane.table);
  const mapped = await lane.fail(lane.session, error);
  lane.session.logger?.error?.({ code: mapped.code, summary: mapped.summary });
  throw mapped;
}

function production(): boolean {
  const proc: unknown = Reflect.get(globalThis, "process");
  if (typeof proc !== "object" || proc === null) return false;
  const env: unknown = Reflect.get(proc, "env");
  if (typeof env !== "object" || env === null) return false;
  return Reflect.get(env, "NODE_ENV") === "production";
}

function readLane(handle: object): Lane {
  const value: unknown = Reflect.get(handle, LANE);
  if (!Array.isArray(value)) {
    bad(
      "Pass the table handle.",
      "raw and explain take the table, such as db.notes, including a table from for().",
    );
  }
  const session: unknown = value[0];
  const table: unknown = value[1];
  const fail: unknown = value[2];
  if (typeof table !== "string" || typeof fail !== "function" || !isSession(session)) {
    bad(
      "Pass the table handle.",
      "raw and explain take the table, such as db.notes, including a table from for().",
    );
  }
  return { session, table, fail: fail as Lane["fail"] };
}

function isSession(value: unknown): value is LaneSession {
  if (typeof value !== "object" || value === null) return false;
  const schema: unknown = Reflect.get(value, "schema");
  const connected: unknown = Reflect.get(value, "connected");
  const pool: unknown = Reflect.get(value, "pool");
  if (typeof schema !== "object" || schema === null) return false;
  if (typeof Reflect.get(schema, "model") !== "object") return false;
  if (
    typeof connected !== "object" ||
    connected === null ||
    typeof Reflect.get(connected, "then") !== "function"
  ) {
    return false;
  }
  return (
    typeof pool === "object" && pool !== null && typeof Reflect.get(pool, "execute") === "function"
  );
}

function readSql(query: object): unknown {
  const sql = Reflect.get(query, "sql");
  if (typeof sql !== "function") {
    bad(
      "Pass a query.",
      "explain takes the table and a query from that table, such as notes.find({ limit: 1 }).",
    );
  }
  return (sql as (this: object) => unknown).call(query);
}

function readPlanned(value: unknown): PlannedText {
  if (typeof value !== "object" || value === null) {
    bad("The statement has no text.", "Call explain on a query.");
  }
  const text = Reflect.get(value, "text");
  const params = Reflect.get(value, "params");
  if (typeof text !== "string" || !Array.isArray(params)) {
    bad("The statement has no text.", "Call explain on a query.");
  }
  const bound: (string | null)[] = [];
  for (const param of params) {
    if (typeof param !== "string" && param !== null) {
      bad("A statement parameter was not text.", "Parameters are bound text.");
    }
    bound.push(param);
  }
  return { text, params: bound };
}

type OpenTable = {
  readonly model: TableModel;
  readonly columns: ReadonlyMap<string, ColumnModel>;
  readonly names: readonly string[];
};

function openTable(lane: Lane): OpenTable {
  const model = lane.session.schema.model[lane.table];
  if (model === undefined) {
    bad(`Table ${lane.table} is not in the schema.`, "Call raw on a table this schema declares.");
  }
  const columns = new Map<string, ColumnModel>();
  const names: string[] = [];
  for (const column of model.columns) {
    columns.set(column.field, column);
    names.push(column.field);
  }
  names.sort();
  return { model, columns, names };
}

function compile(
  table: OpenTable,
  parts: readonly FragmentPart[],
): { readonly text: string; readonly params: readonly string[] } {
  const params: string[] = [];
  const chunks: string[] = [];
  let count = 0;
  const sink: TenancyText = {
    text(value) {
      chunks.push(value);
    },
    param(encoded) {
      params.push(encoded);
      count += 1;
      chunks.push(`$${String(count)}`);
    },
    mark() {},
  };
  for (const part of parts) writePart(part, sink, table);
  return { text: chunks.join(""), params };
}

function writePart(part: FragmentPart, sink: TenancyText, table: OpenTable): void {
  if (part.k === "t") {
    sink.text(part.s);
    return;
  }
  if (part.k === "p") {
    sink.param(part.v);
    return;
  }
  if (part.k === "n") {
    sink.text("null");
    return;
  }
  if (part.k === "i") {
    writeIdent(part.n, sink, table);
    return;
  }
  if (part.k === "c") {
    throw new OkmError("OKM1125", "fragment.column belongs on a where field.", {
      fix: { summary: "Use ident(name) in a raw statement." },
    });
  }
  sink.text("(");
  for (const nested of part.parts) writePart(nested, sink, table);
  sink.text(")");
}

function writeIdent(name: string, sink: TenancyText, table: OpenTable): void {
  const column = table.columns.get(name);
  if (column === undefined) {
    throwNamed(
      "OKM1120",
      name,
      table.names,
      `Field ${name} is not on ${table.model.name}. Accepted names: ${table.names.join(", ")}.`,
    );
  }
  if (column.hidden) {
    throw new OkmError("OKM1120", `Field ${column.field} is hidden.`, {
      fix: { summary: "A raw statement cannot name a hidden field." },
    });
  }
  sink.text(quoteIdent(column.sql));
}

function readClass(statement: unknown): typeof READ | typeof WRITE {
  if (statement === READ || statement === WRITE) return statement;
  bad('The statement class is "read" or "write".', 'Pass "read" or "write".');
}

function readParts(source: unknown): readonly FragmentPart[] {
  if (typeof source !== "object" || source === null) {
    bad(
      "Pass fragment`...`.",
      "Identifiers are ident(name). A string, number, boolean, or null is a parameter.",
    );
  }
  if (typeof Reflect.get(source, "as") === "string") {
    bad("Pass the fragment, not .as(name).", "The class names the row. Drop .as().");
  }
  if (!isOperator(source) || operatorName(source) !== "sql") {
    bad(
      "Pass fragment`...`.",
      "Identifiers are ident(name). A string, number, boolean, or null is a parameter.",
    );
  }
  const stored = operatorValue(source);
  if (!isFragmentParts(stored)) {
    bad("Pass fragment`...`.", "Call fragment`...`. Do not build the parts yourself.");
  }
  return stored;
}

function verb(text: string): string {
  return /^[a-z]+/i.exec(text.trimStart())?.[0]?.toLowerCase() ?? "";
}

function predicateOf(
  session: LaneSession,
  table: OpenTable,
): { readonly text: string; readonly params: readonly string[] } | undefined {
  const tenancy = session.schema.tenancy;
  if (tenancy === undefined) return undefined;
  const chunks: string[] = [];
  const params: string[] = [];
  let count = 0;
  const wrote = tenancy.predicate({
    table: table.model.name,
    fieldSql: (field) => table.columns.get(field)?.sql,
    encode: table.columns.get(tenancy.key)?.encode,
    alias: "okm_tenant",
    appended: false,
    scope: session.scope,
    sink: {
      text(value) {
        chunks.push(value);
      },
      param(encoded) {
        params.push(encoded);
        count += 1;
        chunks.push(`$${String(count)}`);
      },
      mark() {},
    },
  });
  if (!wrote) return undefined;
  return { text: chunks.join("").replace(/^\s*where\s+/i, ""), params };
}

function guardOf(
  table: OpenTable,
  tenancy: { readonly text: string; readonly params: readonly string[] } | undefined,
  userCount: number,
): { readonly text: string; readonly params: readonly string[] } | undefined {
  const archive = table.model.archive?.at;
  if (tenancy === undefined && archive === undefined) return undefined;
  const parts: string[] = [];
  if (tenancy !== undefined) parts.push(shift(tenancy.text, userCount));
  if (archive !== undefined) parts.push(`okm_tenant.${quoteIdent(archive)} is null`);
  return { text: parts.join(" and "), params: tenancy?.params ?? [] };
}

function requireKey(
  table: OpenTable,
  tenantKey: string | undefined,
  parts: readonly FragmentPart[],
): void {
  const key = rowKey(table, tenantKey);
  if (key === undefined) {
    unverifiable(
      "A raw read needs one primary key column besides the tenant key.",
      "Declare one primary key. The tenant predicate binds that column.",
    );
  }
  if (!namesIdent(parts, key)) {
    unverifiable(
      `A raw read must select ${key} with ident.`,
      `Put ident("${key}") in the select list. Do not alias it. The tenant predicate is added outside the statement.`,
    );
  }
}

function rowKey(table: OpenTable, tenantKey: string | undefined): string | undefined {
  const keys = table.model.primary.filter((field) => field !== tenantKey);
  return keys.length === 1 ? keys[0] : undefined;
}

function namesIdent(parts: readonly FragmentPart[], name: string): boolean {
  for (const part of parts) {
    if (part.k === "i" && part.n === name) return true;
    if (part.k === "f" && namesIdent(part.parts, name)) return true;
  }
  return false;
}

function wrap(
  table: OpenTable,
  tenantKey: string | undefined,
  text: string,
  where: string,
): string {
  const key = rowKey(table, tenantKey);
  const column = key === undefined ? undefined : table.columns.get(key);
  if (column === undefined) {
    unverifiable(
      "A raw read needs one primary key column besides the tenant key.",
      "Declare one primary key. The tenant predicate binds that column.",
    );
  }
  const quoted = quoteIdent(column.sql);
  return `select okm_raw.* from (${text}) as okm_raw where okm_raw.${quoted} in (select ${quoted} from ${quoteIdent(table.model.sql)} as okm_tenant where ${where})`;
}

function shift(text: string, by: number): string {
  if (by === 0) return text;
  return text.replace(/\$(\d+)/g, (_match, digits: string) => `$${String(Number(digits) + by)}`);
}

function decodeRows(
  cls: unknown,
  rows: readonly (readonly (string | null)[])[],
  table: OpenTable,
): object[] {
  const ctor = readClassCtor(cls);
  const sample = construct(ctor);
  const keys = Object.keys(sample);
  if (keys.length === 0) {
    bad(
      "The class needs an initializer on every result column.",
      'Write `id = ""` or `n = 0`. The initializer selects the decode, and the order is the select list.',
    );
  }
  for (const key of keys) {
    if (BLOCKED.has(key)) bad(`Field ${key} is reserved.`, "Rename the class field.");
  }
  return rows.map((wire) => {
    const row = construct(ctor);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) continue;
      Reflect.set(
        row,
        key,
        decodeWire(wire[index], Reflect.get(sample, key), table.columns.get(key)),
      );
    }
    return row;
  });
}

function readClassCtor(cls: unknown): new () => object {
  if (typeof cls !== "function") {
    bad("Pass a class.", "The result of raw is one instance of that class per row.");
  }
  return cls as new () => object;
}

function construct(ctor: new () => object): object {
  try {
    return new ctor();
  } catch {
    bad(
      "The class must construct with no arguments.",
      "Give each field an initializer and no constructor arguments.",
    );
  }
}

function decodeWire(
  wire: string | null | undefined,
  sample: unknown,
  column: ColumnModel | undefined,
): unknown {
  if (wire === null || wire === undefined) return null;
  if (column !== undefined) return column.decode === undefined ? wire : column.decode(wire);
  if (typeof sample === "number") {
    const parsed = Number(wire);
    if (!Number.isFinite(parsed)) {
      bad(
        "A class field initialized with a number received a non-numeric value.",
        "Use a numeric expression, or initialize the field with a string.",
      );
    }
    return parsed;
  }
  if (typeof sample === "boolean") {
    if (wire === "t" || wire === "true" || wire === "1") return true;
    if (wire === "f" || wire === "false" || wire === "0") return false;
    bad(
      "A class field initialized with a boolean received another value.",
      "Use a boolean expression, or initialize the field with a string.",
    );
  }
  return wire;
}

function bad(message: string, fix: string): never {
  throw new OkmError("OKM1602", message, { fix: { summary: fix } });
}

function unverifiable(message: string, fix: string): never {
  throw new OkmError("OKM1702", message, { fix: { summary: fix } });
}
