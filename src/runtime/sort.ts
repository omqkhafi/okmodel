/**
 * Position assignment and `move`.
 *
 * Loaded on the first insert or move of a `sortable()` table. Positions are
 * dense positive integers, unique inside the group (and the tenant). The
 * advisory lock is its own statement. The next statement reads positions.
 * Under READ COMMITTED a statement's snapshot is taken when it starts, which
 * is before a lock in that same statement is granted, so a commit that landed
 * while this transaction waited would be invisible.
 */

import type { ExecuteOptions, Statement } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import type { ColumnModel, QuerySchema } from "../dialects/pg/model.js";
import {
  emitWhere,
  fail,
  indexes,
  isRecord,
  quote,
  withRowFilters,
  type ArchiveView,
  type CallScope,
  type Indexed,
} from "./plan.js";
import { runWrite, type RunHost } from "./tx.js";

type Host = RunHost & {
  readonly schema: QuerySchema;
  readonly scope?: CallScope;
  readonly connected?: Promise<void>;
};

type Seen = {
  readonly position: number;
  readonly groupWire: string | null;
  readonly tenants: readonly (string | null)[];
};

/**
 * Inserts rows at the end of their group.
 *
 * The lock statement runs first. The insert then takes `max(position) + n`
 * from a snapshot taken after that lock is held. A writer that bypasses these
 * statements can still race; the unique index rejects a duplicate.
 *
 * @param table - Target table
 * @param columns - Columns the insert already decided to write
 * @param rows - Stamped rows, in call order
 * @param group - Group field, when the trait has one
 * @param tenantFields - Tenant fields stored on this table
 * @returns The lock, then the insert without `returning`
 */
export function insertAtEnd(
  table: Indexed,
  columns: readonly ColumnModel[],
  rows: readonly Record<string, unknown>[],
  group: string | undefined,
  tenantFields: readonly string[] | undefined,
): { readonly lock: Statement; readonly text: string; readonly params: (string | null)[] } {
  const position = requiredColumn(table, "position");
  const groupColumn = group === undefined ? undefined : requiredColumn(table, group);
  const tenants = tenantColumns(table, tenantFields);
  const planned: {
    readonly key: string;
    readonly n: number;
    readonly row: Record<string, unknown>;
  }[] = [];
  const countOf = new Map<string, number>();
  const firstOf = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (groupColumn !== undefined && !Object.hasOwn(row, groupColumn.field)) {
      fail(
        "OKM1121",
        `insert on ${table.model.name} needs ${groupColumn.field} so position has a group.`,
        "Pass the group on the row. Position is assigned for you.",
      );
    }
    const key = lockText(
      table.model.sql,
      wires(tenants, row),
      groupColumn === undefined ? null : cellWire(groupColumn, row[groupColumn.field]),
    );
    if (!firstOf.has(key)) firstOf.set(key, row);
    const n = (countOf.get(key) ?? 0) + 1;
    countOf.set(key, n);
    planned.push({ key, n, row });
  }
  const params: (string | null)[] = [];
  const bind = (wire: string | null, dataType: string): string => {
    params.push(wire);
    return `$${String(params.length)}::${dataType}`;
  };
  const slotOf = new Map<string, string>();
  for (const key of firstOf.keys()) slotOf.set(key, bind(key, "text"));
  const baseRows: string[] = [];
  for (const [key, row] of firstOf) {
    const parts = [slotOf.get(key) ?? bind(key, "text")];
    if (groupColumn !== undefined)
      parts.push(bind(cellWire(groupColumn, row[groupColumn.field]), groupColumn.dataType));
    for (const column of tenants)
      parts.push(bind(cellWire(column, row[column.field]), column.dataType));
    baseRows.push(`(${parts.join(", ")})`);
  }
  const baseNames = ["okm_lock"];
  if (groupColumn !== undefined) baseNames.push("okm_g");
  for (let index = 0; index < tenants.length; index += 1) baseNames.push(`okm_t${String(index)}`);
  const lists = planned.map((item) => {
    const slot = slotOf.get(item.key) ?? bind(item.key, "text");
    const slots = columns.map((column) => cell(column, item.row[column.field], bind));
    slots.push(
      `((select b.pos from base b where b.okm_lock = ${slot}) + ${String(item.n)})::integer`,
    );
    return `(${slots.join(", ")})`;
  });
  const insertColumns = [...columns.map((column) => quote(column.sql)), quote(position.sql)];
  const text = [
    "with base as (",
    "select i.okm_lock, coalesce(max(t.",
    quote(position.sql),
    "), 0) as pos from (values ",
    baseRows.join(", "),
    ") as i(",
    baseNames.join(", "),
    ") left join ",
    quote(table.model.sql),
    " as t on ",
    joinOn(groupColumn, tenants),
    " group by i.okm_lock",
    ") insert into ",
    quote(table.model.sql),
    " (",
    insertColumns.join(", "),
    ") values ",
    lists.join(", "),
  ].join("");
  return { lock: groupLock([...firstOf.keys()]), text, params };
}

