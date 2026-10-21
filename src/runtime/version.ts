/**
 * Optimistic version checks.
 *
 * Loaded on the first update of a `versioned()` table. A plain update does
 * not import it. The check and the bump are one statement: a stale row is
 * not written, and the caller hears category `conflict`.
 */

import type { Statement } from "../contracts/driver.js";
import type { ColumnModel, QuerySchema } from "../dialects/pg/model.js";
import {
  emitWhere,
  fail,
  isRecord,
  projectExpr,
  quote,
  selectedColumns,
  type Indexed,
  type Outputs,
} from "./plan.js";
import { stack } from "./preset-stack.js";
import {
  Sql,
  allowSet,
  emitSet,
  expectOf,
  noteGuarded,
  readClaim,
  rejectDuplicateTargets,
  rejectMixedSets,
  rejectUpdateKeys,
  requireFilter,
  returningOption,
  updateSliceBody,
  writeSet,
  type WriteMods,
} from "./write.js";

/** What {@link planVersioned} hands back to the write path. */
export type VersionPlan = {
  readonly statements: readonly Statement[];
  readonly outputs: Outputs;
  readonly shape: "count" | "rows";
  readonly expect: number | undefined;
  /**
   * Fields the caller tried to write, and the versions they sent.
   *
   * Absent for `version: "any"`. That claim does not check a version, so a
   * miss is an empty row list and not category `conflict`.
   */
  readonly versioned?: {
    readonly fields: readonly string[];
    readonly sent: readonly number[];
  };
};

type Row = {
  readonly where: unknown;
  readonly set: Record<string, unknown>;
  readonly version: number | "any";
};

/**
 * Plans an update that checks `version` and bumps it.
 *
 * A list carries one version per row. `lock: "skip"` with an integer
 * `version` claims rows at that version and leaves locked rows.
 * `version: "any"` with `lock: "skip"` and `limit` skips the check, bumps
 * `version`, and returns the claimed rows. `.all()` is refused. An upsert
 * is refused by the insert planner, not here.
 *
 * @param schema - Connected schema
 * @param table - Target table
 * @param input - `{ where, set, version }` or a per-row list
 * @param options - Returning, expect, signal, timeout
 * @param mods - `.expect`. `.all` is refused
 * @returns One statement, and the versions the caller sent
 */
export function planVersioned(
  schema: QuerySchema,
  table: Indexed,
  input: unknown,
  options: Record<string, unknown>,
  mods: WriteMods,
): VersionPlan {
  if (mods.all !== undefined) {
    fail(
      "OKM1120",
      `update on ${table.model.name} cannot use all() with versioned().`,
      "Pass a per-row list with the version you read for each row.",
    );
  }
  const allow = allowSet(table, options.allow);
  noteGuarded(table, allow, "update");
  const column = versionColumn(table);
  const returning = returningOption(table, options.returning);
  const expect = expectOf(options, mods);
  if (Array.isArray(input) && input.length === 0) {
    return {
      statements: [],
      outputs: outputsOf(undefined),
      shape: "count",
      expect,
      versioned: { fields: [], sent: [] },
    };
  }
  const rows = readRows(schema, table, input, allow, mods, column);
  const claim = Array.isArray(input) ? undefined : isRecord(input) ? readClaim(input) : undefined;
  const anyRow = rows.length === 1 ? rows[0] : undefined;
  if (rows.some((row) => row.version === "any")) {
    if (claim === undefined || anyRow === undefined || anyRow.version !== "any") {
      fail(
        "OKM1120",
        `version: "any" on ${table.model.name} needs lock: "skip" and limit.`,
        'Pass lock: "skip" and limit to claim rows and skip the version check. An ordinary update passes the integer you read.',
      );
    }
    const asked = returningOption(table, options.returning);
    const claimedReturning =
      asked === undefined || asked.length === 0 ? selectedColumns(table, undefined) : asked;
    const claimed = anyClaimStatement(schema, table, anyRow, claim, column, claimedReturning);
    if ((claimed.params?.length ?? 0) > 30_000) {
      fail(
        "OKM1120",
        `update on ${table.model.name} is too large to claim in one statement.`,
        "Lower limit, or narrow the filter.",
      );
    }
    return {
      statements: [claimed],
      outputs: outputsOf(claimedReturning, 0),
      shape: "rows",
      expect,
    };
  }
  const fields = writtenFields(rows);
  const sent = rows.map((row) => readChecked(row, table.model.name));
  const statement =
    claim !== undefined
      ? claimStatement(schema, table, rows[0], claim, column, returning)
      : targetStatement(schema, table, rows, column, returning);
  const width = statement.params?.length ?? 0;
  if (width > 30_000) {
    fail(
      "OKM1120",
      `update on ${table.model.name} is too large to check version in one statement.`,
      "Split the list.",
    );
  }
  return {
    statements: [statement],
    outputs: outputsOf(returning),
    shape: returning === undefined ? "count" : "rows",
    expect,
    versioned: { fields, sent },
  };
}

