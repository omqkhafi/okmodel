/**
 * `descendants` and `ancestors` (spec §13 tool 11).
 *
 * One recursive statement walks a self-relation's parent column. A row already
 * on the path is not entered again, so a cycle in the data returns. `depth`
 * stops the walk earlier. `ltree` is not read: the extension is a later index,
 * and this statement does not require it.
 *
 * Tenancy and the active set apply on the start row, on every step, and on
 * the rows that come back. `where` and presets filter those rows and do not
 * cut the walk short. A missing id returns no rows, including with `self`.
 * The root has no ancestors. `limit` bounds the rows after the walk's order,
 * the same rule as `find`. `depth` is steps and does not bound rows. Loaded
 * on the first call.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import { attachHttp, readCall, readHandle, type Mods, type Session } from "./client.js";
import {
  decodeResult,
  emitOrder,
  emitWhere,
  readLimit,
  fail,
  indexes,
  isRecord,
  list,
  projectExpr,
  quote,
  rejectKeys,
  selectedColumns,
  type ArchiveView,
  type Built,
  type Indexed,
  type ReadCall,
  type Sink,
} from "./plan.js";

const OPTIONS = [
  "where",
  "select",
  "orderBy",
  "limit",
  "depth",
  "self",
  "relation",
  "ignore",
  "route",
  "signal",
  "timeout",
];

type Direction = "descendants" | "ancestors";

/** One self-relation, as the parent key and the child foreign key. */
type Edge = {
  readonly name: string;
  /** SQL names on the parent row, in foreign-key order. */
  readonly parent: readonly string[];
  /** SQL names of the foreign key on the child row, in the same order. */
  readonly child: readonly string[];
};

/**
 * Builds the handle for one `descendants` or `ancestors` call.
 *
 * @param session - Client session
 * @param table - Table name
 * @param options - The packed call: the id, the direction, and the caller's options
 * @param mods - Presets, signal, and timeout
 * @param view - Archive visibility
 * @returns A handle that resolves to the walked rows
 */
export function build(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  try {
    return open(session, table, options, mods, view);
  } catch (error) {
    throw error instanceof OkmError ? attachHttp(session.http, error) : error;
  }
}

function open(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  const packed = readPacked(options);
  const user = packed.user;
  rejectKeys(user, OPTIONS, packed.walk);
  const indexed = indexes(session.schema).get(table);
  if (indexed === undefined) fail("OKM1120", `Table ${table} is not in the schema.`);
  const edge = pickEdge(indexed, user.relation);
  const identity = identityColumn(session, indexed);
  const depth = readDepth(user.depth);
  const self = readSelf(user.self);
  const id = userId(identity, packed.id);
  const shared = {
    ...(user.where !== undefined ? { where: user.where } : {}),
    ...(user.select !== undefined ? { select: user.select } : {}),
    ...(user.orderBy !== undefined ? { orderBy: user.orderBy } : {}),
    ...(user.limit !== undefined ? { limit: user.limit } : {}),
    ...(user.signal !== undefined ? { signal: user.signal } : {}),
    ...(user.timeout !== undefined ? { timeout: user.timeout } : {}),
    ...(user.route !== undefined ? { route: user.route } : {}),
    ...(user.ignore !== undefined ? { ignore: user.ignore } : {}),
  };
  const base = readCall(
    "find",
    table,
    shared,
    mods.all,
    session.scope,
    session.schema.model[table],
    session.schema,
    view,
  );
  const spec: Spec = { direction: packed.walk, edge, identity, depth, self, id };
  const call: ReadCall = {
    ...base,
    op: packed.walk,
    ...(session.l !== undefined ? { limits: session.l } : {}),
    build: (schema, planned, sink, outputs, source) => {
      emitTree(schema, planned, sink, outputs, source, spec);
    },
  };
  return readHandle(session, table, call, mods, (compiled, rows) =>
    decodeResult(compiled, rows, table),
  );
}

type Spec = {
  readonly direction: Direction;
  readonly edge: Edge;
  readonly identity: ColumnModel;
  readonly depth: number | undefined;
  readonly self: boolean;
  readonly id: unknown;
};

