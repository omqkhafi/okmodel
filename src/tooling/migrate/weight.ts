/**
 * Step weights: what a `blocking` or `rewrite` step costs a large table.
 *
 * Apply counts the rows on the real target, right before its first step, and
 * stops when a weighted step would run over {@link BLOCKING_ROWS} unless
 * `--allow-blocking` was passed. The durations are estimates from one
 * measurement on real servers, good to an order of magnitude. The lock
 * timeout covers waiting for the lock, not the build that follows.
 */

import { OkmError } from "../../contracts/error.js";
import { touchedTables } from "../../dialects/ddl-step.js";
import { aboutRows, ESTIMATE_SQL, type RowEstimate } from "./estimate.js";
import { probeConnection, probeTarget, type ProbeCount } from "./data-probe.js";
import type { PlanStep } from "./plan.js";
import type { StepWeight } from "./classify.js";

/** Estimated rows above which apply needs `--allow-blocking`. */
export const BLOCKING_ROWS = 100_000;

/** Milliseconds per million rows. Measured on real servers, order of magnitude only. */
export const MS_PER_MILLION: Readonly<Record<StepWeight, number>> = {
  blocking: 45_000,
  rewrite: 1_300,
};

/** Rows in one table: a number, or `least` when the count stopped at the limit. */
export type TableRows = { readonly rows: number; readonly least: boolean };

type Execute = (
  text: string,
  params?: readonly string[],
) => Promise<{ readonly rows: readonly (readonly (string | null)[])[] }>;

/** One weighted step and the table it names. */
export type Weighted = {
  readonly migrationId: string;
  readonly index: number;
  readonly step: PlanStep;
  readonly weight: StepWeight;
};

/**
 * Tables a step names.
 *
 * A migration file does not store the list the planner built, so it is read
 * from the statement again: `"schema"."table"` after a table keyword.
 *
 * @param step - A plan step
 * @returns Table names, in first-seen order
 */
export function stepTables(step: PlanStep): readonly string[] {
  return step.tables ?? touchedTables(step.sql, step.lock, undefined);
}

/**
 * Estimated duration.
 *
 * @param weight - Step weight
 * @param rows - Rows in the table
 * @returns Milliseconds, rounded
 */
export function estimateMs(weight: StepWeight, rows: number): number {
  return Math.round((rows / 1_000_000) * MS_PER_MILLION[weight]);
}

/**
 * Words for a duration: `about 4.5 s`, `about 3 min`, `under 1 s`.
 *
 * @param ms - Milliseconds
 * @returns The phrase
 */
