/**
 * `archive` and `restore`.
 *
 * Loaded on the first call. A failed import fails that call. The active-set
 * predicate stays in the planner, so a failed import does not show archived rows.
 */

import type { ExecuteOptions, ExecuteResult } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import type { ArchiveLink, QuerySchema } from "../dialects/pg/model.js";
import { isOperator } from "../dialects/pg/operators.js";
import {
  archiveRules,
  emitWhere,
  fail,
  indexes,
  isRecord,
  quote,
  registerFailFix,
  rejectKeys,
  withRowFilters,
  type ArchiveView,
  type CallScope,
  type Indexed,
} from "./plan.js";
import { stack } from "./preset-stack.js";
import { runSafety, safetyInstalled } from "./safety-hook.js";
import { runWrite, type RunHost } from "./tx.js";
import type { PreparedWrite } from "./write.js";

registerFailFix("OKM1102", "Pass where, or call .all(reason) to match every row.");

type LifecycleOp = "archive" | "restore";

type Mods = {
  readonly all?: string;
  readonly expect?: number;
  /** Filters the chained presets added. The archive handle resolves them. */
  readonly presets?: readonly unknown[];
};

type Host = RunHost & {
  readonly schema: QuerySchema;
};

const OPTIONS = ["allow", "expect", "returning", "signal", "timeout"] as const;

/**
 * Archives or restores matching rows.
 *
 * One statement. Cascaded children share the `archiveId`. A restore whose
 * parent is still archived changes nothing and fails.
 *
 * @param host - Schema and pool
 * @param op - `archive` or `restore`
 * @param table - Table name
 * @param input - `{ where }` or, for restore, `{ archiveId }`
 * @param options - `expect`, signal, and timeout
 * @param mods - `.all` and `.expect`
 * @param scope - Tenant value, when the schema has tenancy
 * @returns `{ count, archiveId }` or `{ count }`
 */
export async function executeArchive(
  host: Host,
  op: LifecycleOp,
  table: string,
  input: unknown,
  options: object,
  mods: Mods,
  scope: CallScope | undefined,
): Promise<{ readonly count: number; readonly archiveId?: string }> {
  const prepared = prepareArchive(host.schema, op, table, input, options, mods, scope);
  const results = await runWrite(host, prepared.statements, prepared.options);
  return prepared.finish(results) as { readonly count: number; readonly archiveId?: string };
}

/**
 * Plans archive or restore and returns its statement and the function that decodes the result.
 *
 * `batch` runs the statement with those of other operations.
 *
 * @param schema - Connected schema
 * @param op - `archive` or `restore`
 * @param table - Table name
 * @param input - `{ where }` or `{ archiveId }`
 * @param options - `expect`, signal, and timeout
 * @param mods - `.all` and `.expect`
 * @param scope - Tenant value, when the schema has tenancy
 * @returns The statement, the call options, and `finish`
 */
export function prepareArchive(
  schema: QuerySchema,
  op: LifecycleOp,
  table: string,
  input: unknown,
  options: object,
  mods: Mods,
  scope: CallScope | undefined,
): PreparedWrite {
  const planned = planArchive(schema, op, table, input, options, mods, scope);
  return {
    statements: [{ text: planned.text, params: planned.params }],
    options: planned.call,
    finish: (results) => finish(op, table, results[0] as ExecuteResult, planned),
  };
}

/**
 * Plans archive or restore and does not run it.
 *
 * @param schema - Connected schema
 * @param op - `archive` or `restore`
 * @param table - Table name
 * @param input - `{ where }` or `{ archiveId }`
 * @param options - `expect`, signal, and timeout
 * @param mods - `.all` and `.expect`
 * @param scope - Tenant value, when the schema has tenancy
 * @returns The statement
 */
export function explainArchive(
  schema: QuerySchema,
  op: LifecycleOp,
  table: string,
  input: unknown,
  options: object,
  mods: Mods,
  scope: CallScope | undefined,
): {
  readonly statements: readonly {
    readonly text: string;
    readonly params: readonly (string | null)[];
  }[];
} {
  const planned = planArchive(schema, op, table, input, options, mods, scope);
  return { statements: [{ text: planned.text, params: planned.params }] };
}

type Planned = {
  readonly text: string;
  readonly params: readonly (string | null)[];
  readonly expect: number | undefined;
  readonly archiveId: string | undefined;
  readonly call: ExecuteOptions | undefined;
};