function emitTree(
  schema: Session["schema"],
  table: Indexed,
  sink: Sink,
  outputs: Built | undefined,
  call: ReadCall,
  spec: Spec,
): void {
  const { direction, edge, identity, depth, self, id } = spec;
  sink.mark(
    `walk:${direction}|rel:${edge.name}|self:${self ? "1" : "0"}|depth:${depth === undefined ? "all" : String(depth)}|`,
  );
  const selected = selectedColumns(table, call.select);
  sink.text("with recursive walk as (select ");
  emitKeyList(sink, "s", edge.parent, "k");
  emitKeyList(sink, "s", edge.child, "f");
  sink.text(", 0 as depth, array[s.");
  sink.text(quote(identity.sql));
  sink.text("] as seen from ");
  sink.text(quote(table.model.sql));
  sink.text(" s where s.");
  sink.text(quote(identity.sql));
  sink.text(" = ");
  sink.param(identity.encode(id));
  emitWhere(schema, table, undefined, sink, "s", 0, true);
  sink.text(" union all select ");
  let started = emitBare(sink, "c", edge.parent, false);
  emitBare(sink, "c", edge.child, started);
  sink.text(", w.depth + 1, w.seen || c.");
  sink.text(quote(identity.sql));
  sink.text(" from ");
  sink.text(quote(table.model.sql));
  sink.text(" c join walk w on ");
  if (direction === "descendants") emitStep(sink, "c", edge.child, edge.parent, "k");
  else emitStep(sink, "c", edge.parent, edge.child, "f");
  sink.text(" where c.");
  sink.text(quote(identity.sql));
  sink.text(" <> all(w.seen)");
  if (depth !== undefined) {
    sink.text(" and w.depth < ");
    sink.text(String(depth));
  }
  emitWhere(schema, table, undefined, sink, "c", 0, true);
  sink.text(") select ");
  let column = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    if (item === undefined) continue;
    if (column > 0) sink.text(", ");
    sink.text(projectExpr(`t.${quote(item.sql)}`, item.dataType));
    sink.mark(`s:${item.field}`);
    outputs?.fields.push({ key: item.field, at: column, decode: item.decode });
    column += 1;
  }
  if (column === 0) sink.text("1");
  sink.text(" from ");
  sink.text(quote(table.model.sql));
  sink.text(" t join walk w on ");
  emitStep(sink, "t", edge.parent, edge.parent, "k");
  if (self) emitWhere(schema, table, call.where, sink, "t", 0, false);
  else {
    sink.text(" where w.depth > 0");
    emitWhere(schema, table, call.where, sink, "t", 0, true);
  }
  if (call.orderBy !== undefined) {
    emitOrder(table, call.orderBy, sink, "t");
  } else {
    sink.text(" order by w.depth asc");
    sink.mark("order:depth");
    for (const field of table.model.primary) {
      const item = table.columns.get(field);
      if (item === undefined) continue;
      sink.text(", t.");
      sink.text(quote(item.sql));
      sink.text(" asc");
    }
  }
  emitWalkLimit(call, sink, direction);
  rememberBound(call);
}

/**
 * Writes the row bound after the walk's order.
 *
 * The same rule as `find`: `.all("")` and a missing limit are OKM1101.
 * `.all(reason)` writes no bound unless the caller also passed `limit`.
 * This stays in the tree chunk. `emitLimit` is the find copy on the startup path.
 *
 * @param call - The walk
 * @param sink - Statement being built
 * @param direction - `descendants` or `ancestors`
 */
function emitWalkLimit(call: ReadCall, sink: Sink, direction: Direction): void {
  const label = `${direction}()`;
  if (call.all !== undefined) {
    if (call.all.length === 0) fail("OKM1101", `${label} .all needs a reason.`);
    sink.mark(`all:${call.all}`);
    if (call.limit !== undefined) writeLimit(call, sink);
    return;
  }
  if (call.limit === undefined) fail("OKM1101", `${label} needs a limit.`);
  writeLimit(call, sink);
}

/**
 * Records the `bounded` rule on the call so `.inspect()` can read it.
 *
 * `appliedRules` already lists `ruleLines`. The contribution is decided
 * here, after `limits.find` has filled `limit`, and the startup graph
 * does not grow a second copy of that rule.
 *
 * @param call - The walk, after the default limit is applied
 */
function rememberBound(call: ReadCall): void {
  const dl = call.dl;
  const rule = {
    rule: "bounded" as const,
    contribution: call.all ?? (dl === undefined ? "limit" : `limits.${dl[0]}`),
    provenance: dl === undefined ? ("caller" as const) : ("connect" as const),
  };
  const lines = call.ruleLines === undefined ? [rule] : [...call.ruleLines, rule];
  (call as unknown as { ruleLines: typeof lines }).ruleLines = lines;
}

function writeLimit(call: ReadCall, sink: Sink): void {
  const value = readLimit(call.limit);
  sink.text(" limit ");
  sink.param(String(value));
  sink.mark(`l:${String(value)}`);
}

