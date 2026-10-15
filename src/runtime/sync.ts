/**
 * `sync` (spec §11, §13 tool 10).
 *
 * One transaction sets a to-many relation to an exact set of ids. The first
 * statement locks the parent row. The write is a second statement, so a sync
 * that waited for that lock sees the links the previous sync committed. A join table
 * gains and loses link rows. A one-to-many sets or clears a nullable foreign
 * key and leaves the related row in place. A link that would have to delete
 * that row is refused. Duplicate ids count once. An id that is not in the
 * related table, or a parent id that is not in this table, writes nothing and
 * throws `not_found`. The parent row is locked, so two syncs of the same id
 * run one after the other.
 *
 * Loaded on the first call.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import type { Catalog, ColumnDefinition } from "../contracts/catalog/types.js";
import type { ExecuteOptions, Statement } from "../contracts/driver.js";
import type { ColumnModel, PresetUse, QuerySchema, RelationModel } from "../dialects/pg/model.js";
import { queryHandle, settleCall, type Mods as ReadMods, type Session } from "./client.js";
import {
  archiveRules,
  emitWhere,
  fail,
  indexes,
  isRecord,
  list,
  quote,
  rejectKeys,
  withRowFilters,
  type ArchiveView,
  type Indexed,
  type Sink,
} from "./plan.js";
import { runSafety, safetyInstalled, type SafetyContribution } from "./safety-hook.js";
import { identityColumn } from "./tree.js";
import { runWrite } from "./tx.js";

const OPTIONS = ["expect", "signal", "timeout", "route"];

type Mods = {
  readonly expect?: number;
  readonly archive?: ArchiveView | undefined;
  readonly uses?: PresetUse | undefined;
};

type Slot = {
  readonly join: string;
  readonly from: "locked" | "desired";
  readonly locked?: string;
};

/**
 * Runs one `sync`.
 *
 * @param session - Client session
 * @param table - Table that owns the relation
 * @param id - Primary key of that row
 * @param relation - To-many relation name
 * @param ids - Related primary keys the relation should hold
 * @param options - `expect`, `signal`, and `timeout`
 * @param mods - Chained `expect`, archive visibility, and presets
 * @returns The ids whose links were added or removed
 */
export async function execute(
  session: Session,
  table: string,
  id: unknown,
  relation: unknown,
  ids: unknown,
  options: object | undefined,
  mods: Mods,
): Promise<{ readonly added: readonly unknown[]; readonly removed: readonly unknown[] }> {
  try {
    const planned = await prepare(session, table, id, relation, ids, options, mods);
    const results = await runWrite(session, [planned.lock, planned.statement], planned.call);
    return readResult(planned, results[1]?.rows ?? []);
  } catch (error) {
    return settleCall(session, error);
  }
}

/**
 * The statement `sync` would run.
 *
 * @param session - Client session
 * @param table - Table that owns the relation
 * @param id - Primary key of that row
 * @param relation - To-many relation name
 * @param ids - Related primary keys the relation should hold
 * @param options - `expect`, `signal`, and `timeout`
 * @param mods - Chained `expect`, archive visibility, and presets
 * @returns One statement
 */
export async function explain(
  session: Session,
  table: string,
  id: unknown,
  relation: unknown,
  ids: unknown,
  options: object | undefined,
  mods: Mods,
): Promise<{ readonly statements: readonly Statement[] }> {
  try {
    const planned = await prepare(session, table, id, relation, ids, options, mods);
    return { statements: [planned.lock, planned.statement] };
  } catch (error) {
    return settleCall(session, error);
  }
}

/**
 * The handle for one `sync`.
 *
 * Await runs the change. `sql` shows the lock and the write. `expect` lives on
 * the outer handle, which calls this again with `mods.expect` set.
 *
 * @param session - Client session
 * @param table - Table that owns the relation
 * @param input - `id`, `relation`, `ids`, and `options`
 * @param mods - Presets, plus `expect` when the outer handle chained it
 * @param view - Archive view. The same value a read on this handle uses
 * @returns A handle. The value is `{ added, removed }`
 */
export function build(
  session: Session,
  table: string,
  input: object,
  mods: ReadMods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  const packed = input as {
    readonly id: unknown;
    readonly relation: unknown;
    readonly ids: unknown;
    readonly options?: object;
  };
  const expect = (mods as { readonly expect?: number }).expect;
  const applied: Mods = {
    ...(typeof expect === "number" ? { expect } : {}),
    archive: view,
    uses: mods.uses,
  };
  return queryHandle(
    () => execute(session, table, packed.id, packed.relation, packed.ids, packed.options, applied),
    {
      sql: () =>
        explain(session, table, packed.id, packed.relation, packed.ids, packed.options, applied),
    },
  ) as unknown as Promise<unknown> & Record<string, unknown>;
}

