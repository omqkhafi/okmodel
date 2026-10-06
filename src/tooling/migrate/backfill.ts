/**
 * Backfill step header and the per-batch predicate (D195).
 *
 * The migration file keeps one `UPDATE`. `-- backfill` names the table, the
 * primary key, and the batch size. `$1` is the exclusive lower bound and `$2`
 * is the inclusive upper bound. Null means that side is open. The runner
 * fills those bounds. This module does not run the batches.
 */

import type { Catalog } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";

/**
 * Rows in one batch when the plan and the config omit `batchSize`.
 *
 * A step header `batch=` replaces this for that step.
 */
export const DEFAULT_BACKFILL_BATCH_SIZE = 1_000;

/**
 * Milliseconds to wait after a committed batch when the config omits `pauseMs`.
 *
 * Zero runs the next batch immediately. Set a pause to rate-limit a large table.
 */
export const DEFAULT_BACKFILL_PAUSE_MS = 0;

/**
 * `statement_timeout` for one batch when the config omits `statementTimeoutMs`.
 *
 * This is separate from the apply timeout on DDL. A timed-out batch rolls
 * back and leaves the previous checkpoint.
 */
export const DEFAULT_BACKFILL_STATEMENT_TIMEOUT_MS = 30_000;

/** One primary-key column, quoted, with the catalog type used as a cast. */
export type BackfillColumn = {
  /** Quoted identifier. */
  readonly quoted: string;
  /** Catalog `dataType`, safe to place after `::`. */
  readonly dataType: string;
};

/**
 * What `-- backfill` records.
 *
 * `key` is quoted identifiers in primary-key order. Types live in the
 * statement's casts, not in the header.
 */
export type BackfillSpec = {
  /** Quoted schema-qualified table, as in the statement. */
  readonly table: string;
  /** Quoted key columns. */
  readonly key: readonly string[];
  /** Rows per batch. The header value, which overrides config. */
  readonly batch: number;
};

const HEADER = /^-- backfill table=(\S+) key=(\S+) batch=(\d+)$/;
const CAST_TYPE = /^[A-Za-z_][\w$ ]*(?:\([^)]*\))?(?:\[\])*$/;

/**
 * Batch size the planner writes into a new step.
 *
 * @param requested - `defineConfig({ backfill: { batchSize } })`, when set
 * @returns A positive integer. The built-in default is 1000
 */
/**
 * Field for {@link resolveBatchSize} when the config may omit it.
 *
 * Exact optional properties reject `batchSize: undefined`.
 *
 * @param batchSize - Configured size, when set
 * @returns `{ batchSize }` or an empty object
 */
export function batchSizeField(
  batchSize: number | undefined,
): { readonly batchSize: number } | Record<string, never> {
  return batchSize === undefined ? {} : { batchSize };
}

/**
 * Batch size the planner writes into a new step.
 *
 * @param requested - `defineConfig({ backfill: { batchSize } })`, when set
 * @returns A positive integer. The built-in default is 1000
 */
export function resolveBatchSize(requested: number | undefined): number {
  const batch = requested ?? DEFAULT_BACKFILL_BATCH_SIZE;
  if (!Number.isInteger(batch) || batch < 1) {
    throw new OkmError("invalid", "backfill.batchSize must be an integer of at least 1.", {
      fix: {
        summary: "Set defineConfig({ backfill: { batchSize } }) to a positive integer.",
      },
    });
  }
  return batch;
}

/**
 * Prints the header comment.
 *
 * @param spec - Table, key, and batch size
 * @returns One line, without a trailing newline
 */
export function formatBackfillHeader(spec: BackfillSpec): string {
  return `-- backfill table=${spec.table} key=${spec.key.join(",")} batch=${String(spec.batch)}`;
}

/**
 * Reads a `-- backfill` line.
 *
 * @param line - One comment line
 * @returns The spec, or `undefined` when the line is not a backfill header
 */
export function parseBackfillHeader(line: string): BackfillSpec | undefined {
  if (!line.startsWith("-- backfill ")) return undefined;
  const match = HEADER.exec(line);
  const table = match?.[1];
  const keyText = match?.[2];
  const batchText = match?.[3];
  const key = keyText === undefined ? [] : splitKey(keyText);
  const batch = batchText === undefined ? Number.NaN : Number(batchText);
  if (table === undefined || key.length === 0 || !Number.isInteger(batch) || batch < 1) {
    throw new OkmError("invalid", "A backfill header needs table=<table> key=<col> batch=<n>.", {
      fix: {
        summary:
          "Write -- backfill table=<table> key=<col[,col]> batch=<n> with a batch of at least 1.",
      },
    });
  }
  return { table, key, batch };
}

/**
 * Primary key of `table`, or OKM1546 when the table has none.
 *
 * A backfill walks this key. It does not count rows and it does not scan.
 *
 * @param catalogs - Before and after catalogs. The first key found wins
 * @param table - Unqualified table name
 * @returns Columns in key order, with cast types
 */
export function primaryKeyColumns(
  catalogs: readonly Catalog[],
  table: string,
): readonly BackfillColumn[] {
  for (const source of catalogs) {
    const columns = keyOn(source, table);
    if (columns !== undefined) return columns;
  }
  throw new OkmError("OKM1546", `Table ${table} has no primary key, so it cannot be backfilled.`, {
    fix: {
      summary: "Add a primary key. A backfill walks that key and does not scan the table.",
    },
  });
}