function emitKeyList(sink: Sink, alias: string, columns: readonly string[], prefix: string): void {
  for (let index = 0; index < columns.length; index += 1) {
    const name = columns[index];
    if (name === undefined) continue;
    if (index > 0 || prefix === "f") sink.text(", ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(name));
    sink.text(" as ");
    sink.text(prefix);
    sink.text(String(index));
  }
}

function emitBare(sink: Sink, alias: string, columns: readonly string[], lead: boolean): boolean {
  let started = lead;
  for (const name of columns) {
    if (started) sink.text(", ");
    started = true;
    sink.text(alias);
    sink.text(".");
    sink.text(quote(name));
  }
  return started;
}

function emitStep(
  sink: Sink,
  alias: string,
  columns: readonly string[],
  against: readonly string[],
  prefix: string,
): void {
  for (let index = 0; index < columns.length; index += 1) {
    const name = columns[index];
    if (name === undefined || against[index] === undefined) continue;
    if (index > 0) sink.text(" and ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(name));
    sink.text(" = w.");
    sink.text(prefix);
    sink.text(String(index));
  }
}

function readPacked(options: object): {
  readonly id: unknown;
  readonly walk: Direction;
  readonly user: Record<string, unknown>;
} {
  if (!isRecord(options) || (options.walk !== "descendants" && options.walk !== "ancestors")) {
    fail("OKM1120", "descendants and ancestors are table methods.");
  }
  const user = options.options;
  if (user === undefined) return { id: options.id, walk: options.walk, user: {} };
  if (!isRecord(user)) fail("OKM1120", `${options.walk} options must be an object.`);
  return { id: options.id, walk: options.walk, user };
}

function pickEdge(table: Indexed, relation: unknown): Edge {
  const edges = selfEdges(table);
  if (edges.length === 0) {
    fail(
      "OKM1120",
      `${table.model.name} has no relation to itself.`,
      `Declare children: many("${table.model.name}") or parent: one("${table.model.name}").`,
    );
  }
  const groups = new Set(edges.map((edge) => edge.child.join("\0")));
  if (relation === undefined) {
    if (groups.size !== 1) {
      fail(
        "OKM1120",
        `${table.model.name} has more than one relation to itself. Pass relation.`,
        `Accepted names: ${edges.map((edge) => edge.name).join(", ")}.`,
      );
    }
    const only = edges[0];
    if (only === undefined) fail("OKM1120", `${table.model.name} has no relation to itself.`);
    return only;
  }
  if (typeof relation !== "string" || relation.length === 0) {
    fail("OKM1120", "relation must be a name.");
  }
  const found = edges.find((edge) => edge.name === relation);
  if (found === undefined) {
    throwNamed(
      "OKM1120",
      relation,
      edges.map((edge) => edge.name),
      `Relation ${relation} is not a self-relation of ${table.model.name}. Accepted names: ${list(edges.map((edge) => edge.name))}.`,
    );
  }
  return found;
}

function selfEdges(table: Indexed): Edge[] {
  const edges: Edge[] = [];
  for (const relation of table.model.relations) {
    if (relation.table !== table.model.name || relation.through !== undefined) continue;
    edges.push(
      relation.kind === "many"
        ? { name: relation.name, parent: relation.local, child: relation.remote }
        : { name: relation.name, parent: relation.remote, child: relation.local },
    );
  }
  return edges;
}

/**
 * The primary key the caller passes, without the tenant key.
 *
 * A tree walk and `sync` both address one column. A composite key beside the
 * tenant key is refused.
 *
 * @param session - Client session, for the tenant key
 * @param table - The table
 * @returns That column
 */
export function identityColumn(session: Session, table: Indexed): ColumnModel {
  const tenancy = session.schema.tenancy;
  const keys = tenancy === undefined ? [] : (tenancy.keys ?? [tenancy.key]);
  const fields = table.model.primary.filter((field) => !keys.includes(field));
  if (fields.length !== 1) {
    fail(
      "OKM1120",
      `${table.model.name} needs one primary key column besides the tenant key.`,
      "Use a single-column primary key.",
    );
  }
  const field = fields[0];
  const column = field === undefined ? undefined : table.columns.get(field);
  if (column === undefined) {
    fail("OKM1120", `${table.model.name} needs one primary key column besides the tenant key.`);
  }
  return column;
}

function readDepth(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("OKM1120", "depth must be an integer from 0 up.");
  }
  return value;
}

function readSelf(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail("OKM1120", "self must be true or false.");
  return value;
}

function userId(column: ColumnModel, id: unknown): unknown {
  if (id === undefined || id === null) {
    fail("OKM1121", `${column.field} needs a value.`);
  }
  return id;
}
