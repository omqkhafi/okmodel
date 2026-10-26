/**
 * Keyset pages (spec sections 10 and 12).
 *
 * A page is a `find` with three changes: the order ends in the primary key, the
 * limit is one more than the page size, and an `after` condition replaces
 * offset. The tenant and active-set predicates are the planner's, so they
 * apply to every page the same way. This module loads on the first `page()`.
 *
 * The cursor holds the order it was made for. When that order names no hidden
 * or sensitive column, it also holds the sort values of the last row as the
 * database wrote them. Those are text, not decoded values, so a timestamp
 * keeps its microseconds and no row is skipped or repeated.
 *
 * When the order names a hidden or sensitive column, the cursor holds only the
 * primary key (one value, or a tuple when the key is composite). No sort value
 * of a hidden or sensitive column is stored. The next page reads the sort
 * values back from that row, in the same statement, under the same tenant and
 * archive predicates. A row that is gone is OKM1130. A hidden or sensitive
 * column of a relation uses that same cursor. A visible relation column, or a
 * to-many count, is one more value in the cursor the page already returns.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import { attachHttp, decodeRows, readCall, readHandle, type Mods, type Session } from "./client.js";
import {
  orderItems,
  parseRelationOrder,
  writeOrder,
  writeSortSelect,
  type SortKey,
} from "./order-relation.js";
import {
  emitVisibility,
  fail,
  indexes,
  isRecord,
  list,
  orderNamesRelation,
  parseOrder,
  quote,
  readLimit,
  registerFailFix,
  rejectKeys,
  selectedColumns,
  type Built,
  type Indexed,
  type ArchiveView,
  type Keyset,
  type Plan,
  type Sink,
} from "./plan.js";
import { capLimit } from "./limits.js";

registerFailFix(
  "OKM1130",
  "Request the next page with the same orderBy and the exact next value the previous page returned. The cursor encodes that order.",
);

const OPTIONS = [
  "where",
  "select",
  "orderBy",
  "limit",
  "include",
  "after",
  "ignore",
  "route",
  "signal",
  "timeout",
] as const;

/** A page sort key. A column of this table leaves the relation fields unset. */
type Key = SortKey;

/**
 * Builds the handle for one `page()` call.
 *
 * @param session - Client session
 * @param table - Table name
 * @param options - `where`, `select`, `orderBy`, `limit`, `include`, and `after`
 * @param mods - Signal and timeout
 * @param view - Archive visibility
 * @param pin - Endpoint a stream already chose. Absent for `page()`
 * @returns A handle that resolves to `{ items, next }`
 */
export function build(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
  pin?: { name?: string },
): Promise<unknown> & Record<string, unknown> {
  try {
    return plan(session, table, options, mods, view, pin);
  } catch (error) {
    throw error instanceof OkmError ? attachHttp(session.http, error) : error;
  }
}