/**
 * Moves one row before or after another in the same group.
 *
 * The result is `{ position }` after the move. A missing id is `not_found`.
 * An anchor in another group is OKM1120 and writes nothing. The same id on
 * both sides leaves the row where it is.
 *
 * @param host - Pool and schema
 * @param tableName - Table the trait is on
 * @param id - Primary key of the row to move, without the tenant key
 * @param place - `{ before }` or `{ after }`, the anchor's primary key
 * @param view - Archive visibility, when the handle narrowed it
 * @returns The row's position after the move
 */
export async function move(
  host: Host,
  tableName: string,
  id: unknown,
  place: unknown,
  view: ArchiveView | undefined,
): Promise<{ readonly position: number }> {
  await host.connected;
  const table = indexes(host.schema).get(tableName);
  if (table === undefined) fail("OKM1120", `Table ${tableName} is not in the schema.`);
  const group = groupField(table);
  if (!sortable(table)) {
    fail(
      "OKM1120",
      `move on ${tableName} needs sortable().`,
      "Add sortable() from okmodel/traits.",
    );
  }
  const anchor = readPlace(place, tableName);
  const key = moveColumn(host.schema, table);
  if (sameId(id, anchor.id)) {
    const current = await readOne(host, table, key, id, group, view);
    if (current === undefined) missing(tableName, id);
    return { position: current.position };
  }
  const moved = await readOne(host, table, key, id, group, view);
  if (moved === undefined) missing(tableName, id);
  const other = await readOne(host, table, key, anchor.id, group, view);
  if (other === undefined) missing(tableName, anchor.id);
  if (moved.groupWire !== other.groupWire) {
    const which = group ?? "group";
    throw new OkmError(
      "OKM1120",
      `move on ${tableName} cannot place ${show(id)} ${anchor.side} ${show(anchor.id)}. ${show(anchor.id)} is in another ${which}.`,
      { fix: { summary: `Choose an anchor in the same ${which}.` } },
    );
  }
  const statements = withRowFilters(host.scope, view, () =>
    moveStatements(host.schema, table, key, id, anchor.id, moved, anchor.side, group),
  );
  const results = await runWrite(host, statements, callOptions(host));
  // Index 0 takes the advisory lock and is not the move's counts.
  const row = results[1]?.rows[0];
  if (count(row?.[0]) !== 1) missing(tableName, id);
  if (count(row?.[1]) !== 1) missing(tableName, anchor.id);
  return { position: count(row?.[2]) };
}

function sortable(table: Indexed): boolean {
  const traits = table.model.traits;
  if (traits === undefined) return false;
  for (const trait of traits) if (trait.name === "sortable") return true;
  return false;
}

function groupField(table: Indexed): string | undefined {
  const traits = table.model.traits;
  if (traits === undefined) return undefined;
  for (const trait of traits) {
    if (trait.name !== "sortable") continue;
    const group = (trait as { readonly group?: unknown }).group;
    return typeof group === "string" ? group : undefined;
  }
  return undefined;
}