export function durationPhrase(ms: number): string {
  if (ms < 1_000) return "under 1 s";
  const seconds = ms / 1_000;
  if (seconds < 60) return `about ${trim(seconds.toFixed(seconds < 10 ? 1 : 0))} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `about ${trim(minutes.toFixed(minutes < 10 ? 1 : 0))} min`;
  return `about ${trim((minutes / 60).toFixed(1))} h`;
}

function trim(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * The text a plan prints for a weighted step.
 *
 * @param weight - Step weight
 * @param table - Table name
 * @param count - Rows, when a target answered
 * @returns A phrase for the lock line
 */
export function weightPhrase(
  weight: StepWeight,
  table: string,
  count: TableRows | undefined,
  perMillion?: number,
): string {
  const rate = perMillion ?? MS_PER_MILLION[weight];
  const lead = `${weight} step`;
  if (count === undefined) {
    return `${lead}, ${String(rate / 1_000)} s per million rows (an estimate)`;
  }
  const size = count.least
    ? `${count.rows.toLocaleString("en-US")} or more rows`
    : aboutRows(count.rows).slice("about ".length);
  const time = durationPhrase(Math.round((count.rows / 1_000_000) * rate));
  return `${lead} on ${table}, ${size}: ${count.least ? "at least " : ""}${time} (an estimate, not a measurement)`;
}

/**
 * The labelled rate for an exclusion build.
 *
 * The global blocking rate stays 45 s. An `EXCLUDE USING gist` step prints
 * 44.7 s per million rows. There is no online path and no `NOT VALID` form.
 *
 * @param sql - Step text
 * @param weight - Step weight
 * @returns Milliseconds per million rows, or `undefined` to use the global rate
 */
export function exclusionPerMillion(
  sql: string,
  weight: StepWeight | undefined,
): number | undefined {
  if (weight === "blocking" && /exclude using gist/i.test(sql)) return 44_700;
  return undefined;
}

/**
 * Weighted steps of the units that still have to run.
 *
 * @param units - Pending apply units
 * @returns One entry per step that has a weight and names a table
 */
export function weightedSteps(
  units: readonly {
    readonly migrationId: string;
    readonly steps: readonly { readonly index: number; readonly step: PlanStep }[];
  }[],
): readonly Weighted[] {
  const found: Weighted[] = [];
  for (const unit of units) {
    for (const { index, step } of unit.steps) {
      if (step.weight === undefined) continue;
      found.push({ migrationId: unit.migrationId, index, step, weight: step.weight });
    }
  }
  return found;
}

/**
 * Rows in each table, counted on the target.
 *
 * The count is a bounded probe (`count(*)` over a `limit` subquery, read
 * only, 2 s), so it never scans a big table. `pg_class.reltuples` raises the
 * number for the estimate when the table is bigger than the probe can see.
 * A count that does not finish in 2 s counts as over the limit.
 *
 * @param execute - Runs one statement on the connection apply holds
 * @param schema - Schema the tables live in
 * @param tables - Table names
 * @returns Rows per table
 */
export async function countTables(
  execute: Execute,
  schema: string,
  tables: readonly string[],
): Promise<ReadonlyMap<string, TableRows>> {
  const names = [...new Set(tables)];
  const out = new Map<string, TableRows>();
  if (names.length === 0) return out;
  const hits = await probeConnection(
    execute,
    schema,
    names.map((table) => ({ table, which: "rows" as const, limit: BLOCKING_ROWS })),
  );
  const stats = await execute(ESTIMATE_SQL, [schema, names.join("\u001f")]);
  const tuples = new Map(stats.rows.map((row) => [row[0] ?? "", Number(row[1] ?? "-1")]));
  for (const hit of hits) {
    out.set(hit.table, rowsFrom(hit.count, tuples.get(hit.table)));
  }
  return out;
}

function rowsFrom(count: ProbeCount, reltuples: number | undefined): TableRows {
  const known =
    reltuples !== undefined && Number.isFinite(reltuples) && reltuples > 0 ? reltuples : 0;
  if (count.kind === "exact") return { rows: count.n, least: false };
  // `least` and `unknown` are both "more than the limit"; reltuples says how much more.
  return { rows: Math.max(BLOCKING_ROWS + 1, Math.round(known)), least: known <= BLOCKING_ROWS };
}

/**
 * The widest table a step names, with its row count.
 *
 * @param step - A plan step
 * @param counts - Rows per table
 * @returns The table and its count, or `undefined` when no table was counted
 */
export function widest(
  step: PlanStep,
  counts: ReadonlyMap<string, TableRows>,
): { readonly table: string; readonly count: TableRows } | undefined {
  let found: { readonly table: string; readonly count: TableRows } | undefined;
  for (const table of stepTables(step)) {
    const count = counts.get(table);
    if (count !== undefined && (found === undefined || count.rows > found.count.rows)) {
      found = { table, count };
    }
  }
  return found;
}

/**
 * Rows for the tables of weighted steps, for a plan that is only printed.
 *
 * `pg_class.reltuples` answers when the table has been analyzed. A table that
 * has not (`-1`) gets the bounded probe. A table the target does not have yet
 * is empty. A target that cannot be probed leaves the table out.
 *
 * @param url - Target URL
 * @param schema - Schema the plan qualifies
 * @param steps - Steps of the plan
 * @param estimates - `reltuples` per table
 * @returns Rows per table
 */
export async function planCounts(
  url: string,
  schema: string,
  steps: readonly PlanStep[],
  estimates: ReadonlyMap<string, RowEstimate>,
): Promise<ReadonlyMap<string, TableRows>> {
  const out = new Map<string, TableRows>();
  const unknown: string[] = [];
  for (const step of steps) {
    if (step.weight === undefined) continue;
    for (const table of stepTables(step)) {
      const estimate = estimates.get(table);
      if (estimate === undefined) out.set(table, { rows: 0, least: false });
      else if (estimate.kind === "rows") out.set(table, { rows: estimate.reltuples, least: false });
      else unknown.push(table);
    }
  }
  if (unknown.length === 0) return out;
  const hits = await probeTarget(
    url,
    schema,
    [...new Set(unknown)].map((table) => ({ table, which: "rows" as const, limit: BLOCKING_ROWS })),
  );
  if (hits === "unreachable") return out;
  for (const hit of hits) out.set(hit.table, rowsFrom(hit.count, undefined));
  return out;
}

/**
 * Stops before the first step when a weighted step would run over the limit.
 *
 * @param execute - Runs one statement on the connection apply holds
 * @param schema - Schema the tables live in
 * @param steps - Weighted steps of the pending units
 * @param allow - `--allow-blocking` was passed
 * @throws OkmError OKM1847, naming each step and the estimate
 */
export async function refuseBlocking(
  execute: Execute,
  schema: string,
  steps: readonly Weighted[],
  allow: boolean,
): Promise<void> {
  if (allow || steps.length === 0) return;
  const counts = await countTables(
    execute,
    schema,
    steps.flatMap((item) => stepTables(item.step)),
  );
  const lines: string[] = [];
  for (const item of steps) {
    const big = widest(item.step, counts);
    if (big === undefined) {
      lines.push(
        `${item.migrationId} step ${String(item.index + 1)}: a ${item.weight} step that names no table I can read, so I cannot count its rows. Write the table as "schema"."table".`,
      );
      continue;
    }
    if (big.count.rows <= BLOCKING_ROWS) continue;
    lines.push(
      `${item.migrationId} step ${String(item.index + 1)}: ${weightPhrase(item.weight, big.table, big.count, exclusionPerMillion(item.step.sql, item.weight))}.`,
    );
  }
  if (lines.length === 0) return;
  throw new OkmError(
    "OKM1847",
    `A step would keep a table from being used while it runs, and the table has more than ${BLOCKING_ROWS.toLocaleString("en-US")} rows.\n${lines.join("\n")}\nNothing was changed.`,
    {
      fix: {
        summary:
          "Apply it in a maintenance window with --allow-blocking. The lock timeout covers waiting for the lock, not the build after it.",
      },
    },
  );
}
