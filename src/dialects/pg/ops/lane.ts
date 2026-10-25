/**
 * Typed raw SQL and `explain()` (P103, P104, D268, F7-3).
 *
 * Exported from `okmodel/pg`. An app that does not import them drops this
 * module. The table handle carries the session under `Symbol.for("okm.lane")`.
 * The class form names the statement class explicitly. Its parameters come
 * from the fragment, and the tenant predicate, when it applies, is written
 * outside the fragment. The `raw(db, sql, params)` form runs a statement
 * `okm raw sync` locked. It hands the session to the runtime chunk that binds,
 * runs, and decodes it, so this module holds no codec and no file reader.
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
 * `plan` is null in production, and `params` is empty there. Outside
 * production, a hidden or sensitive parameter is `[redacted]` in `params`
 * and in `plan`. The statement text keeps `$1`.
 */
export type ExplainResult = {
  /** The statement `explain` describes. */
  readonly text: string;
  /** Bound parameters. Empty in production. Concealed values are `[redacted]`. */
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

/** What the runtime chunk exposes to a typed `raw()` call. */
type RawRunner = {
  readonly runTypedRaw: (
    session: object,
    sql: string,
    params: unknown,
    trust: unknown,
  ) => Promise<readonly unknown[]>;
};

/**
 * Typed raw statements, keyed by the exact SQL literal.
 *
 * Empty here. `okm raw sync` writes `.okm/raw.d.ts`, which adds one entry per
 * `raw(db, "...", [...])` literal with its `params`, `row`, and `kind`. A
 * literal with no entry does not type-check.
 */
// oxlint-disable-next-line typescript/no-empty-object-type, no-unused-vars
export interface RawStatements {}

/** The message a literal with no `RawStatements` entry shows. */
type NeedsRawSync =
  "No typed entry for this SQL. Run `okm raw sync` and commit .okm/raw.lock.json and .okm/raw.d.ts. The SQL must be one string literal.";

const LANE = Symbol.for("okm.lane");
const TRUSTED = Symbol.for("okm.trusted");
const READ = "read";
const WRITE = "write";
const BLOCKED = new Set(["__proto__", "constructor", "toString", "hasOwnProperty"]);

/**
 * Runs one locked raw statement.
 *
 * `sql` is a string literal that `okm raw sync` described. Its entry in
 * `.okm/raw.d.ts` types `params` and each row. Parameters are encoded and
 * columns are decoded with the codecs the typed API uses for that Postgres
 * type, and a type with no codec stays the driver's text. A `"write"`
 * statement runs on the primary. A `"read"` follows the routing rules, and
 * inside `tx()` both use the transaction's connection.
 *
 * The lock is read from `.okm/raw.lock.json` on the first call, or comes from
 * `registerRawLock`. A statement that is not in it is OKM1601.
 *
 * A raw statement has no archive filter and no hidden-column guard. On a
 * schema with tenancy it is refused (OKM1702) unless the client went through
 * `trusted(client, reason)`.
 *
 * @typeParam S - The SQL literal
 * @param db - The connected client, including one from `tx()`, or a table handle
 * @param sql - Static SQL with `$n` placeholders
 * @param params - One value per placeholder, in order
 * @returns One object per row, keyed by column name
 */
export function raw<S extends string>(
  db: object,
  sql: S extends keyof RawStatements ? S : NeedsRawSync,
  params: S extends keyof RawStatements ? RawStatements[S]["params"] : never,
): Promise<readonly (S extends keyof RawStatements ? RawStatements[S]["row"] : never)[]>;
/**
 * Runs one raw statement on a table handle, with the class naming the row.
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
export function raw<C extends new () => object>(
  handle: object,
  cls: C,
  statement: "read" | "write",
  source: unknown,
): Promise<InstanceType<C>[]>;
export function raw(
  handle: object,
  second: unknown,
  third: unknown,
  fourth?: unknown,
): Promise<readonly unknown[]> {
  if (typeof second === "string") return rawTyped(handle, second, third);
  return rawClass(handle, second as new () => object, third as "read" | "write", fourth);
}

/**
 * Lets typed `raw()` run on a tenant client.
 *
 * A raw statement has no tenant predicate, so on a schema with tenancy the
 * client refuses it (OKM1702). This returns the same client for typed `raw()`
 * to accept. The reason is required. It reaches the safety hatches as
 * `trusted` and the write observer as the event `tag`. The statement still
 * has no tenant predicate and no archive filter.
 *
 * @typeParam C - Client type
 * @param client - The connected client
 * @param reason - Why this statement may run without a tenant predicate
 * @returns A client that typed `raw()` accepts. Other methods are unchanged
 */
export function trusted<C extends object>(client: C, reason: string): C {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    unverifiable("trusted() needs a reason.", 'Pass trusted(client, "why this SQL is safe").');
  }
  return Object.create(client, { [TRUSTED]: { value: reason.trim() } }) as C;
}