function planArchive(
  schema: QuerySchema,
  op: LifecycleOp,
  tableName: string,
  input: unknown,
  options: object,
  mods: Mods,
  scope: CallScope | undefined,
): Planned {
  const table = indexes(schema).get(tableName);
  if (table === undefined) fail("OKM1120", `Table ${tableName} is not in the schema.`);
  const archive = table.model.archive;
  if (archive === undefined) {
    throw new OkmError("OKM1052", `Table ${tableName} is not archivable.`, {
      fix: { summary: "Call archive and restore only on an archivable table." },
    });
  }
  const record = isRecord(options) ? options : {};
  rejectKeys(record, OPTIONS, op);
  const expect = expectOf(record.expect ?? mods.expect);
  const read = readTarget(op, table, input, mods);
  const target = { ...read, where: stack(read.where, mods.presets) };
  const view: ArchiveView | undefined = op === "restore" ? "only" : undefined;
  noteArchive(table, view);
  const statement = withRowFilters(scope, view, () =>
    op === "archive" ? archiveSql(schema, table, target.where) : restoreSql(schema, table, target),
  );
  return {
    text: statement.text,
    params: statement.params,
    expect,
    archiveId: op === "archive" ? statement.archiveId : undefined,
    call: callOptions(record),
  };
}

function noteArchive(table: Indexed, view: ArchiveView | undefined): void {
  if (!safetyInstalled()) return;
  const rules = archiveRules(table.model, view);
  if (rules === undefined) return;
  runSafety(rules, undefined);
}

type Target = {
  readonly where: unknown;
  readonly archiveId: string | undefined;
};

function readTarget(op: LifecycleOp, table: Indexed, input: unknown, mods: Mods): Target {
  if (!isRecord(input)) fail("OKM1121", `${op} expects { where }.`);
  const keys = Object.keys(input);
  if (op === "restore" && input.archiveId !== undefined) {
    if (input.where !== undefined) fail("OKM1120", "restore takes where or archiveId, not both.");
    for (const key of keys) {
      if (key !== "archiveId") {
        fail("OKM1120", "restore accepts where or archiveId.");
      }
    }
    if (typeof input.archiveId !== "string" || input.archiveId.length === 0) {
      fail("OKM1121", "restore archiveId must be a uuid.");
    }
    const idField = table.model.archive?.idField ?? "archiveId";
    return { where: { [idField]: input.archiveId }, archiveId: input.archiveId };
  }
  for (const key of keys) {
    if (key !== "where") fail("OKM1120", `${op} accepts where.`);
  }
  requireFilter(table, input.where, mods, op);
  return { where: input.where, archiveId: undefined };
}

function archiveSql(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
): { readonly text: string; readonly params: (string | null)[]; readonly archiveId: string } {
  const archive = table.model.archive;
  if (archive === undefined) {
    throw new OkmError("OKM1052", `Table ${table.model.name} is not archivable.`);
  }
  const archiveId = globalThis.crypto.randomUUID();
  const sql = new Sql();
  const cascade = archive.cascade;
  if (cascade.length === 0) {
    sql.text("update ");
    sql.text(quote(table.model.sql));
    sql.text(" as t set ");
    sql.text(quote(archive.at));
    sql.text(" = now(), ");
    sql.text(quote(archive.id));
    sql.text(" = ");
    sql.param(archiveId);
    sql.text("::uuid");
    emitWhere(schema, table, where, sql, "t", 0);
    return { text: sql.join(), params: sql.params, archiveId };
  }
  const returned = returnedColumns(table, cascade);
  sql.text("with archived as (update ");
  sql.text(quote(table.model.sql));
  sql.text(" as t set ");
  sql.text(quote(archive.at));
  sql.text(" = now(), ");
  sql.text(quote(archive.id));
  sql.text(" = ");
  sql.param(archiveId);
  sql.text("::uuid");
  emitWhere(schema, table, where, sql, "t", 0);
  sql.text(" returning ");
  sql.text(returned.map((column) => `t.${quote(column)}`).join(", "));
  sql.text(")");
  for (let index = 0; index < cascade.length; index += 1) {
    const child = cascade[index];
    if (child === undefined) continue;
    sql.text(", c");
    sql.text(String(index));
    sql.text(" as (");
    childUpdate(schema, sql, child, "archived");
    sql.text(")");
  }
  sql.text(" select count(*)::text from archived");
  return { text: sql.join(), params: sql.params, archiveId };
}