function plan(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
  pin?: { name?: string },
): Promise<unknown> & Record<string, unknown> {
  const record: Record<string, unknown> = isRecord(options) ? options : {};
  if (Object.hasOwn(record, "search")) {
    fail(
      "OKM1120",
      "page() does not take search in this version. Use find({ search, limit }) for a ranked list.",
      "Ranked pages are later. find({ search, limit }) returns one ranked list.",
    );
  }
  rejectKeys(record, OPTIONS, "page");
  const indexed = indexes(session.schema).get(table);
  if (indexed === undefined) fail("OKM1120", `Table ${table} is not in the schema.`);
  // `stream()` plans its batches here with a pin. It keeps its own rules.
  const limits = pin === undefined ? session.l : undefined;
  const dflt = record.limit === undefined && mods.all === undefined ? limits?.page : undefined;
  const given = dflt ?? record.limit;
  if (given === undefined) fail("OKM1101", "page() needs a limit.");
  const size = readLimit(given);
  if (mods.all === undefined) capLimit(size, limits?.max);
  if (size < 1) {
    throw new OkmError("invalid", "page() limit must be at least 1.", { kind: "invalid" });
  }
  const parsed = orderNamesRelation(indexed, record.orderBy)
    ? parseRelationOrder(session.schema, indexed, record.orderBy)
    : undefined;
  const keys =
    parsed === undefined ? orderKeys(indexed, record.orderBy) : tieBreak(indexed, parsed.keys);
  const signature = `${table}:${keys.map((key) => `${keyLabel(key)}.${key.dir}.${key.nulls}`).join(",")}`;
  const keyMode = keys.some((key) => keyConcealed(key));
  const pk = primaryColumns(indexed);
  const cursor =
    record.after === undefined || record.after === null
      ? undefined
      : keyMode
        ? readKeyCursor(record.after, signature, pk.length)
        : undefined;
  const after =
    cursor !== undefined
      ? keyCompare(keys, signature)
      : record.after === undefined || record.after === null
        ? undefined
        : keyset(keys, signature, record.after);
  const wanted = selectedColumns(indexed, record.select);
  const pkNames = new Set(indexed.model.primary);
  const extra: string[] = [];
  for (const key of keys) {
    const column = key.column;
    if (key.expr !== undefined || column === undefined || wanted.includes(column)) continue;
    if (keyMode && concealed(column) && !pkNames.has(column.field)) continue;
    extra.push(column.field);
  }
  const select =
    extra.length === 0 ? record.select : [...wanted.map((column) => column.field), ...extra];
  const orderBy: Record<string, unknown> = {};
  if (parsed === undefined) {
    for (const key of keys) {
      const column = key.column;
      if (column === undefined) continue;
      orderBy[column.field] = { dir: key.dir, nulls: key.nulls };
    }
  }
  const slots = keyMode
    ? []
    : keys.flatMap((key) =>
        key.expr !== undefined && key.slot !== undefined && key.dataType !== undefined
          ? [{ expr: key.expr, slot: key.slot, dataType: key.dataType }]
          : [],
      );
  const call = {
    ...readCall(
      "find",
      table,
      {
        where: record.where,
        select,
        orderBy: parsed === undefined ? orderBy : record.orderBy,
        limit: size + 1,
        include: record.include,
        ...(record.ignore !== undefined ? { ignore: record.ignore } : {}),
        signal: record.signal,
        timeout: record.timeout,
        route: record.route,
      },
      undefined,
      session.scope,
      session.schema.model[table],
      session.schema,
      view,
    ),
    ...(parsed === undefined
      ? {}
      : {
          rel: {
            join: (sink: Sink) => parsed.join(sink, "t"),
            order: (sink: Sink) => writeOrder(sink, orderItems(keys, "t")),
            ...(keyMode
              ? {}
              : {
                  select: (sink: Sink, outputs: Built | undefined, at: number) =>
                    writeSortSelect(sink, outputs, at, slots),
                }),
          },
        }),
    ...(after !== undefined ? { after } : {}),
    ...(cursor !== undefined
      ? {
          keyCursor: {
            open(sink: Sink) {
              writeCursorCte(
                sink,
                session,
                indexed,
                keys,
                pk,
                cursor,
                parsed === undefined ? undefined : (inner) => parsed.join(inner, "k"),
              );
            },
            close: writeCursorMiss,
          },
        }
      : {}),
    ...(pin !== undefined ? { pin } : {}),
    size,
    ...(limits !== undefined ? { limits } : {}),
    ...(dflt !== undefined ? { dl: ["page", dflt] as const } : {}),
  };
  return readHandle(session, table, call, mods, async (compiled, rows) => {
    const source = cursor !== undefined ? withoutMissingCursor(rows) : rows;
    const items = (await decodeRows(compiled, source, table)) as Record<string, unknown>[];
    const more = items.length > size;
    const kept = more ? items.slice(0, size) : items;
    const last = source[size - 1];
    const next =
      more && last !== undefined
        ? keyMode
          ? makeKeyCursor(compiled, last, pk, signature)
          : makeCursor(compiled, last, keys, signature)
        : null;
    const dropped = keyMode
      ? extra
      : [
          ...extra,
          ...keys.flatMap((key) =>
            key.expr !== undefined && key.slot !== undefined ? [key.slot] : [],
          ),
        ];
    if (dropped.length > 0) {
      for (const item of kept) {
        for (const field of dropped) delete item[field];
      }
    }
    return { items: kept, next };
  });
}

function keyLabel(key: Key): string {
  return key.label ?? key.column?.field ?? "";
}

function keySlot(key: Key): string {
  return key.slot ?? key.column?.field ?? "";
}

function keyConcealed(key: Key): boolean {
  if (key.expr !== undefined) return key.relationConcealed === true;
  return key.column !== undefined && concealed(key.column);
}

/** The value compared on the page row. A column uses `alias.column`. */
function leftOf(key: Key, alias: string): string {
  if (key.expr !== undefined) return key.expr;
  return `${alias}.${quote(key.column?.sql ?? "")}`;
}

/** The same value on the cursor row `c`. */
function rightOf(key: Key): string {
  if (key.cursor !== undefined) return `c.${quote(key.cursor)}`;
  return `c.${quote(key.column?.sql ?? "")}`;
}

/** One cursor-row column. A relation value is named so the page can compare it. */
function cursorSelect(key: Key): string {
  if (key.expr !== undefined && key.cursor !== undefined) {
    return `${key.expr} as ${quote(key.cursor)}`;
  }
  return `k.${quote(key.column?.sql ?? "")}`;
}