type Planned = {
  /** Locks the parent before the write, so the write's snapshot is current. */
  readonly lock: Statement;
  readonly statement: Statement;
  readonly call: ExecuteOptions | undefined;
  readonly expect: number | undefined;
  readonly decode: ((wire: string) => unknown) | undefined;
  readonly table: string;
  readonly relation: string;
  readonly related: string;
};

async function prepare(
  session: Session,
  table: string,
  id: unknown,
  relationName: unknown,
  ids: unknown,
  options: object | undefined,
  mods: Mods,
): Promise<Planned> {
  const record = options === undefined ? {} : options;
  if (!isRecord(record)) fail("OKM1120", "sync options must be an object.");
  rejectKeys(record, OPTIONS, "sync");
  const owner = indexes(session.schema).get(table);
  if (owner === undefined) fail("OKM1120", `Table ${table} is not in the schema.`);
  const relation = requireRelation(owner, relationName);
  if (relation.morph !== undefined) {
    fail(
      "OKM1120",
      `sync does not follow ${relation.name}. Set ${relation.morph.typeField} and ${relation.morph.idField} with morphTo.`,
    );
  }
  const related = indexes(session.schema).get(relation.table);
  if (related === undefined) {
    fail(
      "OKM1120",
      `Relation ${relation.name} names ${relation.table}, which is not in the schema.`,
    );
  }
  const identity = identityColumn(session, owner);
  const relatedId = identityColumn(session, related);
  const parent = userValue(identity, id);
  const wanted = readIds(relatedId, ids);
  const own = String(relatedId.encode(parent));
  if (owner.model.name === related.model.name && wanted.some((item) => String(item) === own)) {
    fail(
      "OKM1120",
      `sync on ${owner.model.name}.${relation.name} cannot make a row its own child.`,
      "A row cannot be its own child. Leave its id out of the list.",
    );
  }
  const where = await presetWhere(session.schema, table, mods.uses);
  noteSafety(session, table, mods.archive);
  const statement = withRowFilters(session.scope, mods.archive, () =>
    relation.through === undefined
      ? oneToMany(session, owner, related, relation, identity, relatedId, parent, wanted, where)
      : manyThrough(session, owner, related, relation, identity, relatedId, parent, wanted, where),
  );
  const lock = withRowFilters(session.scope, mods.archive, () =>
    parentLock(session, owner, identity, parent, where),
  );
  return {
    lock,
    statement,
    call: callOf(record),
    expect: expectOf(mods.expect ?? record.expect),
    decode: relatedId.decode,
    table,
    relation: relation.name,
    related: related.model.name,
  };
}