function readPlace(
  place: unknown,
  table: string,
): { readonly side: "before" | "after"; readonly id: unknown } {
  if (!isRecord(place)) fail("OKM1120", `move on ${table} needs { before } or { after }.`);
  const before = Object.hasOwn(place, "before");
  const after = Object.hasOwn(place, "after");
  if (before === after) {
    fail("OKM1120", `move on ${table} needs before or after, not both.`, "Pass one anchor.");
  }
  for (const key of Object.keys(place)) {
    if (key === "before" || key === "after") continue;
    fail("OKM1120", `move on ${table} does not accept ${key}. Accepted options: before, after.`);
  }
  return { side: before ? "before" : "after", id: before ? place.before : place.after };
}

function moveColumn(schema: QuerySchema, table: Indexed): ColumnModel {
  const tenants = new Set(tenantFieldNames(schema.tenancy, table));
  const fields = table.model.primary.filter((field) => !tenants.has(field));
  if (fields.length !== 1) {
    fail(
      "OKM1120",
      `move on ${table.model.name} needs one primary key column besides the tenant key.`,
    );
  }
  return requiredColumn(table, fields[0] ?? "");
}

function tenantFieldNames(tenancy: QuerySchema["tenancy"], table: Indexed): readonly string[] {
  if (tenancy === undefined) return [];
  const keys = tenancy.keys ?? [tenancy.key];
  return keys.filter((key) => table.columns.has(key));
}

async function readOne(
  host: Host,
  table: Indexed,
  key: ColumnModel,
  id: unknown,
  group: string | undefined,
  view: ArchiveView | undefined,
): Promise<Seen | undefined> {
  const position = requiredColumn(table, "position");
  const groupColumn = group === undefined ? undefined : requiredColumn(table, group);
  const tenants = tenantColumns(table, tenantFieldNames(host.schema.tenancy, table));
  const statement = withRowFilters(host.scope, view, () => {
    const parts: string[] = [];
    const params: (string | null)[] = [];
    parts.push("select ");
    parts.push(quote(position.sql));
    if (groupColumn !== undefined) {
      parts.push(", ");
      parts.push(quote(groupColumn.sql));
    }
    for (const column of tenants) {
      parts.push(", ");
      parts.push(quote(column.sql));
    }
    parts.push(" from ");
    parts.push(quote(table.model.sql));
    parts.push(" as t where t.");
    parts.push(quote(key.sql));
    parts.push(" = $1::");
    parts.push(key.dataType);
    params.push(key.encode(id));
    emitWhere(host.schema, table, undefined, sink(parts, params), "t", 0, true);
    return { text: parts.join(""), params };
  });
  const result = await host.pool.execute(statement.text, statement.params, callOptions(host));
  const found = result.rows[0];
  if (found === undefined) return undefined;
  let at = 1;
  const groupWire = groupColumn === undefined ? null : decodeWire(groupColumn, found[at]);
  if (groupColumn !== undefined) at += 1;
  const tenantWires: (string | null)[] = [];
  for (const column of tenants) {
    tenantWires.push(decodeWire(column, found[at]));
    at += 1;
  }
  return { position: count(found[0]), groupWire, tenants: tenantWires };
}

function moveStatements(
  schema: QuerySchema,
  table: Indexed,
  key: ColumnModel,
  id: unknown,
  anchor: unknown,
  moved: Seen,
  side: "before" | "after",
  group: string | undefined,
): readonly Statement[] {
  const lock = groupLock([lockText(table.model.sql, moved.tenants, moved.groupWire)]);
  const place = moveStatement(schema, table, key, id, anchor, moved, side, group);
  const tenants = tenantColumns(table, tenantFieldNames(schema.tenancy, table));
  return [lock, place, flipStatement(table, moved, group, tenants)];
}