function restoreSql(
  schema: QuerySchema,
  table: Indexed,
  target: Target,
): { readonly text: string; readonly params: (string | null)[]; readonly archiveId: string } {
  const archive = table.model.archive;
  if (archive === undefined) {
    throw new OkmError("OKM1052", `Table ${table.model.name} is not archivable.`);
  }
  const parents = archive.parents;
  const cascade = archive.cascade;
  const sql = new Sql();
  if (parents.length === 0 && cascade.length === 0) {
    sql.text("update ");
    sql.text(quote(table.model.sql));
    sql.text(" as t set ");
    sql.text(quote(archive.at));
    sql.text(" = null, ");
    sql.text(quote(archive.id));
    sql.text(" = null");
    emitWhere(schema, table, target.where, sql, "t", 0);
    return { text: sql.join(), params: sql.params, archiveId: "" };
  }
  const pk = primarySql(table);
  const selected = new Set<string>(pk);
  for (const parent of parents) for (const column of parent.local) selected.add(column);
  for (const child of cascade) for (const column of child.remote) selected.add(column);
  selected.delete(archive.id);
  sql.text("with target as (select ");
  sql.text([...selected].map((column) => `t.${quote(column)}`).join(", "));
  sql.text(", t.");
  sql.text(quote(archive.id));
  sql.text(' as "archive_id" from ');
  sql.text(quote(table.model.sql));
  sql.text(" t");
  emitWhere(schema, table, target.where, sql, "t", 0);
  sql.text(")");
  if (parents.length > 0) {
    sql.text(", blocked as (");
    for (let index = 0; index < parents.length; index += 1) {
      const parent = parents[index];
      if (parent === undefined) continue;
      if (index > 0) sql.text(" union all ");
      sql.text("select ");
      sql.text(quoteLiteral(parent.table));
      sql.text(" as parent from target x join ");
      sql.text(quote(parent.sql));
      sql.text(" p on ");
      sql.text(joinOn("p", parent.remote, "x", parent.local));
      sql.text(" where p.");
      sql.text(quote(parent.at));
      sql.text(" is not null");
    }
    sql.text(")");
  }
  sql.text(", restored as (update ");
  sql.text(quote(table.model.sql));
  sql.text(" as u set ");
  sql.text(quote(archive.at));
  sql.text(" = null, ");
  sql.text(quote(archive.id));
  sql.text(" = null from target x where ");
  sql.text(joinOn("u", pk, "x", pk));
  if (parents.length > 0) sql.text(" and not exists (select 1 from blocked)");
  sql.text(" returning ");
  sql.text(
    [...new Set([...pk, ...cascade.flatMap((child) => [...child.remote])])]
      .map((column) => `x.${quote(column)}`)
      .join(", "),
  );
  sql.text(', x."archive_id")');
  for (let index = 0; index < cascade.length; index += 1) {
    const child = cascade[index];
    if (child === undefined) continue;
    sql.text(", c");
    sql.text(String(index));
    sql.text(" as (");
    childRestore(sql, child, parents.length > 0);
    sql.text(")");
  }
  if (parents.length > 0) {
    sql.text(
      " select coalesce((select parent from blocked order by parent limit 1), ''), (select count(*)::text from restored)",
    );
  } else {
    sql.text(" select '', count(*)::text from restored");
  }
  return { text: sql.join(), params: sql.params, archiveId: "" };
}

function childUpdate(schema: QuerySchema, sql: Sql, child: ArchiveLink, parent: string): void {
  const indexed = indexes(schema).get(child.table);
  sql.text("update ");
  sql.text(quote(child.sql));
  sql.text(" as c set ");
  sql.text(quote(child.at));
  sql.text(" = now(), ");
  sql.text(quote(child.id));
  sql.text(" = $1::uuid from ");
  sql.text(parent);
  sql.text(" a where ");
  sql.text(joinOn("c", child.local, "a", child.remote));
  if (indexed === undefined) {
    sql.text(" and c.");
    sql.text(quote(child.at));
    sql.text(" is null");
    return;
  }
  emitWhere(schema, indexed, undefined, sql, "c", 0, true);
}