function versionColumn(table: Indexed): ColumnModel {
  const column = table.columns.get("version");
  if (column === undefined) {
    fail("OKM1120", `Table ${table.model.name} is versioned and has no version column.`);
  }
  return column;
}

function readRows(
  schema: QuerySchema,
  table: Indexed,
  input: unknown,
  allow: ReadonlySet<string>,
  mods: WriteMods,
  column: ColumnModel,
): readonly Row[] {
  if (Array.isArray(input)) {
    if (input.length === 0) fail("OKM1120", "update set is empty.");
    const rows = input.map((item) => readRow(schema, table, item, allow, mods, column, true));
    rejectDuplicateTargets(table, rows);
    rejectMixedSets(rows);
    return rows;
  }
  return [readRow(schema, table, input, allow, mods, column, false)];
}

function readRow(
  schema: QuerySchema,
  table: Indexed,
  input: unknown,
  allow: ReadonlySet<string>,
  mods: WriteMods,
  column: ColumnModel,
  row: boolean,
): Row {
  if (!isRecord(input))
    fail("OKM1121", "update expects { where, set, version } or a list of rows.");
  rejectUpdateKeys(input, row);
  if (isRecord(input.set) && Object.hasOwn(input.set, "version")) {
    fail(
      "OKM1120",
      `update on ${table.model.name} cannot set version.`,
      "Leave version out of set. The write bumps it.",
    );
  }
  if (!Object.hasOwn(input, "version")) {
    fail(
      "OKM1120",
      `update on ${table.model.name} needs the version you read.`,
      "Pass version from the row you read. If this write conflicts, reread and retry.",
    );
  }
  const version = readVersion(input.version, table.model.name, column);
  const set = writeSet(table, input.set, allow, schema.tenancy);
  if (Object.keys(set).length === 0) fail("OKM1120", "update set is empty.");
  refusePath(schema, table, set);
  const where =
    input.where !== undefined ? input.where : input.id !== undefined ? { id: input.id } : undefined;
  requireFilter(table, where, mods, "update");
  return { where: stack(where, mods.presets), set, version };
}

function readVersion(value: unknown, table: string, column: ColumnModel): number | "any" {
  if (value === "any") return "any";
  if (typeof value === "string") {
    fail(
      "OKM1120",
      `version on ${table} must be an integer or "any". ${value} is not a version.`,
      'Pass the version you read, or version: "any" with lock: "skip" and limit.',
    );
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("OKM1121", `version on ${table} must be an integer.`, "Pass the version you read.");
  }
  column.encode(value);
  return value;
}

/**
 * The integer a checked update sent.
 *
 * `version: "any"` is rejected here. The claim branch handles it first.
 *
 * @param row - One planned update
 * @param table - Table name, for the refusal
 * @returns The version the caller read
 */
function readChecked(row: Row, table: string): number {
  if (row.version !== "any") return row.version;
  fail(
    "OKM1120",
    `version: "any" on ${table} needs lock: "skip" and limit.`,
    'Pass lock: "skip" and limit to claim rows and skip the version check. An ordinary update passes the integer you read.',
  );
}

function refusePath(schema: QuerySchema, table: Indexed, set: Record<string, unknown>): void {
  if (schema.tenancy?.isPath?.(table.model.name) !== true) return;
  const field = schema.tenancy.pathOf?.(table.model.name)?.[0]?.localField;
  if (field === undefined || !Object.hasOwn(set, field)) return;
  fail(
    "OKM1120",
    `update on ${table.model.name} cannot change ${field} and check version in one write.`,
    "Point it at a parent in a later update.",
  );
}

function writtenFields(rows: readonly Row[]): readonly string[] {
  const names: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.set)) if (!names.includes(key)) names.push(key);
  }
  return names;
}

