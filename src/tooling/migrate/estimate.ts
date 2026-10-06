/**
 * Row estimates for `okm migrate plan` (D194).
 *
 * The numbers come from `pg_class.reltuples` on a selected target. They are
 * printed next to the lock and then discarded. The linter never reads them,
 * and `okm generate` never asks for them.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import type { PlanStep } from "./plan.js";

/**
 * Estimated rows above which an `ACCESS EXCLUSIVE` lock prints a note.
 *
 * The note is text on the lock line. It is not a lint finding.
 */
export const LARGE_TABLE_ROWS = 1_000_000;

/** What `pg_class` said about one table. */
export type RowEstimate =
  | { readonly kind: "rows"; readonly reltuples: number }
  | { readonly kind: "unknown" };

const ESTIMATE_SQL = `
  select c.relname, c.reltuples::float8::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and c.relname = any(string_to_array($2, E'\\x1f'))
    and c.relkind in ('r', 'p', 'f', 'm')
`;

/**
 * Reads `reltuples` for the named tables.
 *
 * The statements run in one read-only transaction. A table that is absent
 * from the result is not entered in the map: the printer treats that as
 * `new table`. `reltuples` of `-1` is {@link RowEstimate} `unknown`. This
 * never scans a table.
 *
 * @param url - Target URL
 * @param schema - Schema the plan qualifies, usually `public`
 * @param tables - Table names the plan steps name
 * @returns One entry per relation `pg_class` returned
 */
export async function readRowEstimates(
  url: string,
  schema: string,
  tables: readonly string[],
): Promise<ReadonlyMap<string, RowEstimate>> {
  const pool = open({ url, max: 1 });
  try {
    const connection = await pool.reserve?.();
    if (connection === undefined) {
      throw new Error("The target connection cannot start a transaction.");
    }
    let began = false;
    try {
      await connection.execute("begin read only");
      began = true;
      await connection.execute("set local statement_timeout = '5s'");
      const map = new Map<string, RowEstimate>();
      const unique = [...new Set(tables)];
      if (unique.length > 0) {
        const result = await connection.execute(ESTIMATE_SQL, [schema, unique.join("\u001f")]);
        for (const row of result.rows) {
          const name = row[0];
          if (name === null || name === undefined) continue;
          map.set(name, classify(row[1] ?? null));
        }
      }
      await connection.execute("commit");
      began = false;
      return map;
    } catch (error) {
      if (began) await connection.execute("rollback").catch(() => undefined);
      throw error;
    } finally {
      await connection.release();
    }
  } finally {
    await pool.close();
  }
}

/**
 * Lock line with estimates, the safe-rewrite label, and the large-table note.
 *
 * @param step - One plan step
 * @param estimates - `reltuples` for tables that exist on the target
 * @returns The text after `-- lock: `
 */
export function annotateLock(step: PlanStep, estimates: ReadonlyMap<string, RowEstimate>): string {
  const pieces = lockPieces(step);
  const text = pieces
    .map((piece) => {
      if (piece.table === undefined) return piece.mode;
      return `${piece.mode} on ${piece.table}, ${estimatePhrase(estimates.get(piece.table))}`;
    })
    .join("; ");
  if (step.safeRewrite === true) return `${text}; safe rewrite applied`;
  if (exclusiveOverLarge(pieces, estimates)) {
    return `${text}; note: more than ${String(LARGE_TABLE_ROWS)} estimated rows`;
  }
  return text;
}

/**
 * Compact phrase for one estimate.
 *
 * @param count - Rounded `reltuples`
 * @returns `about 4.2M rows` and the same shape for thousands and billions
 */
export function aboutRows(count: number): string {
  const rounded = Math.max(0, Math.round(count));
  if (rounded < 1_000) return `about ${String(rounded)} rows`;
  const units: readonly (readonly [number, string])[] = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [unit, suffix] of units) {
    if (rounded < unit) continue;
    const scaled = rounded / unit;
    const digits = scaled >= 10 || Number.isInteger(scaled) ? 0 : 1;
    const text = trimZero(scaled.toFixed(digits));
    return `about ${text}${suffix} rows`;
  }
  return `about ${String(rounded)} rows`;
}

function classify(raw: string | null): RowEstimate {
  if (raw === null) return { kind: "unknown" };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return { kind: "unknown" };
  return { kind: "rows", reltuples: value };
}

function estimatePhrase(estimate: RowEstimate | undefined): string {
  if (estimate === undefined) return "new table";
  if (estimate.kind === "unknown") return "rows unknown (table not analyzed)";
  return aboutRows(estimate.reltuples);
}

type LockPiece = {
  readonly mode: string;
  readonly table: string | undefined;
};

function lockPieces(step: PlanStep): readonly LockPiece[] {
  const segments = step.lock
    .split("; ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const named = new Map<string, string>();
  for (const segment of segments) {
    const table = lockTable(segment);
    if (table !== undefined) named.set(table, stripLockTable(segment));
  }
  const primary = segments[0] ?? step.lock;
  const primaryTable = lockTable(primary);
  const primaryMode = primaryTable === undefined ? primary : stripLockTable(primary);
  const pieces: LockPiece[] = [];
  const seen = new Set<string>();
  if (primaryTable === undefined) {
    const lead = (step.tables ?? []).filter((name) => !named.has(name));
    if (lead.length === 0 && named.size === 0) pieces.push({ mode: step.lock, table: undefined });
    for (const table of lead) {
      seen.add(table);
      pieces.push({ mode: primaryMode, table });
    }
  }
  for (const segment of segments) {
    const table = lockTable(segment);
    if (table === undefined) {
      if (primaryTable !== undefined || pieces.length === 0) {
        pieces.push({ mode: segment, table: undefined });
      }
      continue;
    }
    if (seen.has(table)) continue;
    seen.add(table);
    pieces.push({ mode: stripLockTable(segment), table });
  }
  for (const table of step.tables ?? []) {
    if (seen.has(table)) continue;
    pieces.push({ mode: primaryMode, table });
  }
  return pieces;
}

function exclusiveOverLarge(
  pieces: readonly LockPiece[],
  estimates: ReadonlyMap<string, RowEstimate>,
): boolean {
  for (const piece of pieces) {
    if (piece.mode !== "ACCESS EXCLUSIVE" || piece.table === undefined) continue;
    const estimate = estimates.get(piece.table);
    if (estimate === undefined || estimate.kind !== "rows") continue;
    if (estimate.reltuples > LARGE_TABLE_ROWS) return true;
  }
  return false;
}

function lockTable(segment: string): string | undefined {
  const match = /\bon\s+"((?:[^"]|"")*)"\."((?:[^"]|"")*)"/.exec(segment);
  const name = match?.[2];
  if (name === undefined) return undefined;
  return name.replaceAll('""', '"');
}

function stripLockTable(segment: string): string {
  return segment.replace(/\s+on\s+"((?:[^"]|"")*)"\."((?:[^"]|"")*)"/, "").trim();
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}