function oneToMany(
  session: Session,
  owner: Indexed,
  related: Indexed,
  relation: RelationModel,
  identity: ColumnModel,
  relatedId: ColumnModel,
  parent: unknown,
  wanted: readonly string[],
  where: unknown,
): Statement {
  const tenant = tenantSql(session, owner);
  const clearing: { readonly child: string; readonly parent: string }[] = [];
  for (let index = 0; index < relation.local.length; index += 1) {
    const parentSql = relation.local[index];
    const childSql = relation.remote[index];
    if (parentSql === undefined || childSql === undefined) continue;
    if (tenant.has(parentSql)) continue;
    clearing.push({ child: childSql, parent: parentSql });
  }
  if (clearing.length === 0) {
    fail(
      "OKM1120",
      `sync on ${owner.model.name}.${relation.name} cannot clear a link.`,
      "The foreign key is only the tenant key.",
    );
  }
  const catalog = catalogOf(session.schema);
  for (const link of clearing) {
    const column = related.model.columns.find((item) => item.sql === link.child);
    const stored = storedColumn(catalog, related.model.sql, link.child);
    if (stored === undefined || stored.nullable !== true) {
      fail(
        "OKM1120",
        `sync on ${owner.model.name}.${relation.name} would delete rows to drop a link. ${related.model.name}.${column?.field ?? link.child} is not nullable.`,
        "Use a nullable foreign key, or a join table.",
      );
    }
  }
  const sink = text();
  sink.text("with locked as materialized (select ");
  emitSelectLocked(sink, relation.local);
  sink.text(" from ");
  sink.text(quote(owner.model.sql));
  sink.text(" p where p.");
  sink.text(quote(identity.sql));
  sink.text(" = ");
  sink.param(identity.encode(parent));
  emitWhere(session.schema, owner, where, sink, "p", 0, true);
  sink.text(" for update), ");
  emitDesired(sink, relatedId, wanted);
  sink.text(", missing as (select d.id from desired d where not exists (select 1 from ");
  sink.text(quote(related.model.sql));
  sink.text(" r where r.");
  sink.text(quote(relatedId.sql));
  sink.text(" = d.id");
  emitWhere(session.schema, related, undefined, sink, "r", 0, true);
  sink.text(
    ")), guard as (select (select count(*) from locked) as parents, (select count(*) from missing) as missing_n), held as materialized (select c.",
  );
  sink.text(quote(relatedId.sql));
  sink.text(" as id from ");
  sink.text(quote(related.model.sql));
  sink.text(" c where (");
  emitChildMatch(sink, "c", clearing);
  sink.text(" or c.");
  sink.text(quote(relatedId.sql));
  sink.text(" in (select d.id from desired d))");
  emitGuard(sink);
  emitWhere(session.schema, related, undefined, sink, "c", 0, true);
  sink.text(" order by c.");
  sink.text(quote(relatedId.sql));
  sink.text(" for update), changed as (update ");
  sink.text(quote(related.model.sql));
  sink.text(" c set ");
  emitSetCase(sink, "c", relatedId, clearing);
  sink.text(" where c.");
  sink.text(quote(relatedId.sql));
  sink.text(" in (select h.id from held h) and ");
  emitWillChange(sink, "c", relatedId, clearing);
  emitWhere(session.schema, related, undefined, sink, "c", 0, true);
  emitGuard(sink);
  sink.text(" returning c.");
  sink.text(quote(relatedId.sql));
  sink.text(" as id, case when c.");
  sink.text(quote(relatedId.sql));
  sink.text(" in (select d.id from desired d) then 'a' else 'r' end as kind) ");
  emitReport(sink, "kind");
  return sink.finish();
}

function manyThrough(
  session: Session,
  owner: Indexed,
  related: Indexed,
  relation: RelationModel,
  identity: ColumnModel,
  relatedId: ColumnModel,
  parent: unknown,
  wanted: readonly string[],
  where: unknown,
): Statement {
  const through = relation.through;
  if (through === undefined) {
    fail("OKM1120", `Relation ${relation.name} has no join table.`);
  }
  const join = indexes(session.schema).get(through.table);
  if (join === undefined) {
    fail(
      "OKM1120",
      `Relation ${relation.name} names ${through.table}, which is not in the schema.`,
    );
  }
  const slots = joinSlots(relation, relatedId);
  const catalog = catalogOf(session.schema);
  for (const column of join.model.columns) {
    if (slots.some((slot) => slot.join === column.sql)) continue;
    const stored = storedColumn(catalog, join.model.sql, column.sql);
    if (stored !== undefined && canOmit(stored)) continue;
    fail(
      "OKM1120",
      `sync on ${owner.model.name}.${relation.name} cannot fill ${join.model.name}.${column.field}.`,
      "A database default can fill it. sync does not.",
    );
  }
  const link = slots.find((slot) => slot.from === "desired");
  if (link === undefined) {
    fail("OKM1120", `sync on ${owner.model.name}.${relation.name} cannot see the related id.`);
  }
  const ownerSlots = slots.filter((slot) => slot.from === "locked");
  if (ownerSlots.length === 0) {
    fail("OKM1120", `sync on ${owner.model.name}.${relation.name} cannot see the parent row.`);
  }
  const sink = text();
  sink.text("with locked as materialized (select ");
  emitSelectLocked(sink, relation.local);
  sink.text(" from ");
  sink.text(quote(owner.model.sql));
  sink.text(" p where p.");
  sink.text(quote(identity.sql));
  sink.text(" = ");
  sink.param(identity.encode(parent));
  emitWhere(session.schema, owner, where, sink, "p", 0, true);
  sink.text(" for update), ");
  emitDesired(sink, relatedId, wanted);
  sink.text(", missing as (select d.id from desired d where not exists (select 1 from ");
  sink.text(quote(related.model.sql));
  sink.text(" r where r.");
  sink.text(quote(relatedId.sql));
  sink.text(" = d.id");
  emitWhere(session.schema, related, undefined, sink, "r", 0, true);
  sink.text(
    ")), guard as (select (select count(*) from locked) as parents, (select count(*) from missing) as missing_n), removed as (delete from ",
  );
  sink.text(quote(join.model.sql));
  sink.text(" j where ");
  emitJoinLocked(sink, "j", ownerSlots);
  sink.text(" and not exists (select 1 from desired d where d.id = j.");
  sink.text(quote(link.join));
  sink.text(")");
  emitWhere(session.schema, join, undefined, sink, "j", 0, true);
  emitGuard(sink);
  sink.text(" returning j.");
  sink.text(quote(link.join));
  sink.text(" as id), added as (insert into ");
  sink.text(quote(join.model.sql));
  sink.text(" (");
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (slot === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text(quote(slot.join));
  }
  sink.text(") select ");
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (slot === undefined) continue;
    if (index > 0) sink.text(", ");
    if (slot.from === "desired") sink.text("d.id");
    else emitLocked(sink, slot.locked ?? "");
  }
  sink.text(" from desired d where not exists (select 1 from ");
  sink.text(quote(join.model.sql));
  sink.text(" j where ");
  emitJoinLocked(sink, "j", ownerSlots);
  sink.text(" and j.");
  sink.text(quote(link.join));
  sink.text(" = d.id");
  emitWhere(session.schema, join, undefined, sink, "j", 0, true);
  sink.text(")");
  emitGuard(sink);
  sink.text(" returning ");
  sink.text(quote(link.join));
  sink.text(" as id) ");
  emitReport(sink, "split");
  return sink.finish();
}