/**
 * Predicate that limits an idempotent `UPDATE` to one key range.
 *
 * `$1` is exclusive and `$2` is inclusive. Either null leaves that side open.
 * One column compares as itself. A composite key compares as a row, with the
 * bound stored as a JSON array of text.
 *
 * @param columns - Primary key in order
 * @returns SQL fragment with no leading `and`
 */
export function keyRangePredicate(columns: readonly BackfillColumn[]): string {
  for (const column of columns) assertCastType(column.dataType);
  const lower = compareKey(columns, "$1", ">");
  const upper = compareKey(columns, "$2", "<=");
  return `($1::text is null or ${lower}) and ($2::text is null or ${upper})`;
}

/**
 * How many batches `rows` take at `batch` size.
 *
 * Zero rows is zero batches. The count is `ceil(rows / batch)`.
 *
 * @param rows - Estimated row count
 * @param batch - Batch size from the step header
 * @returns The batch count a plan line prints
 */
export function aboutBatchCount(rows: number, batch: number): number {
  if (!Number.isFinite(rows) || batch < 1) return 0;
  const rounded = Math.max(0, Math.round(rows));
  if (rounded === 0) return 0;
  return Math.ceil(rounded / batch);
}

function keyOn(source: Catalog, table: string): readonly BackfillColumn[] | undefined {
  const constraint = source.objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "primaryKey" &&
      object.identity.parent.name === table,
  );
  if (constraint === undefined || constraint.kind !== "constraint") return undefined;
  const columns: BackfillColumn[] = [];
  for (const name of constraint.definition.columns) {
    const column = source.objects.find(
      (object) =>
        object.kind === "column" &&
        object.identity.parent.name === table &&
        object.identity.name === name,
    );
    if (column === undefined || column.kind !== "column") {
      throw new OkmError(
        "OKM1546",
        `Table ${table} primary key column ${name} is not in the catalog.`,
        { fix: { summary: "Keep the primary key columns on the table." } },
      );
    }
    columns.push({ quoted: quoteIdent(name), dataType: column.definition.dataType });
  }
  if (columns.length === 0) return undefined;
  return columns;
}

/**
 * Keyset query that returns the last key of the next batch.
 *
 * `$1` is the previous boundary, null for the first batch. `$2` is
 * `batch - 1`. No row means this batch is the last one.
 *
 * @param table - Quoted schema-qualified table
 * @param columns - Primary key, with cast types
 * @returns One statement
 */
export function boundaryQuery(table: string, columns: readonly BackfillColumn[]): string {
  for (const column of columns) checkedCast(column.dataType);
  const order = columns.map((column) => column.quoted).join(", ");
  const first = columns[0];
  const projected =
    columns.length === 1 && first !== undefined
      ? `${first.quoted}::text`
      : `jsonb_build_array(${columns.map((column) => `${column.quoted}::text`).join(", ")})::text`;
  const lower = `($1::text is null or ${compareKey(columns, "$1", ">")})`;
  // Alias the text so `order by` uses the key columns, not the text output.
  return `select ${projected} as okm_key from ${table} where ${lower} order by ${order} offset $2::bigint limit 1`;
}

/**
 * Cast spelling safe to interpolate after `::`.
 *
 * @param dataType - Catalog or `format_type` spelling
 * @returns The same spelling
 */
export function checkedCast(dataType: string): string {
  assertCastType(dataType);
  return dataType;
}

function compareKey(
  columns: readonly BackfillColumn[],
  param: "$1" | "$2",
  operator: ">" | "<=",
): string {
  const first = columns[0];
  if (first === undefined) return "false";
  if (columns.length === 1) {
    return `${first.quoted} ${operator} ${param}::${first.dataType}`;
  }
  const left = columns.map((column) => column.quoted).join(", ");
  const right = columns
    .map((column, index) => `((${param}::jsonb)->>${String(index)})::${column.dataType}`)
    .join(", ");
  return `(${left}) ${operator} (${right})`;
}

function assertCastType(dataType: string): void {
  if (CAST_TYPE.test(dataType)) return;
  throw new OkmError(
    "OKM1546",
    `Primary key type ${dataType} cannot be used as a backfill bound.`,
    {
      fix: {
        summary: "Use an orderable scalar key. A backfill casts each bound to the key type.",
      },
    },
  );
}

function splitKey(text: string): readonly string[] {
  const names: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      let value = "";
      index += 1;
      let closed = false;
      while (index < text.length) {
        const char = text[index];
        if (char === '"' && text[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }
        if (char === '"') {
          index += 1;
          closed = true;
          break;
        }
        value += char ?? "";
        index += 1;
      }
      if (!closed) return [];
      names.push(quoteIdent(value));
      if (text[index] === ",") index += 1;
      continue;
    }
    const comma = text.indexOf(",", index);
    const end = comma === -1 ? text.length : comma;
    const raw = text.slice(index, end);
    if (raw.length === 0) return [];
    names.push(quoteIdent(raw));
    index = comma === -1 ? text.length : comma + 1;
  }
  return names;
}
