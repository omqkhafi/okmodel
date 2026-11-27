/**
 * Counts rows a virtual generated change would reject, before any step runs.
 *
 * The count is the bounded read-only probe: `count(*)` of `select 1 … limit
 * 10001`, `READ ONLY`, `statement_timeout` 2s. Exact through 10,000. A timeout
 * is "could not count". A violating count throws OKM1922 and nothing is changed.
 */

import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import {
  PROBE_LIMIT,
  probeConnection,
  probeTarget,
  refuseGeneratedProbe,
  type ProbeCount,
} from "./data-probe.js";
import { driverUrl } from "./driver-url.js";

type Execute = (
  text: string,
  params?: readonly string[],
) => Promise<{ readonly rows: readonly (readonly (string | null)[])[] }>;

type Probe = {
  readonly schema: string;
  readonly table: string;
  readonly where: string;
  readonly detail: string;
};

/**
 * Stops apply when a pending step would store a virtual value the table rejects.
 *
 * Runs before the first step. A clean count returns. A violation throws
 * OKM1922. A count that does not finish throws OKM1922 as well.
 *
 * @param execute - Statements on the connection apply already holds
 * @param schema - Schema the migration targets
 * @param steps - Statements that have not run
 */
export async function refuseGeneratedRows(
  execute: Execute,
  schema: string,
  steps: readonly { readonly sql: string }[],
): Promise<void> {
  const probes = await probesFor(execute, schema, steps);
  if (probes.length === 0) return;
  const hits = await probeConnection(
    execute,
    schema,
    probes.map((probe) => ({ table: probe.table, which: "rows" as const, where: probe.where })),
  );
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index];
    const count = hits[index]?.count;
    if (probe === undefined || count === undefined) continue;
    refuseCount(count, probe.detail);
  }
}

/**
 * The same check for `migrate plan --target`.
 *
 * An unreachable target returns without a count. A reachable target that
 * has violating rows throws OKM1922.
 *
 * @param url - Target URL
 * @param schema - Schema the plan targets
 * @param steps - Planned statements
 */
export async function refuseGeneratedRowsOnTarget(
  url: string,
  schema: string,
  steps: readonly { readonly sql: string }[],
): Promise<void> {
  if (!steps.some((step) => parseGeneratedStep(step.sql, schema) !== undefined)) return;
  const postgres = (await import("postgres")).default;
  const sql = postgres(driverUrl(url), {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 1,
    onnotice: () => {},
  });
  let probes: readonly Probe[];
  try {
    probes = await probesFor(
      async (text, params) => {
        const rows = await sql.unsafe(text, params as string[] | undefined);
        return {
          rows: rows.map((row) =>
            Object.values(row).map((value) =>
              value === null || value === undefined ? null : String(value),
            ),
          ),
        };
      },
      schema,
      steps,
    );
  } catch (error) {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    if (connectFailed(error)) return;
    throw error;
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
  if (probes.length === 0) return;
  const hits = await probeTarget(
    url,
    schema,
    probes.map((probe) => ({ table: probe.table, which: "rows" as const, where: probe.where })),
  );
  if (hits === "unreachable") return;
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index];
    const count = hits[index]?.count;
    if (probe === undefined || count === undefined) continue;
    refuseCount(count, probe.detail);
  }
}

function refuseCount(count: ProbeCount, detail: string): void {
  if (count.kind === "unknown") {
    throw new OkmError(
      "OKM1922",
      `I could not count rows that would violate ${detail} in 2 s. Nothing was changed.`,
      { fix: { summary: "Nothing was changed." } },
    );
  }
  if (count.kind === "least") {
    refuseGeneratedProbe(PROBE_LIMIT + 1, detail);
    return;
  }
  refuseGeneratedProbe(count.n, detail);
}

async function probesFor(
  execute: Execute,
  schema: string,
  steps: readonly { readonly sql: string }[],
): Promise<readonly Probe[]> {
  const probes: Probe[] = [];
  for (const step of steps) {
    const parsed = parseGeneratedStep(step.sql, schema);
    if (parsed === undefined) continue;
    if (parsed.kind === "add") {
      probes.push({
        schema: parsed.schema,
        table: parsed.table,
        where: `(${parsed.expression}) is null`,
        detail: `${parsed.table}.${parsed.column} (virtual not null)`,
      });
      continue;
    }
    const live = await virtualColumn(execute, parsed.schema, parsed.table, parsed.column);
    if (live === undefined || live.generated !== "v") continue;
    const checks = live.notNull ? [] : await checkDefs(execute, parsed.schema, parsed.table);
    const parts: string[] = [];
    if (live.notNull) parts.push(`(${parsed.expression}) is null`);
    for (const check of checks) {
      const replaced = replaceColumn(check, parsed.column, parsed.expression);
      if (replaced !== undefined) parts.push(`not (${replaced})`);
    }
    if (parts.length === 0) continue;
    probes.push({
      schema: parsed.schema,
      table: parsed.table,
      where: parts.join(" or "),
      detail: `${parsed.table}.${parsed.column}`,
    });
  }
  return probes;
}

function connectFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code) : "";
  return (
    code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "ECONNRESET"
  );
}

type Parsed =
  | {
      readonly kind: "set";
      readonly schema: string;
      readonly table: string;
      readonly column: string;
      readonly expression: string;
    }
  | {
      readonly kind: "add";
      readonly schema: string;
      readonly table: string;
      readonly column: string;
      readonly expression: string;
    };

function parseGeneratedStep(sql: string, fallbackSchema: string): Parsed | undefined {
  const text = sql.trim();
  const set = /^alter\s+table\s+(\S+)\s+alter\s+column\s+(\S+)\s+set\s+expression\s+as\s+\(/i.exec(
    text,
  );
  if (set !== null) {
    const expression = insideParens(text, set[0].length - 1);
    const table = splitTable(set[1] ?? "", fallbackSchema);
    return {
      kind: "set",
      schema: table.schema,
      table: table.table,
      column: unquote(set[2] ?? ""),
      expression,
    };
  }
  const add = /^alter\s+table\s+(\S+)\s+add\s+column\s+(\S+)\s+/i.exec(text);
  if (add === null) return undefined;
  const rest = text.slice(add[0].length);
  if (!/\bgenerated\s+always\s+as\s+\(/i.test(rest) || !/\bvirtual\b/i.test(rest)) return undefined;
  if (!/\bnot\s+null\b/i.test(rest)) return undefined;
  const open = rest.search(/\bgenerated\s+always\s+as\s+\(/i);
  const marker = /\bgenerated\s+always\s+as\s+\(/i.exec(rest.slice(open));
  if (marker === null) return undefined;
  const expression = insideParens(rest, open + marker[0].length - 1);
  const table = splitTable(add[1] ?? "", fallbackSchema);
  return {
    kind: "add",
    schema: table.schema,
    table: table.table,
    column: unquote(add[2] ?? ""),
    expression,
  };
}

function insideParens(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

function splitTable(
  token: string,
  fallback: string,
): { readonly schema: string; readonly table: string } {
  const parts = [...token.matchAll(/"((?:[^"]|"")*)"/g)].map((match) =>
    (match[1] ?? "").replace(/""/g, '"'),
  );
  if (parts.length >= 2) return { schema: parts[0] ?? fallback, table: parts[1] ?? token };
  if (parts.length === 1) return { schema: fallback, table: parts[0] ?? token };
  return { schema: fallback, table: token };
}

function unquote(token: string): string {
  const match = /^"((?:[^"]|"")*)"$/.exec(token);
  return match !== null ? (match[1] ?? "").replace(/""/g, '"') : token;
}

async function virtualColumn(
  execute: Execute,
  schema: string,
  table: string,
  column: string,
): Promise<{ readonly notNull: boolean; readonly generated: string } | undefined> {
  const rows = await execute(
    `select a.attnotnull::text, a.attgenerated
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and a.attname = $3
       and a.attnum > 0 and not a.attisdropped`,
    [schema, table, column],
  );
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  return { notNull: row[0] === "true", generated: row[1] ?? "" };
}

async function checkDefs(
  execute: Execute,
  schema: string,
  table: string,
): Promise<readonly string[]> {
  const rows = await execute(
    `select pg_get_constraintdef(c.oid)
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = $1 and t.relname = $2 and c.contype = 'c'`,
    [schema, table],
  );
  return rows.rows.flatMap((row) => (typeof row[0] === "string" ? [row[0]] : []));
}

function replaceColumn(definition: string, column: string, expression: string): string | undefined {
  const quoted = quoteIdent(column);
  if (!definition.includes(quoted)) return undefined;
  const body = definition.replace(/^CHECK\s*\(\(/i, "").replace(/\)\)\s*$/, "");
  return body.split(quoted).join(`(${expression})`);
}