function joinSlots(relation: RelationModel, relatedId: ColumnModel): Slot[] {
  const through = relation.through;
  if (through === undefined) return [];
  const slots: Slot[] = [];
  const seen = new Set<string>();
  const add = (slot: Slot): void => {
    if (seen.has(slot.join)) return;
    seen.add(slot.join);
    slots.push(slot);
  };
  for (let index = 0; index < relation.remote.length; index += 1) {
    const join = relation.remote[index];
    const locked = relation.local[index];
    if (join === undefined || locked === undefined) continue;
    add({ join, from: "locked", locked });
  }
  for (let index = 0; index < through.local.length; index += 1) {
    const join = through.local[index];
    const remote = through.remote[index];
    if (join === undefined || remote === undefined) continue;
    if (remote === relatedId.sql) add({ join, from: "desired" });
    else if (relation.local.includes(remote)) add({ join, from: "locked", locked: remote });
    else {
      fail(
        "OKM1120",
        `sync cannot copy ${remote} onto the join table.`,
        "The join's foreign key has a column this row does not.",
      );
    }
  }
  return slots;
}

function parentLock(
  session: Session,
  owner: Indexed,
  identity: ColumnModel,
  parent: unknown,
  where: unknown,
): Statement {
  const sink = text();
  sink.text("select p.");
  sink.text(quote(identity.sql));
  sink.text(" from ");
  sink.text(quote(owner.model.sql));
  sink.text(" p where p.");
  sink.text(quote(identity.sql));
  sink.text(" = ");
  sink.param(identity.encode(parent));
  emitWhere(session.schema, owner, where, sink, "p", 0, true);
  sink.text(" for update");
  return sink.finish();
}

function emitSelectLocked(sink: Sql, columns: readonly string[]): void {
  for (let index = 0; index < columns.length; index += 1) {
    const name = columns[index];
    if (name === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text("p.");
    sink.text(quote(name));
  }
}

function emitDesired(sink: Sql, column: ColumnModel, ids: readonly string[]): void {
  sink.text("desired as (");
  if (ids.length === 0) {
    sink.text("select cast(null as ");
    sink.text(column.dataType);
    sink.text(") as id where false");
  } else {
    sink.text("select distinct v.id from (values ");
    for (let index = 0; index < ids.length; index += 1) {
      const encoded = ids[index];
      if (encoded === undefined) continue;
      if (index > 0) sink.text(", ");
      sink.text("(cast(");
      sink.param(encoded);
      sink.text(" as ");
      sink.text(column.dataType);
      sink.text("))");
    }
    sink.text(") as v(id)");
  }
  sink.text(")");
}

function emitChildMatch(
  sink: Sql,
  alias: string,
  links: readonly { readonly child: string; readonly parent: string }[],
): void {
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link === undefined) continue;
    if (index > 0) sink.text(" and ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(link.child));
    sink.text(" = ");
    emitLocked(sink, link.parent);
  }
}