function targetStatement(
  schema: QuerySchema,
  table: Indexed,
  rows: readonly Row[],
  column: ColumnModel,
  returning: readonly ColumnModel[] | undefined,
): Statement {
  const sql = new Sql();
  sql.text("with ");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (index > 0) sql.text(", ");
    sql.text("m");
    sql.text(String(index));
    sql.text(" as (select s.ctid as tid, s.tableoid as toid, s.");
    sql.text(quote(column.sql));
    sql.text(" as okm_version from ");
    sql.text(quote(table.model.sql));
    sql.text(" as s");
    emitWhere(schema, table, row.where, sql.sink(), "s", 0);
    sql.text(" for update of s)");
  }
  sql.text(", gate as (select count(*)::int as n from (");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (index > 0) sql.text(" union all ");
    sql.text("select 1 from m");
    sql.text(String(index));
    sql.text(" where okm_version is distinct from ");
    sql.param(column.encode(readChecked(row, table.model.name)), column.dataType);
  }
  sql.text(") as okm_diff), updated as (");
  updateSliceBody(schema, table, rows, sql, true, {
    afterWhere(body, index) {
      const row = rows[index];
      if (row === undefined) return;
      body.text(" and t.");
      body.text(quote(column.sql));
      body.text(" = ");
      body.param(column.encode(readChecked(row, table.model.name)), column.dataType);
    },
    afterSet(body) {
      bump(body, column);
    },
  });
  sql.text(" and (select n from gate) = 0");
  closeUpdated(sql, returning, "gate");
  return sql.statement();
}

/**
 * Claims rows at one integer version.
 *
 * This is not the `version: "any"` shape. It locks `ctid` in `claimed`, locks
 * again in `stale_free`, and does not repeat the caller's predicate on an
 * `UPDATE ... FROM`. A free row at a different version is category `conflict`.
 *
 * @param schema - Connected schema
 * @param table - Target table
 * @param row - The single update
 * @param limit - How many free rows to take
 * @param column - The `version` column
 * @param returning - Columns to return. Absent is a count
 * @returns The claim statement
 */
function claimStatement(
  schema: QuerySchema,
  table: Indexed,
  row: Row | undefined,
  limit: number,
  column: ColumnModel,
  returning: readonly ColumnModel[] | undefined,
): Statement {
  if (row === undefined) fail("OKM1120", "update set is empty.");
  const sql = new Sql();
  sql.text("with claimed as (select s.tableoid as toid, s.ctid as tid from ");
  sql.text(quote(table.model.sql));
  sql.text(" as s");
  emitWhere(schema, table, row.where, sql.sink(), "s", 0);
  sql.text(" and s.");
  sql.text(quote(column.sql));
  sql.text(" = ");
  sql.param(column.encode(readChecked(row, table.model.name)), column.dataType);
  sql.text(" for update of s skip locked limit ");
  sql.param(String(limit), "integer");
  sql.text("), stale_free as (select 1 as hit from ");
  sql.text(quote(table.model.sql));
  sql.text(" as s");
  emitWhere(schema, table, row.where, sql.sink(), "s", 0);
  sql.text(" and s.");
  sql.text(quote(column.sql));
  sql.text(" is distinct from ");
  sql.param(column.encode(readChecked(row, table.model.name)), column.dataType);
  sql.text(" for update of s skip locked limit 1), updated as (update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  emitSet(sql, table, row.set, "t");
  bump(sql, column);
  sql.text(" where (t.tableoid, t.ctid) in (select toid, tid from claimed)");
  closeUpdated(sql, returning, "claim");
  return sql.statement();
}

/**
 * Claims up to `limit` rows without checking `version`, then bumps it.
 *
 * One lock step: the CTE selects the primary key `ORDER BY` that key,
 * `LIMIT n`, `FOR UPDATE SKIP LOCKED`. The `UPDATE ... FROM` repeats the
 * caller's predicate, so a row whose state changed under `READ COMMITTED`
 * is dropped and the statement never updates more than `limit` rows.
 * `RETURNING` is the new row, including `version + 1`. An empty match
 * returns no rows.
 *
 * @param schema - Connected schema
 * @param table - Target table
 * @param row - The claim. `version` is `"any"`
 * @param limit - How many free rows to take
 * @param column - The `version` column
 * @param returning - Columns the caller receives. Includes `version` by default
 * @returns The claim statement
 */
function anyClaimStatement(
  schema: QuerySchema,
  table: Indexed,
  row: Row,
  limit: number,
  column: ColumnModel,
  returning: readonly ColumnModel[],
): Statement {
  const keys = primaryColumns(table);
  const sql = new Sql();
  sql.text("with claimed as (select ");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (index > 0) sql.text(", ");
    sql.text("s.");
    sql.text(quote(key.sql));
    sql.text(" as okm_");
    sql.text(String(index));
  }
  sql.text(" from ");
  sql.text(quote(table.model.sql));
  sql.text(" as s");
  emitWhere(schema, table, row.where, sql.sink(), "s", 0);
  sql.text(" order by ");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (index > 0) sql.text(", ");
    sql.text("s.");
    sql.text(quote(key.sql));
  }
  sql.text(" limit ");
  sql.param(String(limit), "integer");
  sql.text(" for update of s skip locked) update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  emitSet(sql, table, row.set, "t");
  bump(sql, column);
  sql.text(" from claimed where ");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (index > 0) sql.text(" and ");
    sql.text("t.");
    sql.text(quote(key.sql));
    sql.text(" = claimed.okm_");
    sql.text(String(index));
  }
  emitWhere(schema, table, row.where, sql.sink(), "t", 0, true);
  sql.text(returningClause(returning));
  return sql.statement();
}