/** `orderBy` as written, then the primary key columns it does not name. */
function orderKeys(table: Indexed, orderBy: unknown): readonly Key[] {
  if (orderBy !== undefined && !isRecord(orderBy)) {
    fail("OKM1120", "orderBy must be an object of fields.");
  }
  const keys: Key[] = [];
  for (const field of Object.keys(orderBy ?? {})) {
    const column = table.columns.get(field);
    if (column === undefined) {
      throwNamed(
        "OKM1120",
        field,
        table.names,
        `Field ${field} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
      );
    }
    keys.push({ column, ...parseOrder(field, orderBy?.[field]) });
  }
  return tieBreak(table, keys);
}

/** Primary-key tie-break. A relation key is not a column of this table. */
function tieBreak(table: Indexed, keys: readonly Key[]): readonly Key[] {
  if (table.model.primary.length === 0) {
    fail("OKM1120", `page() needs a primary key on ${table.model.name} to break ties.`);
  }
  const next = [...keys];
  for (const field of table.model.primary) {
    const column = table.columns.get(field);
    if (
      column === undefined ||
      next.some((key) => key.expr === undefined && key.column === column)
    ) {
      continue;
    }
    next.push({ column, dir: "asc", nulls: "last" });
  }
  return next;
}

/**
 * The `after` condition: rows that sort strictly after the cursor row.
 *
 * It is a list of alternatives, one per key. Alternative `i` holds keys before
 * `i` equal and key `i` later. A null sorts after every value with `nulls:
 * "last"` and before every value with `nulls: "first"`, so nothing is later
 * than a null in a nulls-last key, and every non-null is later than a null in
 * a nulls-first key.
 */
function keyset(keys: readonly Key[], signature: string, token: unknown): Keyset {
  const values = readCursor(token, signature, keys.length);
  return (sink, alias) => {
    sink.mark(`k:${signature}:${values.map((value) => (value === null ? "n" : "v")).join("")}`);
    let wrote = false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = values[index];
      if (key === undefined || value === undefined) continue;
      if (value === null && key.nulls === "last") continue;
      sink.text(wrote ? " or (" : "(");
      wrote = true;
      for (let before = 0; before < index; before += 1) {
        const prior = keys[before];
        const held = values[before];
        if (prior === undefined || held === undefined) continue;
        const ref = leftOf(prior, alias);
        if (held === null) {
          sink.text(`${ref} is null and `);
        } else {
          sink.text(`${ref} = `);
          sink.param(held);
          sink.text(" and ");
        }
      }
      const ref = leftOf(key, alias);
      if (value === null) {
        sink.text(`${ref} is not null`);
      } else {
        sink.text(key.nulls === "last" ? `(${ref} ${compare(key)} ` : `${ref} ${compare(key)} `);
        sink.param(value);
        sink.text(key.nulls === "last" ? ` or ${ref} is null)` : "");
      }
      sink.text(")");
    }
    if (!wrote) sink.text("false");
  };
}

function compare(key: Key): string {
  return key.dir === "asc" ? ">" : "<";
}

function makeCursor(
  plan: Plan,
  row: readonly (string | null)[],
  keys: readonly Key[],
  signature: string,
): string {
  return encodeToken([
    signature,
    ...keys.map((key) => {
      const at = plan.outputs.fields.find((field) => field.key === keySlot(key))?.at;
      return at === undefined ? null : (row[at] ?? null);
    }),
  ]);
}

/** Cursor that names the last row by primary key and carries no sort value. */
function makeKeyCursor(
  plan: Plan,
  row: readonly (string | null)[],
  pk: readonly ColumnModel[],
  signature: string,
): string {
  return encodeToken([KEY_MARK, signature, ...wireValues(plan, row, pk)]);
}

function wireValues(
  plan: Plan,
  row: readonly (string | null)[],
  columns: readonly ColumnModel[],
): (string | null)[] {
  return columns.map((column) => {
    const at = plan.outputs.fields.find((field) => field.key === column.field)?.at;
    return at === undefined ? null : (row[at] ?? null);
  });
}

function encodeToken(value: readonly unknown[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Marker for a primary-key cursor. A value cursor's first slot is the order signature. */
const KEY_MARK = "k";

function concealed(column: ColumnModel): boolean {
  return column.sensitive === true || column.hidden !== false;
}

function primaryColumns(table: Indexed): readonly ColumnModel[] {
  const columns: ColumnModel[] = [];
  for (const field of table.model.primary) {
    const column = table.columns.get(field);
    if (column !== undefined) columns.push(column);
  }
  return columns;
}

/**
 * Compares the page row with the cursor row `c` that the statement joins.
 *
 * Nulls follow the same rule as a value cursor: nothing is later than a null
 * in a nulls-last key, and every non-null is later than a null in a nulls-first
 * key. Equality is null-safe, so ties stay tied.
 */
function keyCompare(keys: readonly Key[], signature: string): Keyset {
  return (sink, alias) => {
    sink.mark(`k:pk:${signature}`);
    let wrote = false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) continue;
      sink.text(wrote ? " or (" : "(");
      wrote = true;
      for (let before = 0; before < index; before += 1) {
        const prior = keys[before];
        if (prior === undefined) continue;
        const left = leftOf(prior, alias);
        const right = rightOf(prior);
        sink.text(`${left} is not distinct from ${right} and `);
      }
      later(sink, key, alias);
      sink.text(")");
    }
    if (!wrote) sink.text("false");
  };
}

function later(sink: Sink, key: Key, alias: string): void {
  const left = leftOf(key, alias);
  const right = rightOf(key);
  const op = key.dir === "asc" ? ">" : "<";
  if (key.nulls === "last") {
    sink.text(`(${right} is not null and (${left} ${op} ${right} or ${left} is null))`);
    return;
  }
  sink.text(
    `((${right} is null and ${left} is not null) or (${right} is not null and ${left} ${op} ${right}))`,
  );
}

/**
 * One row, the cursor's primary key, under the call's tenant and archive predicates.
 *
 * The page joins it as `c`. Sort values stay in the database.
 */
function writeCursorCte(
  sink: Sink,
  session: Session,
  table: Indexed,
  keys: readonly Key[],
  pk: readonly ColumnModel[],
  ids: readonly (string | null)[],
  join?: (sink: Sink) => void,
): void {
  sink.text("with c as (select ");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text(cursorSelect(key));
  }
  sink.text(" from ");
  sink.text(quote(table.model.sql));
  sink.text(" k");
  if (join !== undefined) join(sink);
  sink.text(" where ");
  for (let index = 0; index < pk.length; index += 1) {
    const column = pk[index];
    const value = ids[index];
    if (column === undefined || value === undefined) continue;
    if (index > 0) sink.text(" and ");
    sink.text("k.");
    sink.text(quote(column.sql));
    if (value === null) {
      sink.text(" is null");
    } else {
      sink.text(" = ");
      sink.param(value);
    }
    sink.mark(`pk:${column.field}`);
  }
  emitVisibility(session.schema, table, sink, "k", true);
  sink.text(") (");
}

/** A second arm with flag `'0'` when the cursor row is not visible. */
function writeCursorMiss(sink: Sink, columns: number): void {
  sink.text(") union all select ");
  for (let index = 0; index < columns - 1; index += 1) {
    if (index > 0) sink.text(", ");
    sink.text("null");
  }
  if (columns > 1) sink.text(", ");
  sink.text("'0' where not exists (select 1 from c)");
  sink.mark("kcur|");
}

function withoutMissingCursor(
  rows: readonly (readonly (string | null)[])[],
): readonly (readonly (string | null)[])[] {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row !== undefined && row[row.length - 1] === "0") {
    fail(
      "OKM1130",
      "The cursor is no longer valid.",
      "Request the next page from a row that is still in this tenant and archive set.",
    );
  }
  return rows;
}

function readCursor(token: unknown, signature: string, count: number): (string | null)[] {
  const parsed = decodeToken(token);
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
    fail("OKM1130", "after is not a cursor that page() returned.");
  }
  if (parsed[0] !== signature) {
    fail(
      "OKM1130",
      `The cursor was made for another order: ${parsed[0]}. This page orders by ${signature}.`,
    );
  }
  const values = parsed.slice(1) as unknown[];
  if (
    values.length !== count ||
    !values.every((value) => value === null || typeof value === "string")
  ) {
    fail("OKM1130", "after is not a cursor that page() returned.");
  }
  return values as (string | null)[];
}

/** Primary-key cursor. A value cursor is refused, so its sort values are not a range. */
function readKeyCursor(token: unknown, signature: string, count: number): (string | null)[] {
  const parsed = decodeToken(token);
  if (!Array.isArray(parsed) || parsed[0] !== KEY_MARK || typeof parsed[1] !== "string") {
    fail("OKM1130", "after is not a cursor that page() returned.");
  }
  if (parsed[1] !== signature) {
    fail(
      "OKM1130",
      `The cursor was made for another order: ${parsed[1]}. This page orders by ${signature}.`,
    );
  }
  const values = parsed.slice(2) as unknown[];
  if (
    values.length !== count ||
    !values.every((value) => value === null || typeof value === "string")
  ) {
    fail("OKM1130", "after is not a cursor that page() returned.");
  }
  return values as (string | null)[];
}

function decodeToken(token: unknown): unknown {
  if (typeof token !== "string") return undefined;
  try {
    const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