function emitSetCase(
  sink: Sql,
  alias: string,
  identity: ColumnModel,
  links: readonly { readonly child: string; readonly parent: string }[],
): void {
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text(quote(link.child));
    sink.text(" = case when ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(identity.sql));
    sink.text(" in (select d.id from desired d) then ");
    emitLocked(sink, link.parent);
    sink.text(" else null end");
  }
}

function emitWillChange(
  sink: Sql,
  alias: string,
  identity: ColumnModel,
  links: readonly { readonly child: string; readonly parent: string }[],
): void {
  sink.text("((");
  emitChildMatch(sink, alias, links);
  sink.text(" and not exists (select 1 from desired d where d.id = ");
  sink.text(alias);
  sink.text(".");
  sink.text(quote(identity.sql));
  sink.text(")) or (");
  sink.text(alias);
  sink.text(".");
  sink.text(quote(identity.sql));
  sink.text(" in (select d.id from desired d) and (");
  emitDistinct(sink, alias, links);
  sink.text(")))");
}

function emitDistinct(
  sink: Sql,
  alias: string,
  links: readonly { readonly child: string; readonly parent: string }[],
): void {
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link === undefined) continue;
    if (index > 0) sink.text(" or ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(link.child));
    sink.text(" is distinct from ");
    emitLocked(sink, link.parent);
  }
}

function emitJoinLocked(sink: Sql, alias: string, slots: readonly Slot[]): void {
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (slot === undefined || slot.locked === undefined) continue;
    if (index > 0) sink.text(" and ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(slot.join));
    sink.text(" = ");
    emitLocked(sink, slot.locked);
  }
}

function emitLocked(sink: Sql, column: string): void {
  sink.text("(select l.");
  sink.text(quote(column));
  sink.text(" from locked l)");
}

function emitGuard(sink: Sql): void {
  sink.text(" and (select g.parents from guard g) = 1 and (select g.missing_n from guard g) = 0");
}

function emitReport(sink: Sql, changes: "kind" | "split"): void {
  sink.text(
    changes === "kind"
      ? "select 'm'::text, d.id::text from missing d union all select ch.kind, ch.id::text from changed ch union all select 'p'::text, g.parents::text from guard g"
      : "select 'm'::text, d.id::text from missing d union all select 'a'::text, a.id::text from added a union all select 'r'::text, r.id::text from removed r union all select 'p'::text, g.parents::text from guard g",
  );
}

function readResult(
  planned: Planned,
  rows: readonly (readonly (string | null)[])[],
): { readonly added: readonly unknown[]; readonly removed: readonly unknown[] } {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  let parents = 0;
  let missing = 0;
  for (const row of rows) {
    const kind = row[0];
    const value = row[1];
    if (kind === "p") parents = Number(value);
    else if (kind === "m") missing += 1;
    else if (value === null || value === undefined) continue;
    else if (kind === "a") added.push(decode(planned.decode, value));
    else if (kind === "r") removed.push(decode(planned.decode, value));
  }
  if (parents !== 1) {
    throw new OkmError("not_found", `sync on ${planned.table} did not find that id.`, {
      kind: "not_found",
      table: planned.table,
      fix: { summary: "Pass an id that is in the table." },
    });
  }
  if (missing > 0) {
    throw new OkmError(
      "not_found",
      `sync on ${planned.table}.${planned.relation} is missing ${String(missing)} ids.`,
      {
        kind: "not_found",
        table: planned.table,
        fix: { summary: `Pass ids that exist on ${planned.related}.` },
      },
    );
  }
  const changed = added.length + removed.length;
  if (planned.expect !== undefined && changed !== planned.expect) {
    throw new OkmError(
      "not_found",
      `sync on ${planned.table}.${planned.relation} changed ${String(changed)} links. expect was ${String(planned.expect)}.`,
      {
        kind: "not_found",
        table: planned.table,
        fix: { summary: "Change the ids, or pass the number of links this sync changed." },
      },
    );
  }
  added.sort(byText);
  removed.sort(byText);
  return { added, removed };
}

function decode(fn: ((wire: string) => unknown) | undefined, wire: string): unknown {
  return fn === undefined ? wire : fn(wire);
}