/**
 * Primary-key columns the `version: "any"` claim locks and joins.
 *
 * @param table - Target table
 * @returns Those columns, in catalog order
 */
function primaryColumns(table: Indexed): readonly ColumnModel[] {
  const columns: ColumnModel[] = [];
  for (const field of table.model.primary) {
    const column = table.columns.get(field);
    if (column === undefined) {
      fail(
        "OKM1120",
        `version: "any" on ${table.model.name} needs a primary key.`,
        "Add a primary key. The claim locks those columns and updates the same rows.",
      );
    }
    columns.push(column);
  }
  if (columns.length === 0) {
    fail(
      "OKM1120",
      `version: "any" on ${table.model.name} needs a primary key.`,
      "Add a primary key. The claim locks those columns and updates the same rows.",
    );
  }
  return columns;
}

/**
 * `RETURNING` for a `version: "any"` claim.
 *
 * The list is the new row. `version` is the bumped value.
 *
 * @param columns - Columns to project from `t`
 * @returns The clause, including the leading space
 */
function returningClause(columns: readonly ColumnModel[]): string {
  if (columns.length === 0) return "";
  const parts = columns.map((column) => projectExpr(`t.${quote(column.sql)}`, column.dataType));
  return ` returning ${parts.join(", ")}`;
}

function bump(sql: Sql, column: ColumnModel): void {
  sql.text(", ");
  sql.text(quote(column.sql));
  sql.text(" = t.");
  sql.text(quote(column.sql));
  sql.text(" + 1");
}

/**
 * Closes `updated` and returns the stale flag plus the write.
 *
 * `source` is `gate` for a targeted update and `claim` when the flag depends
 * on whether the claim changed a row.
 *
 * @param sql - Statement being built. `updated` is still open
 * @param returning - Columns the caller asked for. Absent is a count
 * @param source - Which stale flag to select
 */
function closeUpdated(
  sql: Sql,
  returning: readonly ColumnModel[] | undefined,
  source: "gate" | "claim",
): void {
  const stale =
    source === "gate"
      ? "(select n from gate)"
      : "(case when (select count(*) from updated) > 0 then 0 else (select count(*)::int from stale_free) end)";
  if (returning === undefined || returning.length === 0) {
    sql.text(" returning 1) select ");
    sql.text(stale);
    sql.text(", (select count(*)::int from updated)");
    return;
  }
  sql.text(" returning t.ctid as okm_tid");
  for (let index = 0; index < returning.length; index += 1) {
    const column = returning[index];
    if (column === undefined) continue;
    sql.text(", ");
    sql.text(projectExpr(`t.${quote(column.sql)}`, column.dataType));
    sql.text(" as okm_");
    sql.text(String(index));
  }
  sql.text(") select ");
  sql.text(stale);
  sql.text(", case when u.okm_tid is null then 0 else 1 end");
  for (let index = 0; index < returning.length; index += 1) {
    sql.text(", u.okm_");
    sql.text(String(index));
  }
  sql.text(" from (select 1) as okm_one left join updated u on true");
}

function outputsOf(columns: readonly ColumnModel[] | undefined, at = 2): Outputs {
  const list = columns ?? [];
  return {
    fields: list.map((column, index) => ({
      key: column.field,
      at: index + at,
      decode: column.decode,
    })),
    includes: [],
  };
}