function childRestore(sql: Sql, child: ArchiveLink, blocked: boolean): void {
  sql.text("update ");
  sql.text(quote(child.sql));
  sql.text(" as c set ");
  sql.text(quote(child.at));
  sql.text(" = null, ");
  sql.text(quote(child.id));
  sql.text(" = null from restored r where ");
  sql.text(joinOn("c", child.local, "r", child.remote));
  sql.text(" and c.");
  sql.text(quote(child.id));
  sql.text(' = r."archive_id" and c.');
  sql.text(quote(child.at));
  sql.text(" is not null");
  if (blocked) sql.text(" and not exists (select 1 from blocked)");
}

function returnedColumns(table: Indexed, cascade: readonly ArchiveLink[]): readonly string[] {
  const names = [...primarySql(table)];
  for (const child of cascade) {
    for (const column of child.remote) if (!names.includes(column)) names.push(column);
  }
  return names;
}

function primarySql(table: Indexed): readonly string[] {
  const names: string[] = [];
  for (const field of table.model.primary) {
    const column = table.columns.get(field);
    if (column !== undefined) names.push(column.sql);
  }
  return names;
}

function joinOn(
  left: string,
  leftColumns: readonly string[],
  right: string,
  rightColumns: readonly string[],
): string {
  const parts: string[] = [];
  for (let index = 0; index < leftColumns.length; index += 1) {
    const local = leftColumns[index];
    const remote = rightColumns[index];
    if (local === undefined || remote === undefined) continue;
    parts.push(`${left}.${quote(local)} = ${right}.${quote(remote)}`);
  }
  return parts.length === 0 ? "true" : parts.join(" and ");
}

function finish(
  op: LifecycleOp,
  table: string,
  result: ExecuteResult,
  planned: Planned,
): { readonly count: number; readonly archiveId?: string } {
  if (op === "restore") {
    const parent = result.rows[0]?.[0];
    if (typeof parent === "string" && parent.length > 0) {
      throw new OkmError(
        "invalid",
        `restore on ${table} references archived ${parent}. Restore ${parent} first.`,
        {
          kind: "invalid",
          table,
          fix: { summary: `Restore ${parent} before this row.` },
        },
      );
    }
  }
  const count = countOf(op, result, planned);
  if (planned.expect !== undefined && count !== planned.expect) {
    throw new OkmError(
      "not_found",
      `${op} on ${table} changed ${String(count)} rows. expect was ${String(planned.expect)}.`,
      {
        kind: "not_found",
        table,
        fix: { summary: "Change the filter, or pass the count this write produced." },
      },
    );
  }
  if (op === "archive") return { count, archiveId: planned.archiveId ?? "" };
  return { count };
}

function countOf(op: LifecycleOp, result: ExecuteResult, planned: Planned): number {
  if (op === "restore" && result.rows.length > 0) {
    const cell = result.rows[0]?.[1] ?? result.rows[0]?.[0];
    if (cell !== undefined && cell !== null && result.rows[0]?.length === 2) return readCount(cell);
  }
  if (result.rows.length === 1 && result.rows[0]?.length === 1) {
    const cell = result.rows[0][0];
    if (cell !== undefined && cell !== null && planned.text.includes("count(*)"))
      return readCount(cell);
  }
  return result.count;
}

function readCount(cell: string): number {
  const count = Number(cell);
  return Number.isInteger(count) ? count : 0;
}

function expectOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OkmError("invalid", "expect must be an integer from 0 up.", { kind: "invalid" });
  }
  return value;
}

function requireFilter(table: Indexed, where: unknown, mods: Mods, op: LifecycleOp): void {
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

function callOptions(input: Record<string, unknown>): ExecuteOptions | undefined {
  const signal = input.signal;
  const timeout = input.timeout;
  if (signal === undefined && timeout === undefined) return undefined;
  return {
    ...(signal !== undefined ? { signal: signal as AbortSignal } : {}),
    ...(typeof timeout === "number" ? { timeout } : {}),
  };
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

class Sql {
  private readonly parts: string[] = [];
  readonly params: (string | null)[] = [];

  text(value: string): void {
    this.parts.push(value);
  }

  param(encoded: string): void {
    this.params.push(encoded);
    this.parts.push(`$${String(this.params.length)}`);
  }

  mark(): void {}

  join(): string {
    return this.parts.join("");
  }
}