function moveStatement(
  schema: QuerySchema,
  table: Indexed,
  key: ColumnModel,
  id: unknown,
  anchor: unknown,
  moved: Seen,
  side: "before" | "after",
  group: string | undefined,
): Statement {
  const position = requiredColumn(table, "position");
  const groupColumn = group === undefined ? undefined : requiredColumn(table, group);
  const tenants = tenantColumns(table, tenantFieldNames(schema.tenancy, table));
  const params: (string | null)[] = [];
  const bind = (wire: string | null, dataType: string): string => {
    params.push(wire);
    return `$${String(params.length)}::${dataType}`;
  };
  const groupSlot = groupColumn === undefined ? "" : bind(moved.groupWire, groupColumn.dataType);
  const tenantSlots = tenants.map((column, index) =>
    bind(moved.tenants[index] ?? null, column.dataType),
  );
  const movedSlot = bind(key.encode(id), key.dataType);
  const anchorSlot = bind(key.encode(anchor), key.dataType);
  const delta = bind(side === "before" ? "-0.5" : "0.5", "numeric");
  const parts: string[] = [];
  parts.push("with members as (select t.ctid as tid, t.tableoid as toid, t.");
  parts.push(quote(position.sql));
  parts.push(" as pos, t.");
  parts.push(quote(key.sql));
  parts.push(" as ident from ");
  parts.push(quote(table.model.sql));
  parts.push(" as t");
  let filtered = false;
  if (groupColumn !== undefined) {
    parts.push(" where t.");
    parts.push(quote(groupColumn.sql));
    parts.push(" is not distinct from ");
    parts.push(groupSlot);
    filtered = true;
  }
  for (let index = 0; index < tenants.length; index += 1) {
    const column = tenants[index];
    if (column === undefined) continue;
    parts.push(filtered ? " and t." : " where t.");
    parts.push(quote(column.sql));
    parts.push(" is not distinct from ");
    parts.push(tenantSlots[index] ?? "null");
    filtered = true;
  }
  emitWhere(schema, table, undefined, sink(parts, params), "t", 0, filtered);
  parts.push(
    " for update of t), numbered as (select ident, pos, tid, toid, row_number() over (order by pos, ident) as ord from members), placed as (select ident, pos, tid, toid, row_number() over (order by case when ident = ",
  );
  parts.push(movedSlot);
  parts.push(" then (select ord from numbered where ident = ");
  parts.push(anchorSlot);
  parts.push(") + ");
  parts.push(delta);
  parts.push(" else ord end, case when ident = ");
  parts.push(movedSlot);
  parts.push(
    " then 0 else 1 end) as new_pos from numbered where (select count(*) from numbered where ident = ",
  );
  parts.push(movedSlot);
  parts.push(") = 1 and (select count(*) from numbered where ident = ");
  parts.push(anchorSlot);
  parts.push(") = 1), changed as (update ");
  parts.push(quote(table.model.sql));
  parts.push(" as t set ");
  parts.push(quote(position.sql));
  parts.push(
    " = (-p.new_pos)::integer from placed as p where t.ctid = p.tid and t.tableoid = p.toid returning t.ctid) select (select count(*)::int from numbered where ident = ",
  );
  parts.push(movedSlot);
  parts.push("), (select count(*)::int from numbered where ident = ");
  parts.push(anchorSlot);
  parts.push("), coalesce((select new_pos::int from placed where ident = ");
  parts.push(movedSlot);
  parts.push("), 0), (select count(*)::int from changed)");
  return { text: parts.join(""), ...(params.length > 0 ? { params } : {}) };
}

/**
 * Turns the negative positions from {@link moveStatement} back to positive.
 *
 * The unique index is checked per row, so the move writes the new positions
 * as negatives first. This runs in the same batch and sees those rows.
 * A position that was already negative is flipped too: positions stay positive.
 *
 * @param table - Target table
 * @param moved - Group and tenant wires from the row being moved
 * @param group - Group field, when the trait has one
 * @returns The flip
 */
function flipStatement(
  table: Indexed,
  moved: Seen,
  group: string | undefined,
  tenants: readonly ColumnModel[],
): Statement {
  const position = requiredColumn(table, "position");
  const groupColumn = group === undefined ? undefined : requiredColumn(table, group);
  const params: (string | null)[] = [];
  const bind = (wire: string | null, dataType: string): string => {
    params.push(wire);
    return `$${String(params.length)}::${dataType}`;
  };
  const parts = [
    "update ",
    quote(table.model.sql),
    " as t set ",
    quote(position.sql),
    " = (-t.",
    quote(position.sql),
    ")::integer where t.",
    quote(position.sql),
    " < 0",
  ];
  if (groupColumn !== undefined) {
    parts.push(" and t.");
    parts.push(quote(groupColumn.sql));
    parts.push(" is not distinct from ");
    parts.push(bind(moved.groupWire, groupColumn.dataType));
  }
  for (let index = 0; index < tenants.length; index += 1) {
    const column = tenants[index];
    if (column === undefined) continue;
    parts.push(" and t.");
    parts.push(quote(column.sql));
    parts.push(" is not distinct from ");
    parts.push(bind(moved.tenants[index] ?? null, column.dataType));
  }
  return { text: parts.join(""), ...(params.length > 0 ? { params } : {}) };
}

