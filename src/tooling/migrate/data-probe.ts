/**
 * Bounded read-only counts for generate, plan, and apply (D333).
 *
 * Each count is `count(*)` of a `limit 10001` subquery, never `count(*)`
 * over the table. A statement timeout is "could not count in 2 s" and means
 * the column has data. `pg_class` and `pg_stats` never decide emptiness.
 */

import { isConnectionFailure } from "../../contracts/connection.js";
import { OkmError } from "../../contracts/error.js";
import { qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import { driverUrl } from "./driver-url.js";
import { OPTIONAL_CONNECT_SECONDS } from "./optional-read.js";
import { missingPostgres } from "../cli/outcome.js";
import type { PlanStep } from "./plan.js";

/** One `--fill table.column=expression` value. */
export type Fill = {
  readonly table: string;
  readonly column: string;
  readonly expression: string;
};

/** `--json` object on an OKM1525 refusal that needs `--fill`. */
export type FillNeeds = {
  readonly flag: "--fill";
  readonly target: string;
  readonly emptyRows: number | string;
  readonly suggest: readonly string[];
};

/**
 * Lock-line phrase for one column.
 *
 * @param count - Empty rows
 * @param fill - Expression, when the plan fills them
 * @returns The phrase after the lock
 */
/**
 * Sentence for the drop question, including the trailing space.
 *
 * @param column - Column name
 * @param count - Non-null rows, when the target answered
 * @returns `""` when there is no count
 */
export function dropHolds(column: string, count: ProbeCount | undefined): string {
  if (count === undefined) return "";
  if (count.kind === "unknown") return `I could not count ${column} in 2 s. `;
  return `${column} holds ${countPhrase(count)} values. `;
}

export function lockPhrase(count: ProbeCount, fill?: string): string {
  const rows =
    count.kind === "exact"
      ? `${countPhrase(count)} rows have no value`
      : count.kind === "least"
        ? "10,000 or more rows have no value"
        : "I could not count in 2 s";
  return fill === undefined ? rows : `${rows}, filled with ${fill}`;
}

/**
 * Appends {@link lockPhrase} when `step` is about a probed column.
 *
 * @param step - Plan step
 * @param base - Lock text without the probe
 * @param empty - Empty-row counts keyed `table.column`
 * @param fills - Fills in the plan
 * @returns The lock text
 */
export function annotateProbe(
  step: PlanStep,
  base: string,
  empty: ReadonlyMap<string, ProbeCount>,
  fills: readonly Fill[],
): string {
  for (const [key, count] of empty) {
    const dot = key.indexOf(".");
    const table = key.slice(0, dot);
    const column = key.slice(dot + 1);
    if (!step.sql.includes(quoteIdent(table)) || !step.sql.includes(quoteIdent(column))) continue;
    const fill = fills.find((item) => item.table === table && item.column === column);
    return `${base}; ${lockPhrase(count, fill?.expression)}`;
  }
  return base;
}

/**
 * JSON `data` for one probed step. Absent when the step has no probe.
 *
 * @param step - Plan step
 * @param empty - Empty-row counts
 * @param fills - Fills in the plan
 * @returns The additive field, or `undefined`
 */
export function stepData(
  step: PlanStep,
  empty: ReadonlyMap<string, ProbeCount>,
  fills: readonly Fill[],
): { readonly emptyRows: number | string; readonly fill?: string } | undefined {
  for (const [key, count] of empty) {
    const dot = key.indexOf(".");
    const table = key.slice(0, dot);
    const column = key.slice(dot + 1);
    if (!step.sql.includes(quoteIdent(table)) || !step.sql.includes(quoteIdent(column))) continue;
    const fill = fills.find((item) => item.table === table && item.column === column);
    const emptyRows =
      count.kind === "exact" ? count.n : count.kind === "least" ? "10,000 or more" : "unknown";
    return fill === undefined ? { emptyRows } : { emptyRows, fill: fill.expression };
  }
  return undefined;
}

/** Rows the subquery reads before the count stops being exact. */
export const PROBE_LIMIT = 10_000;

/** `statement_timeout` for one probe, in milliseconds. */
export const PROBE_STATEMENT_MS = 2_000;

/** One bounded count. `least` is more than {@link PROBE_LIMIT}. */
export type ProbeCount =
  | { readonly kind: "exact"; readonly n: number }
  | { readonly kind: "least" }
  | { readonly kind: "unknown" };

/** What to count on one column, or the rows of a table that has no such column yet. */
export type ProbeRequest = {
  readonly table: string;
  readonly column?: string;
  /** `rows` counts the table. The others count a column. */
  readonly which: "null" | "notNull" | "blank" | "rows";
  /** Rows the subquery reads before the count stops being exact. Defaults to {@link PROBE_LIMIT}. */
  readonly limit?: number;
  /** Predicate that replaces the column predicate. The caller quotes it. */
  readonly where?: string;
};

/** One answer from {@link probeTarget}. */
export type ProbeHit = ProbeRequest & { readonly count: ProbeCount };

type Query = (text: string, params?: readonly string[]) => Promise<readonly (string | null)[][]>;

/**
 * Counts each request on `url`.
 *
 * A connection failure or a missing `postgres` package is `"unreachable"`.
 * One read-only transaction, `statement_timeout` 2s, connect bound 3s.
 * A timeout on one request is `unknown` and does not fail the rest.
 *
 * @param url - Target URL
 * @param schema - Schema the tables live in
 * @param requests - Counts to take
 * @returns One hit per request, or `"unreachable"`
 */
export async function probeTarget(
  url: string,
  schema: string,
  requests: readonly ProbeRequest[],
): Promise<readonly ProbeHit[] | "unreachable"> {
  if (requests.length === 0) return [];
  try {
    const postgres = (await import("postgres")).default;
    const sql = postgres(driverUrl(url), {
      max: 1,
      connect_timeout: OPTIONAL_CONNECT_SECONDS,
      idle_timeout: 1,
      onnotice: () => {},
    });
    let aborted: ProbeHit[] | undefined;
    try {
      return await sql.begin("read only", async (tx) => {
        await tx.unsafe(`set local statement_timeout = '${String(PROBE_STATEMENT_MS)}ms'`);
        await armProbe(
          async (text) => {
            const rows = await tx.unsafe(text);
            return rows.map((row) =>
              Object.values(row).map((value) =>
                value === null || value === undefined ? null : String(value),
              ),
            );
          },
          schema,
          [...new Set(requests.map((request) => request.table))],
        );
        const hits: ProbeHit[] = [];
        for (const request of requests) {
          try {
            const rows = await tx.unsafe<{ c: string | null }[]>(probeSql(schema, request));
            hits.push({ ...request, count: parseCount(rows[0]?.c ?? null, request.limit) });
          } catch (error) {
            if (!isTimeout(error)) throw error;
            aborted = [
              ...hits,
              { ...request, count: { kind: "unknown" } },
              ...requests
                .slice(hits.length + 1)
                .map((rest) => ({ ...rest, count: { kind: "unknown" as const } })),
            ];
            throw error;
          }
        }
        return hits;
      });
    } catch (error) {
      if (aborted !== undefined) return aborted;
      throw error;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  } catch (error) {
    if (isConnectionFailure(error) || missingPostgres(error) !== undefined) return "unreachable";
    throw error;
  }
}

/**
 * The same counts on a connection apply already holds.
 *
 * @param execute - One statement
 * @param schema - Schema the tables live in
 * @param requests - Counts to take
 * @returns One hit per request
 */
export async function probeConnection(
  execute: (
    text: string,
    params?: readonly string[],
  ) => Promise<{ readonly rows: readonly (readonly (string | null)[])[] }>,
  schema: string,
  requests: readonly ProbeRequest[],
): Promise<readonly ProbeHit[]> {
  return readHits(
    async (text, params) => {
      const result = await execute(text, params);
      return result.rows.map((row) => [...row]);
    },
    schema,
    requests,
  );
}

/**
 * SQL for one bounded count.
 *
 * @param schema - Schema name
 * @param request - Table, optional column, and which rows
 * @returns A single `select`
 */
export function probeSql(schema: string, request: ProbeRequest): string {
  const table = qualify(schema, request.table);
  const where =
    request.where !== undefined
      ? request.where
      : request.which === "rows" || request.column === undefined
        ? "true"
        : request.which === "null"
          ? `${quoteIdent(request.column)} is null`
          : request.which === "notNull"
            ? `${quoteIdent(request.column)} is not null`
            : `${quoteIdent(request.column)} = ''`;
  return `select count(*)::text as c from (select 1 from ${table} where ${where} limit ${String((request.limit ?? PROBE_LIMIT) + 1)}) as okm_n`;
}

/**
 * Words for a count: `1,204`, `10,000 or more`, or `I could not count in 2 s`.
 *
 * @param count - Probe answer
 * @returns The phrase a question uses
 */
export function countPhrase(count: ProbeCount | undefined): string {
  if (count === undefined || count.kind === "unknown") return "I could not count in 2 s";
  if (count.kind === "least") return "10,000 or more";
  return count.n.toLocaleString("en-US");
}

/**
 * Whether a failed count means the column has data.
 *
 * @param count - Probe answer
 * @returns `true` when rows were found or the count did not finish
 */
export function hasRows(count: ProbeCount | undefined): boolean {
  if (count === undefined || count.kind === "unknown" || count.kind === "least") return true;
  return count.n > 0;
}

async function readHits(
  query: Query,
  schema: string,
  requests: readonly ProbeRequest[],
): Promise<ProbeHit[]> {
  const hits: ProbeHit[] = [];
  await query("begin read only");
  try {
    await query(`set local statement_timeout = '${String(PROBE_STATEMENT_MS)}ms'`);
    await armProbe(query, schema, [...new Set(requests.map((request) => request.table))]);
    for (const request of requests) {
      await query("savepoint okm_probe");
      try {
        const rows = await query(probeSql(schema, request));
        await query("release savepoint okm_probe");
        hits.push({ ...request, count: parseCount(rows[0]?.[0] ?? null, request.limit) });
      } catch (error) {
        await query("rollback to savepoint okm_probe").catch(() => undefined);
        if (isTimeout(error)) {
          hits.push({ ...request, count: { kind: "unknown" } });
          continue;
        }
        if (isMissingRelation(error)) {
          hits.push({ ...request, count: { kind: "exact", n: 0 } });
          continue;
        }
        throw error;
      }
    }
    await query("commit");
  } catch (error) {
    await query("rollback").catch(() => undefined);
    if (isConnectionFailure(error) || missingPostgres(error) !== undefined) throw error;
    if (isTimeout(error)) {
      return requests.map((request) => ({ ...request, count: { kind: "unknown" as const } }));
    }
    throw error;
  }
  return hits;
}

async function armProbe(query: Query, schema: string, tables: readonly string[]): Promise<void> {
  if (tables.length === 0) return;
  const list = tables.map((table) => quoteLiteral(table)).join(", ");
  const rows = await query(
    `select c.relname, c.relforcerowsecurity::text, r.rolsuper::text, r.rolbypassrls::text,
            exists (
              select 1 from pg_policy p
              where p.polrelid = c.oid and p.polname = c.relname || '_unscoped_select'
            )::text
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_roles r on r.rolname = current_user
     where n.nspname = ${quoteLiteral(schema)} and c.relname in (${list}) and c.relkind = 'r'`,
  );
  let unscoped = false;
  for (const row of rows) {
    if (row[1] !== "true" || row[2] === "true" || row[3] === "true") continue;
    if (row[4] === "true") {
      unscoped = true;
      continue;
    }
    throw new OkmError(
      "OKM1926",
      `Table ${row[0] ?? ""} forces row-level security. This role would count zero rows.`,
      {
        fix: {
          summary:
            "Count as a role that bypasses row-level security, or use a table with the unscoped select policy.",
        },
      },
    );
  }
  if (unscoped) await query("select set_config('app.unscoped', 'on', true)");
}

/**
 * Refuses a backfill that would update zero rows under forced row security.
 *
 * The unscoped select policy does not cover writes. A role that is not a
 * superuser and does not have BYPASSRLS cannot see the rows.
 *
 * @param execute - One statement
 * @param schema - Schema name
 * @param table - SQL table name
 */
export async function assertBackfillVisible(
  execute: (sql: string) => Promise<unknown>,
  schema: string,
  table: string,
): Promise<void> {
  const result = (await execute(
    `select c.relforcerowsecurity::text, r.rolsuper::text, r.rolbypassrls::text
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_roles r on r.rolname = current_user
     where n.nspname = ${quoteLiteral(schema)} and c.relname = ${quoteLiteral(table)} and c.relkind = 'r'`,
  )) as { readonly rows?: readonly (readonly (string | null)[])[] };
  const row = result.rows?.[0];
  if (row === undefined || row[0] !== "true" || row[1] === "true" || row[2] === "true") return;
  throw new OkmError(
    "OKM1926",
    `Table ${table} forces row-level security. A backfill from this role would update zero rows.`,
    {
      fix: {
        summary: "Use a role that bypasses row-level security.",
      },
    },
  );
}

function parseCount(raw: string | null, limit = PROBE_LIMIT): ProbeCount {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return { kind: "unknown" };
  if (n > limit) return { kind: "least" };
  return { kind: "exact", n };
}

/** One frequent value from `pg_stats`, used only as a suggestion. */
export type CommonValue = {
  readonly table: string;
  readonly column: string;
  readonly value: string;
  readonly percent: number;
};

/**
 * Most common value when `pg_stats` shows at most 20 distinct values.
 *
 * This never decides that a column is empty. A missing row is omitted.
 *
 * @param url - Target URL
 * @param schema - Schema name
 * @param columns - Columns to read
 * @returns One value per column that qualifies, or `"unreachable"`
 */
export async function readCommonValues(
  url: string,
  schema: string,
  columns: readonly { readonly table: string; readonly column: string }[],
): Promise<readonly CommonValue[] | "unreachable"> {
  if (columns.length === 0) return [];
  try {
    const postgres = (await import("postgres")).default;
    const sql = postgres(driverUrl(url), {
      max: 1,
      connect_timeout: OPTIONAL_CONNECT_SECONDS,
      idle_timeout: 1,
      onnotice: () => {},
    });
    try {
      const rows = await sql.unsafe<
        {
          tablename: string;
          attname: string;
          vals: string | null;
          freqs: string | null;
          n: string | null;
        }[]
      >(
        `select tablename, attname, most_common_vals::text as vals, most_common_freqs::text as freqs, n_distinct::text as n
         from pg_stats where schemaname = $1 and tablename = any($2::text[])`,
        [schema, [...new Set(columns.map((item) => item.table))]],
      );
      const found: CommonValue[] = [];
      for (const column of columns) {
        const row = rows.find(
          (item) => item.tablename === column.table && item.attname === column.column,
        );
        if (row === undefined) continue;
        const values = pgArray(row.vals);
        const freqs = pgArray(row.freqs).map(Number);
        const distinct = row.n === null ? undefined : Number(row.n);
        if (!commonOk(values, freqs, distinct)) continue;
        const value = values[0];
        const freq = freqs[0];
        if (value === undefined || freq === undefined || !Number.isFinite(freq)) continue;
        found.push({ ...column, value, percent: Math.round(freq * 100) });
      }
      return found;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  } catch (error) {
    if (isConnectionFailure(error) || missingPostgres(error) !== undefined) return "unreachable";
    throw error;
  }
}

function commonOk(
  values: readonly string[],
  freqs: readonly number[],
  distinct: number | undefined,
): boolean {
  if (values.length === 0 || values.length > 20) return false;
  if (distinct !== undefined && distinct > 20) return false;
  if (distinct !== undefined && distinct > 0) return true;
  const sum = freqs.reduce((total, freq) => total + (Number.isFinite(freq) ? freq : 0), 0);
  return sum >= 0.99;
}

function pgArray(text: string | null): string[] {
  if (text === null || text.length < 2 || !text.startsWith("{")) return [];
  const body = text.slice(1, -1);
  if (body.length === 0) return [];
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"' && body[index - 1] !== "\\") {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char ?? "";
  }
  values.push(current);
  return values;
}

function isMissingRelation(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("42P01") || text.includes("42703") || text.includes("does not exist");
}

/**
 * Stops before the first step when a virtual generated column would reject rows.
 *
 * @param count - Violating rows from the bounded probe
 * @param detail - What the rows violate
 * @throws OkmError OKM1922 when `count` is greater than zero
 */
export function refuseGeneratedProbe(count: number, detail: string): void {
  if (count === 0) return;
  const message = `${String(count)} rows would violate ${detail}. Nothing was changed.`;
  throw new OkmError("OKM1922", message, { fix: { summary: "Nothing was changed." } });
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "57014") return true;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("statement timeout") || message.includes("canceling statement")) return true;
  if ("cause" in error) return isTimeout(error.cause);
  return false;
}
