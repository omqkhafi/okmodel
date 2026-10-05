/**
 * Keyset pages (spec sections 10 and 12).
 *
 * A page is a `find` with three changes: the order ends in the primary key, the
 * limit is one more than the page size, and an `after` condition replaces
 * offset. The tenant and active-set predicates are the planner's, so they
 * apply to every page the same way. This module loads on the first `page()`.
 *
 * The cursor holds the order it was made for and the values of the last row as
 * the database wrote them. Those are text, not decoded values, so a timestamp
 * keeps its microseconds and no row is skipped or repeated.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import { attachHttp, decodeRows, readCall, readHandle, type Mods, type Session } from "./client.js";
import {
  fail,
  indexes,
  isRecord,
  list,
  parseOrder,
  quote,
  readLimit,
  registerFailFix,
  rejectKeys,
  selectedColumns,
  type Indexed,
  type ArchiveView,
  type Keyset,
  type Plan,
} from "./plan.js";

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
  "signal",
  "timeout",
] as const;

type Key = {
  readonly column: ColumnModel;
  readonly dir: "asc" | "desc";
  readonly nulls: "first" | "last";
};

/**
 * Builds the handle for one `page()` call.
 *
 * @param session - Client session
 * @param table - Table name
 * @param options - `where`, `select`, `orderBy`, `limit`, `include`, and `after`
 * @param mods - Signal and timeout
 * @param view - Archive visibility
 * @returns A handle that resolves to `{ items, next }`
 */
export function build(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  try {
    return plan(session, table, options, mods, view);
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
): Promise<unknown> & Record<string, unknown> {
  const record: Record<string, unknown> = isRecord(options) ? options : {};
  rejectKeys(record, OPTIONS, "page");
  const indexed = indexes(session.schema).get(table);
  if (indexed === undefined) fail("OKM1120", `Table ${table} is not in the schema.`);
  if (record.limit === undefined) fail("OKM1101", "page() needs a limit.");
  const size = readLimit(record.limit);
  if (size < 1) {
    throw new OkmError("invalid", "page() limit must be at least 1.", { kind: "invalid" });
  }
  const keys = orderKeys(indexed, record.orderBy);
  const signature = `${table}:${keys.map((key) => `${key.column.field}.${key.dir}.${key.nulls}`).join(",")}`;
  const after =
    record.after === undefined || record.after === null
      ? undefined
      : keyset(keys, signature, record.after);
  const wanted = selectedColumns(indexed, record.select);
  const extra = keys.filter((key) => !wanted.includes(key.column)).map((key) => key.column.field);
  const select =
    extra.length === 0 ? record.select : [...wanted.map((column) => column.field), ...extra];
  const orderBy: Record<string, unknown> = {};
  for (const key of keys) orderBy[key.column.field] = { dir: key.dir, nulls: key.nulls };
  const call = {
    ...readCall(
      "find",
      table,
      {
        where: record.where,
        select,
        orderBy,
        limit: size + 1,
        include: record.include,
        signal: record.signal,
        timeout: record.timeout,
      },
      undefined,
      session.scope,
      session.schema.model[table],
      session.schema,
      view,
    ),
    ...(after !== undefined ? { after } : {}),
  };
  return readHandle(session, table, call, mods, async (compiled, rows) => {
    const items = (await decodeRows(compiled, rows, table)) as Record<string, unknown>[];
    const more = items.length > size;
    const kept = more ? items.slice(0, size) : items;
    const last = rows[size - 1];
    const next = more && last !== undefined ? makeCursor(compiled, last, keys, signature) : null;
    if (extra.length > 0) {
      for (const item of kept) {
        for (const field of extra) delete item[field];
      }
    }
    return { items: kept, next };
  });
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
  if (table.model.primary.length === 0) {
    fail("OKM1120", `page() needs a primary key on ${table.model.name} to break ties.`);
  }
  for (const field of table.model.primary) {
    const column = table.columns.get(field);
    if (column === undefined || keys.some((key) => key.column === column)) continue;
    keys.push({ column, dir: "asc", nulls: "last" });
  }
  return keys;
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
        const ref = `${alias}.${quote(prior.column.sql)}`;
        if (held === null) {
          sink.text(`${ref} is null and `);
        } else {
          sink.text(`${ref} = `);
          sink.param(held);
          sink.text(" and ");
        }
      }
      const ref = `${alias}.${quote(key.column.sql)}`;
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
  const values = keys.map((key) => {
    const at = plan.outputs.fields.find((field) => field.key === key.column.field)?.at;
    return at === undefined ? null : (row[at] ?? null);
  });
  const bytes = new TextEncoder().encode(JSON.stringify([signature, ...values]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function readCursor(token: unknown, signature: string, count: number): (string | null)[] {
  let parsed: unknown;
  if (typeof token === "string") {
    try {
      const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parsed = undefined;
    }
  }
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