async function rawTyped(handle: object, sql: string, params: unknown): Promise<readonly unknown[]> {
  const value = findLane(handle);
  const session: unknown = value[0];
  const door: unknown = value[3];
  if (!isSession(session) || typeof door !== "function") {
    bad("Pass the connected client.", "raw(db, sql, params) takes the client from connect().");
  }
  const runner = await (door as () => Promise<RawRunner>)();
  return runner.runTypedRaw(session, sql, params, Reflect.get(handle, TRUSTED));
}

function findLane(handle: object): readonly unknown[] {
  const own: unknown = Reflect.get(handle, LANE);
  if (Array.isArray(own)) return own;
  for (const key in handle) {
    const item: unknown = Reflect.get(handle, key);
    if (typeof item !== "object" || item === null) continue;
    const lane: unknown = Reflect.get(item, LANE);
    if (Array.isArray(lane)) return lane;
  }
  if (typeof Reflect.get(handle, "for") === "function") {
    unverifiable(
      "The root client of a tenant schema has no tenant for typed raw SQL.",
      'Call for({ ... }) and pass trusted(client, "reason"), or call unscoped(reason).',
    );
  }
  return bad("Pass the connected client.", "raw(db, sql, params) takes the client from connect().");
}

async function rawClass<C extends new () => object>(
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

/** Placeholder shared with read and write `inspect()`. */
const REDACTED = "[redacted]";

/**
 * Describes a query.
 *
 * Outside production this sends `EXPLAIN` with the real parameters and returns
 * the lines. A hidden or sensitive value is `[redacted]` in `params` and in
 * those lines. The plan Postgres chose is unchanged: the text is edited after
 * `EXPLAIN` returns, which works on Postgres 15 through 18. In production
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
  const shown =
    lane.session.schema.model[lane.table]?.conceal === true
      ? await concealedParams(query, got.params)
      : got.params;
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
  const secrets = concealedValues(got.params, shown);
  return {
    text: got.text,
    params: shown,
    plan: secrets.length === 0 ? plan : scrubPlan(plan, secrets),
  };
}

/**
 * Parameters `inspect()` would show.
 *
 * A table with nothing concealed skips this. The read helper has already
 * replaced hidden and sensitive values.
 *
 * @param query - Query passed to `explain`
 * @param params - Parameters `sql()` bound
 * @returns Redacted parameters, or `params` when `inspect()` has another shape
 */
async function concealedParams(
  query: object,
  params: readonly (string | null)[],
): Promise<readonly (string | null)[]> {
  const inspect = Reflect.get(query, "inspect");
  if (typeof inspect !== "function") return params;
  const view: unknown = await (inspect as () => unknown).call(query);
  if (typeof view !== "object" || view === null) return params;
  const sql: unknown = Reflect.get(view, "sql");
  if (typeof sql !== "object" || sql === null) return params;
  const next: unknown = Reflect.get(sql, "params");
  if (!Array.isArray(next) || next.length !== params.length) return params;
  const shown: (string | null)[] = [];
  for (const item of next) {
    if (typeof item !== "string" && item !== null) return params;
    shown.push(item);
  }
  return shown;
}

function concealedValues(
  params: readonly (string | null)[],
  shown: readonly (string | null)[],
): string[] {
  const found: string[] = [];
  for (let index = 0; index < params.length; index += 1) {
    const value = params[index];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value !== REDACTED &&
      shown[index] === REDACTED
    ) {
      found.push(value);
    }
  }
  return found;
}