function joinOn(group: ColumnModel | undefined, tenants: readonly ColumnModel[]): string {
  const parts: string[] = [];
  if (group !== undefined) parts.push(`t.${quote(group.sql)} is not distinct from i.okm_g`);
  for (let index = 0; index < tenants.length; index += 1) {
    const column = tenants[index];
    if (column === undefined) continue;
    parts.push(`t.${quote(column.sql)} is not distinct from i.okm_t${String(index)}`);
  }
  return parts.length === 0 ? "true" : parts.join(" and ");
}

function lockText(
  sqlName: string,
  tenants: readonly (string | null)[],
  group: string | null,
): string {
  return JSON.stringify([sqlName, tenants, group]);
}

/**
 * Locks each group key before a later statement reads positions.
 *
 * Keys are taken in sorted order so two inserts that share groups cannot
 * deadlock. The volatile lock runs once per key, in that order.
 *
 * @param keys - Lock text, one per group
 * @returns The lock statement
 */
function groupLock(keys: readonly string[]): Statement {
  const ordered = [...keys].sort(compareText);
  const values = ordered.map((_, index) => `($${String(index + 1)}::text)`).join(", ");
  return {
    text: `select pg_advisory_xact_lock(hashtextextended(k.okm_lock, 0::bigint)) from (select v.okm_lock from (values ${values}) as v(okm_lock) order by v.okm_lock) as k`,
    params: ordered,
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function wires(columns: readonly ColumnModel[], row: Record<string, unknown>): (string | null)[] {
  return columns.map((column) => cellWire(column, row[column.field]));
}

function cellWire(column: ColumnModel, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return column.encode(value);
}

function cell(
  column: ColumnModel,
  value: unknown,
  bind: (wire: string | null, dataType: string) => string,
): string {
  if (value === undefined) return "default";
  if (value === null) return bind(null, column.dataType);
  return bind(column.encode(value), column.dataType);
}

function decodeWire(column: ColumnModel, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const decode = column.decode;
    return column.encode(decode === undefined ? value : decode(value));
  }
  return column.encode(value);
}

function tenantColumns(table: Indexed, fields: readonly string[] | undefined): ColumnModel[] {
  if (fields === undefined) return [];
  const columns: ColumnModel[] = [];
  for (const field of fields) {
    const column = table.columns.get(field);
    if (column !== undefined) columns.push(column);
  }
  return columns;
}

function requiredColumn(table: Indexed, field: string): ColumnModel {
  const column = table.columns.get(field);
  if (column === undefined) fail("OKM1120", `Table ${table.model.name} has no column ${field}.`);
  return column;
}

function missing(table: string, id: unknown): never {
  throw new OkmError("not_found", `move on ${table} could not find ${show(id)}.`, {
    kind: "not_found",
    table,
    fix: { summary: "Pass the id of a row in this table." },
  });
}

function show(id: unknown): string {
  if (typeof id === "string" || typeof id === "number") return String(id);
  return "that id";
}

function sameId(left: unknown, right: unknown): boolean {
  return left === right;
}

function count(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

function sink(
  parts: string[],
  params: (string | null)[],
): { text(value: string): void; param(encoded: string): void; mark(token: string): void } {
  return {
    text(value) {
      parts.push(value);
    },
    param(encoded) {
      params.push(encoded);
      parts.push(`$${String(params.length)}`);
    },
    mark() {},
  };
}

function callOptions(host: Host): ExecuteOptions | undefined {
  const limit = host.timeouts?.statement;
  return limit === undefined ? undefined : { timeout: limit };
}