function byText(left: unknown, right: unknown): number {
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function requireRelation(table: Indexed, name: unknown): RelationModel {
  if (typeof name !== "string" || name.length === 0)
    fail("OKM1120", "sync relation must be a name.");
  const relation = table.relations.get(name);
  if (relation === undefined) {
    throwNamed(
      "OKM1120",
      name,
      [...table.relations.keys()],
      `Relation ${name} is not on ${table.model.name}. Accepted names: ${list([...table.relations.keys()])}.`,
    );
  }
  if (relation.kind !== "many") {
    fail(
      "OKM1120",
      `sync on ${table.model.name}.${name} is not a to-many relation.`,
      "Pass a many or manyThrough relation.",
    );
  }
  return relation;
}

function readIds(column: ColumnModel, ids: unknown): readonly string[] {
  if (!Array.isArray(ids)) fail("OKM1120", "sync ids must be a list.");
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === undefined || id === null) fail("OKM1121", "sync ids cannot include null.");
    const encoded = column.encode(id);
    if (seen.has(encoded)) continue;
    seen.add(encoded);
    unique.push(encoded);
  }
  return unique;
}

function userValue(column: ColumnModel, id: unknown): unknown {
  if (id === undefined || id === null) fail("OKM1121", `${column.field} needs a value.`);
  return id;
}

function expectOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OkmError("invalid", "expect must be an integer from 0 up.", { kind: "invalid" });
  }
  return value;
}

function callOf(options: Record<string, unknown>): ExecuteOptions | undefined {
  const signal = options.signal;
  const timeout = options.timeout;
  const route = options.route;
  const hasSignal = typeof signal === "object" && signal !== null && "aborted" in signal;
  const hasTimeout = typeof timeout === "number";
  const hasRoute = route === "primary" || route === "replica";
  if (!hasSignal && !hasTimeout && !hasRoute) return undefined;
  return {
    ...(hasSignal ? { signal: signal as AbortSignal } : {}),
    ...(hasTimeout ? { timeout } : {}),
    ...(hasRoute ? { route } : {}),
  };
}

async function presetWhere(
  schema: QuerySchema,
  table: string,
  uses: PresetUse | undefined,
): Promise<unknown> {
  if (uses === undefined) return undefined;
  const { resolve } = await import("./presets.js");
  const { stack } = await import("./preset-stack.js");
  return stack(undefined, resolve(schema, table, uses).wheres);
}

function noteSafety(session: Session, table: string, view: ArchiveView | undefined): void {
  if (!safetyInstalled()) return;
  const model = session.schema.model[table];
  const rules: SafetyContribution[] = [];
  const tenancy = session.schema.tenancy;
  if (tenancy !== undefined) {
    for (const rule of tenancy.rules(table, model?.source, session.scope)) rules.push(rule);
  }
  const archive = archiveRules(model, view);
  if (archive !== undefined) {
    for (const rule of archive) rules.push(rule);
  }
  const scope = session.scope;
  const hatches =
    scope !== undefined && "unscoped" in scope
      ? [{ name: "unscoped" as const, reason: scope.unscoped }]
      : undefined;
  runSafety(rules, hatches);
}

function tenantSql(session: Session, table: Indexed): ReadonlySet<string> {
  const tenancy = session.schema.tenancy;
  const fields = tenancy === undefined ? [] : (tenancy.keys ?? [tenancy.key]);
  const sql = new Set<string>();
  for (const field of fields) {
    const column = table.columns.get(field);
    if (column !== undefined) sql.add(column.sql);
  }
  return sql;
}

function catalogOf(schema: QuerySchema): Catalog {
  const catalog = (schema as QuerySchema & { readonly catalog?: Catalog }).catalog;
  if (catalog === undefined) fail("OKM1120", "sync needs the schema catalog.");
  return catalog;
}

function storedColumn(
  catalog: Catalog,
  tableSql: string,
  columnSql: string,
): ColumnDefinition | undefined {
  for (const object of catalog.objects) {
    if (object.kind !== "column") continue;
    if (object.identity.parent.name !== tableSql || object.identity.name !== columnSql) continue;
    return object.definition;
  }
  return undefined;
}

function canOmit(definition: ColumnDefinition): boolean {
  return (
    definition.nullable ||
    definition.defaultExpression !== undefined ||
    definition.identity !== undefined ||
    definition.generated !== undefined
  );
}

type Sql = Sink & { finish(): Statement };

function text(): Sql {
  const parts: string[] = [];
  const params: (string | null)[] = [];
  let n = 0;
  return {
    text(value) {
      parts.push(value);
    },
    param(encoded) {
      n += 1;
      params.push(encoded);
      parts.push(`$${String(n)}`);
    },
    mark() {},
    finish() {
      return { text: parts.join(""), params };
    },
  };
}