/**
 * Removes concealed values from `EXPLAIN` text.
 *
 * Quoted literals are replaced wherever they spell a concealed parameter,
 * including a value Postgres pretty-prints. A bare number or boolean is
 * replaced only on lines without `cost=`, so a row estimate stays.
 *
 * @param lines - `EXPLAIN` lines Postgres returned
 * @param secrets - Parameter values `inspect()` redacted
 * @returns Lines safe to print
 */
function scrubPlan(lines: readonly string[], secrets: readonly string[]): string[] {
  const unique = [...new Set(secrets)];
  const quoted = replaceLiterals(lines.join("\n"), unique).split("\n");
  return quoted.map((line) => (line.includes("cost=") ? line : replaceBare(line, unique)));
}

function replaceLiterals(text: string, secrets: readonly string[]): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const quote = text.indexOf("'", index);
    if (quote < 0) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, quote);
    const end = scanLiteral(text, quote);
    if (end < 0) {
      out += text.slice(quote);
      break;
    }
    const body = unescapeLiteral(text.slice(quote + 1, end - 1));
    out += holds(body, secrets) ? `'${REDACTED}'` : text.slice(quote, end);
    index = end;
  }
  return out;
}

function scanLiteral(text: string, open: number): number {
  let index = open + 1;
  while (index < text.length) {
    if (text.charCodeAt(index) !== 39) {
      index += 1;
      continue;
    }
    if (text.charCodeAt(index + 1) === 39) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return -1;
}

function unescapeLiteral(body: string): string {
  let out = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body.charCodeAt(index) === 39 && body.charCodeAt(index + 1) === 39) {
      out += "'";
      index += 1;
      continue;
    }
    out += body[index];
  }
  return out;
}

function holds(literal: string, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    if (literal === secret) return true;
    if (secret.length >= 4 && literal.includes(secret)) return true;
    if (arraySpelling(literal, secret)) return true;
    if (sameJson(literal, secret)) return true;
  }
  return false;
}

function arraySpelling(literal: string, secret: string): boolean {
  if (!literal.startsWith("{") || literal.includes(":")) return false;
  if (!secret.startsWith("{") || !secret.endsWith("}") || !secret.includes('"')) return false;
  const bare = secret.replaceAll('"', "");
  return literal === bare || (bare.length >= 4 && literal.includes(bare));
}

function sameJson(literal: string, secret: string): boolean {
  if (!jsonText(literal) || !jsonText(secret)) return false;
  try {
    return stableJson(JSON.parse(literal)) === stableJson(JSON.parse(secret));
  } catch {
    return false;
  }
}

function jsonText(value: string): boolean {
  const lead = value.trimStart().charCodeAt(0);
  return lead === 123 || lead === 91 || lead === 34;
}

function stableJson(value: unknown): string {
  return JSON.stringify(orderJson(value));
}

function orderJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = orderJson(record[key]);
  return out;
}

function replaceBare(line: string, secrets: readonly string[]): string {
  let next = line;
  for (const secret of secrets) {
    if (!bareConst(secret)) continue;
    const pattern = new RegExp(`(?<![\\w.])${escapeRegExp(secret)}(?![\\w.])`, "g");
    next = next.replace(pattern, REDACTED);
  }
  return next;
}

function bareConst(secret: string): boolean {
  return (
    secret === "true" ||
    secret === "false" ||
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(secret)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
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
