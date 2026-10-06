/**
 * Factories: `create`, `createMany`, `with({ child: n })`, and `x.ref`.
 *
 * A required column the definition leaves out is filled from its type (D199).
 * `x.ref` reuses the latest row of that table in the same tenant, or creates one.
 */

import { OkmError } from "../../contracts/error.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import type { Connected } from "../../runtime/types.js";
import {
  isRequired,
  type ColumnFacts,
  type ForeignKey,
  type TableFacts,
  type TestingSchema,
} from "./facts.js";
import type { Rng } from "./random.js";

const REF = Symbol("okm.factory.ref");

/** A `x.ref("table")` marker. Resolved when the row is inserted. */
type FactoryRef = { readonly [REF]: string };

/** Values a factory definition may return. */
export type FactoryContext = {
  /** `userN@example.com`. N increases for each call. */
  email(): string;
  /** A first and last name from a fixed list. */
  name(): string;
  /** `count` words from a fixed list. */
  words(count: number): string;
  /** An integer in `[0, bound)`. `bound` defaults to 10_000. */
  int(bound?: number): number;
  /** A number in `[0, 1)`. */
  float(): number;
  /** A boolean. */
  boolean(): boolean;
  /** An ISO date `YYYY-MM-DD` in January 2020. */
  date(): string;
  /** A UUID from the seed. */
  uuid(): string;
  /** One entry of `list`. */
  pick<T>(list: readonly T[]): T;
  /**
   * The primary key of `table`.
   *
   * The first call creates the row. A later call in the same tenant reuses it.
   * A `create` of that table replaces the reused row.
   */
  ref(table: string): FactoryRef;
};

/** One table's factory. */
export type TableFactory = {
  /**
   * Inserts one row.
   *
   * @param overrides - Column values. A tenant key here is the scope, not a column.
   * @returns The inserted row
   */
  create(overrides?: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;
  /**
   * Inserts `count` rows. Each row draws new generated values.
   *
   * @param count - How many rows
   * @param overrides - Column values applied to every row
   * @returns The inserted rows
   */
  createMany(
    count: number,
    overrides?: Readonly<Record<string, unknown>>,
  ): Promise<readonly Record<string, unknown>[]>;
  /**
   * Creates `count` rows of `child` after the parent, linked by the foreign key.
   *
   * @param children - Child table name to how many rows
   * @returns A factory that still inserts this table
   */
  with(children: Readonly<Record<string, number>>): TableFactory;
};

const hosts = new WeakMap<object, FactoryHost>();

/**
 * Remembers `host` for the harness object `okm seed` prints from.
 *
 * @param harness - The object returned by `testing()`
 * @param host - Its factory state
 */
export function attachHost(harness: object, host: FactoryHost): void {
  hosts.set(harness, host);
}

/**
 * Rows inserted through factories, summed by table name.
 *
 * @param harness - The object returned by `testing()`
 * @returns Counts in table-name order
 */
export function createdOf(
  harness: object,
): readonly { readonly table: string; readonly count: number }[] {
  const created = hosts.get(harness)?.created ?? new Map<string, number>();
  return [...created.entries()]
    .map(([table, count]) => ({ table, count }))
    .sort((left, right) => (left.table < right.table ? -1 : left.table > right.table ? 1 : 0));
}

/** Shared state for one harness. */
export type FactoryHost = {
  readonly schema: TestingSchema;
  readonly db: Connected<TestingSchema>;
  readonly facts: ReadonlyMap<string, TableFacts>;
  readonly rng: Rng;
  /** Latest row of a table in one tenant. Isolation uses its own map. */
  cache: Map<string, Record<string, unknown>>;
  /** Tables currently being inserted. A repeat is a factory cycle. */
  readonly creating: Set<string>;
  readonly created: Map<string, number>;
  readonly definitions: Map<string, (context: FactoryContext) => Readonly<Record<string, unknown>>>;
};

/**
 * Builds the factory object for `definitions`.
 *
 * @param host - Schema, client, and seed
 * @param definitions - One function per table
 * @returns A factory per definition
 */
export function bindFactories(
  host: FactoryHost,
  definitions: Readonly<
    Record<string, (context: FactoryContext) => Readonly<Record<string, unknown>>>
  >,
): Record<string, TableFactory> {
  const bound: Record<string, TableFactory> = {};
  for (const name of Object.keys(definitions)) {
    if (!host.facts.has(name)) {
      throw new OkmError("invalid", `Factory ${name} is not a table in the schema.`, {
        fix: { summary: `Use a table name: ${[...host.facts.keys()].join(", ")}.` },
      });
    }
    const define = definitions[name];
    if (define !== undefined) host.definitions.set(name, define);
    bound[name] = factoryFor(host, name, undefined);
  }
  return bound;
}

/**
 * Inserts one row, filling required columns. Used by factories and by isolation.
 *
 * @param host - Schema, client, and seed
 * @param table - Table name
 * @param overrides - Column values and the tenant key
 * @param children - Child counts from `with`
 * @param inherited - Tenant from the parent row, when this row is a child
 * @returns The inserted row
 */
export async function insertRow(
  host: FactoryHost,
  table: string,
  overrides: Readonly<Record<string, unknown>> | undefined,
  children: Readonly<Record<string, number>> | undefined,
  inherited: string | undefined,
): Promise<Record<string, unknown>> {
  if (host.creating.has(table)) {
    throw new OkmError("invalid", `Factory cycle at ${table}.`, {
      fix: { summary: "A ref() points back at a row that is still being created." },
    });
  }
  host.creating.add(table);
  try {
    return await insertPrepared(host, table, overrides, children, inherited);
  } finally {
    host.creating.delete(table);
  }
}

async function insertPrepared(
  host: FactoryHost,
  table: string,
  overrides: Readonly<Record<string, unknown>> | undefined,
  children: Readonly<Record<string, number>> | undefined,
  inherited: string | undefined,
): Promise<Record<string, unknown>> {
  const facts = requireTable(host, table);
  const defined = host.definitions.get(table)?.(context(host)) ?? {};
  const merged: Record<string, unknown> = { ...defined, ...overrides };
  const key = host.schema.tenancy?.key;
  const taken = takeTenant(merged, facts.tenant ? key : undefined);
  const requested = taken.tenant ?? inherited;
  const tenant = facts.tenant ? (requested ?? host.rng.uuid()) : undefined;
  const resolved = await resolveRefs(host, taken.rest, tenant);
  await fillRequired(host, facts, resolved, tenant);
  const row = await writeRow(host, facts, resolved, tenant);
  host.cache.set(cacheKey(table, facts.tenant ? tenant : undefined), row);
  host.created.set(table, (host.created.get(table) ?? 0) + 1);
  if (children !== undefined) {
    for (const child of Object.keys(children)) {
      const count = children[child];
      if (count === undefined) continue;
      if (!Number.isInteger(count) || count < 0) {
        throw new OkmError("invalid", `with({ ${child}: ${String(count)} }) needs a count.`, {
          fix: { summary: "Pass a non-negative integer." },
        });
      }
      const link = linkFields(host, facts, requireTable(host, child), row);
      for (let index = 0; index < count; index += 1) {
        await insertRow(host, child, link, undefined, tenant);
      }
    }
  }
  return row;
}

function factoryFor(
  host: FactoryHost,
  table: string,
  children: Readonly<Record<string, number>> | undefined,
): TableFactory {
  return {
    create(overrides) {
      return insertRow(host, table, overrides, children, undefined);
    },
    async createMany(count, overrides) {
      if (!Number.isInteger(count) || count < 0) {
        throw new OkmError(
          "invalid",
          `createMany needs a non-negative integer, got ${String(count)}.`,
          {
            fix: { summary: "Pass how many rows to insert." },
          },
        );
      }
      const rows: Record<string, unknown>[] = [];
      for (let index = 0; index < count; index += 1) {
        rows.push(await insertRow(host, table, overrides, children, undefined));
      }
      return rows;
    },
    with(extra) {
      return factoryFor(host, table, { ...children, ...extra });
    },
  };
}

function context(host: FactoryHost): FactoryContext {
  return {
    email: () => host.rng.email(),
    name: () => host.rng.name(),
    words: (count) => host.rng.words(count),
    int: (bound) => host.rng.int(bound ?? 10_000),
    float: () => host.rng.float(),
    boolean: () => host.rng.boolean(),
    date: () => host.rng.date(),
    uuid: () => host.rng.uuid(),
    pick: (list) => host.rng.pick(list),
    ref(table: string): FactoryRef {
      if (!host.facts.has(table)) {
        throw new OkmError("invalid", `ref(${table}) is not a table in the schema.`, {
          fix: { summary: `Use a table name: ${[...host.facts.keys()].join(", ")}.` },
        });
      }
      return { [REF]: table };
    },
  };
}

function takeTenant(
  row: Record<string, unknown>,
  key: string | undefined,
): { readonly tenant: string | undefined; readonly rest: Record<string, unknown> } {
  if (key === undefined || !Object.hasOwn(row, key)) return { tenant: undefined, rest: row };
  const value = row[key];
  const rest = { ...row };
  delete rest[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OkmError("invalid", `${key} must be a uuid string.`, {
      fix: { summary: `Pass create({ ${key} }) the tenant uuid.` },
    });
  }
  return { tenant: value, rest };
}

async function resolveRefs(
  host: FactoryHost,
  row: Readonly<Record<string, unknown>>,
  tenant: string | undefined,
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  for (const field of Object.keys(row)) {
    const value = row[field];
    const target = refOf(value);
    if (target === undefined) {
      resolved[field] = value;
      continue;
    }
    resolved[field] = primaryValue(
      await referenced(host, target, tenant),
      requireTable(host, target),
      host.schema.tenancy?.key,
    );
  }
  return resolved;
}

async function fillRequired(
  host: FactoryHost,
  facts: TableFacts,
  row: Record<string, unknown>,
  tenant: string | undefined,
): Promise<void> {
  for (const column of facts.columns) {
    if (!isRequired(column) || Object.hasOwn(row, column.field)) continue;
    const foreign = facts.foreignKeys.find((key) => key.columns.includes(column.sql));
    if (foreign !== undefined) {
      const target = factsBySql(host, foreign.target);
      const parent = await referenced(host, target.name, tenant);
      assignForeign(host, facts, foreign, parent, row);
      if (Object.hasOwn(row, column.field)) continue;
    }
    row[column.field] = valueFor(host, column);
  }
}

function assignForeign(
  host: FactoryHost,
  child: TableFacts,
  foreign: ForeignKey,
  parent: Record<string, unknown>,
  row: Record<string, unknown>,
): void {
  const target = factsBySql(host, foreign.target);
  const key = host.schema.tenancy?.key;
  for (let index = 0; index < foreign.columns.length; index += 1) {
    const childSql = foreign.columns[index];
    const parentSql = foreign.targetColumns[index];
    if (childSql === undefined || parentSql === undefined) continue;
    const field = fieldOf(child, childSql);
    const source = fieldOf(target, parentSql);
    if (field === undefined || source === undefined || field === key) continue;
    if (!Object.hasOwn(row, field)) row[field] = parent[source];
  }
}

async function referenced(
  host: FactoryHost,
  table: string,
  tenant: string | undefined,
): Promise<Record<string, unknown>> {
  const facts = requireTable(host, table);
  const scope = facts.tenant ? tenant : undefined;
  const cached = host.cache.get(cacheKey(table, scope));
  if (cached !== undefined) return cached;
  return insertRow(
    host,
    table,
    scope === undefined ? undefined : tenantOverride(host, scope),
    undefined,
    scope,
  );
}

function tenantOverride(host: FactoryHost, tenant: string): Record<string, unknown> | undefined {
  const key = host.schema.tenancy?.key;
  if (key === undefined) return undefined;
  return { [key]: tenant };
}

function linkFields(
  host: FactoryHost,
  parent: TableFacts,
  child: TableFacts,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const many = parent.relations.find(
    (relation) => relation.kind === "many" && relation.table === child.name,
  );
  if (many !== undefined) return paired(host, child, parent, many.remote, many.local, row);
  const one = child.relations.find(
    (relation) => relation.kind === "one" && relation.table === parent.name,
  );
  if (one !== undefined) return paired(host, child, parent, one.local, one.remote, row);
  const foreign = child.foreignKeys.find((key) => key.target === parent.sql);
  if (foreign !== undefined) {
    const linked: Record<string, unknown> = {};
    assignForeign(host, child, foreign, row, linked);
    if (Object.keys(linked).length > 0) return linked;
  }
  throw new OkmError("invalid", `with() cannot link ${child.name} to ${parent.name}.`, {
    fix: { summary: "Add a foreign key from the child table to the parent, or a many() relation." },
  });
}

function paired(
  host: FactoryHost,
  child: TableFacts,
  parent: TableFacts,
  childSql: readonly string[],
  parentSql: readonly string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const key = host.schema.tenancy?.key;
  const linked: Record<string, unknown> = {};
  for (let index = 0; index < childSql.length; index += 1) {
    const childName = childSql[index];
    const parentName = parentSql[index];
    if (childName === undefined || parentName === undefined) continue;
    const field = fieldOf(child, childName);
    const source = fieldOf(parent, parentName);
    if (field === undefined || source === undefined || field === key) continue;
    linked[field] = row[source];
  }
  if (Object.keys(linked).length === 0) {
    throw new OkmError("invalid", `with() cannot link ${child.name} to ${parent.name}.`, {
      fix: { summary: "The relation has no column to set on the child." },
    });
  }
  return linked;
}

async function writeRow(
  host: FactoryHost,
  facts: TableFacts,
  data: Record<string, unknown>,
  tenant: string | undefined,
): Promise<Record<string, unknown>> {
  const client =
    facts.tenant && tenant !== undefined
      ? openScope(host.db, host.schema.tenancy?.key ?? "tenantId", tenant)
      : host.db;
  const handle = tableHandle(client, facts.name);
  const inserted: unknown = await handle.insert(data);
  if (!isRow(inserted)) {
    throw new OkmError("invalid", `Insert on ${facts.name} did not return a row.`, {
      fix: { summary: "The insert returns the row. Check the table's primary key." },
    });
  }
  return inserted;
}

function valueFor(host: FactoryHost, column: ColumnFacts): unknown {
  const candidates = candidatesFor(host, column);
  for (const value of candidates) {
    try {
      column.encode(value);
      return value;
    } catch {
      // The next candidate matches the codec.
    }
  }
  throw new OkmError("invalid", `No factory default for ${column.field} (${column.dataType}).`, {
    fix: { summary: "Set the column in the factory." },
  });
}

function candidatesFor(host: FactoryHost, column: ColumnFacts): readonly unknown[] {
  const type = column.dataType.toLowerCase().replace(/\[\]$/, "");
  const accepts = column.accepts ?? [];
  const n = host.rng.counter();
  const values: unknown[] = [];
  if (accepts.includes("Temporal.Instant")) {
    values.push(Temporal.Instant.from(`2020-01-01T00:00:${String(n % 60).padStart(2, "0")}Z`));
  }
  if (accepts.includes("Temporal.PlainDate")) {
    values.push(Temporal.PlainDate.from(`2020-01-${String((n % 28) + 1).padStart(2, "0")}`));
  }
  if (accepts.includes("Temporal.PlainDateTime")) {
    values.push(Temporal.PlainDateTime.from(`2020-01-01T00:00:${String(n % 60).padStart(2, "0")}`));
  }
  if (accepts.includes("Temporal.PlainTime")) {
    values.push(Temporal.PlainTime.from(`00:00:${String(n % 60).padStart(2, "0")}`));
  }
  if (accepts.includes("Temporal.Duration")) values.push(Temporal.Duration.from({ seconds: n }));
  if (
    type === "json" ||
    type === "jsonb" ||
    accepts.includes("Object") ||
    accepts.includes("Array")
  ) {
    values.push({});
  }
  if (type === "uuid") values.push(host.rng.uuid());
  if (type === "bool" || type === "boolean") values.push(host.rng.boolean());
  if (
    type === "smallint" ||
    type === "integer" ||
    type === "int" ||
    type === "int2" ||
    type === "int4"
  ) {
    values.push(n);
  }
  if (type === "bigint" || type === "int8") {
    values.push(String(n), n, BigInt(n));
  }
  if (type.startsWith("numeric") || type.startsWith("decimal")) {
    values.push(`${String(n)}.00`, n);
  }
  if (type === "real" || type === "double precision" || type === "float4" || type === "float8") {
    values.push(n);
  }
  const labels = enumLabels(host.schema.catalog, column.dataType);
  if (labels !== undefined && labels.length > 0) values.push(labels[0]);
  values.push(`${host.rng.words(2)} ${String(n)}`);
  return values;
}

function enumLabels(catalog: Catalog, dataType: string): readonly string[] | undefined {
  for (const object of catalog.objects) {
    if (object.kind !== "type" || object.identity.name !== dataType) continue;
    const definition = object.definition;
    if ("labels" in definition && Array.isArray(definition.labels)) return definition.labels;
  }
  return undefined;
}

function primaryValue(
  row: Record<string, unknown>,
  facts: TableFacts,
  tenantKey: string | undefined,
): unknown {
  const fields = facts.primary.filter((field) => field !== tenantKey);
  if (fields.length !== 1) {
    throw new OkmError("invalid", `ref(${facts.name}) needs a single primary key.`, {
      fix: { summary: "Set the foreign-key columns in the factory." },
    });
  }
  const field = fields[0];
  if (field === undefined) {
    throw new OkmError("invalid", `ref(${facts.name}) needs a primary key.`, {
      fix: { summary: "Give the table a primary key." },
    });
  }
  return row[field];
}

function requireTable(host: FactoryHost, name: string): TableFacts {
  const facts = host.facts.get(name);
  if (facts === undefined) {
    throw new OkmError("invalid", `Table ${name} is not in the schema.`, {
      fix: { summary: `Use a table name: ${[...host.facts.keys()].join(", ")}.` },
    });
  }
  return facts;
}

function factsBySql(host: FactoryHost, sql: string): TableFacts {
  for (const facts of host.facts.values()) {
    if (facts.sql === sql) return facts;
  }
  throw new OkmError("invalid", `No table uses SQL name ${sql}.`, {
    fix: { summary: "The foreign key target is not in this schema." },
  });
}

function fieldOf(facts: TableFacts, sql: string): string | undefined {
  return facts.columns.find((column) => column.sql === sql)?.field;
}

function cacheKey(table: string, tenant: string | undefined): string {
  return `${tenant ?? "*"}:${table}`;
}

function refOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !(REF in value)) return undefined;
  const table = (value as { readonly [REF]: unknown })[REF];
  return typeof table === "string" ? table : undefined;
}

function openScope(db: object, key: string, tenant: string): object {
  if (!("for" in db) || typeof db.for !== "function") {
    throw new OkmError("invalid", "This schema has no for().", {
      fix: { summary: "Pass columnTenancy() to schema({ tenancy })." },
    });
  }
  const opened: unknown = db.for({ [key]: tenant });
  if (typeof opened !== "object" || opened === null) {
    throw new OkmError("invalid", "for() did not return a client.", {
      fix: { summary: "The tenant key must be a uuid." },
    });
  }
  return opened;
}

type TableHandle = {
  insert(data: object): Promise<unknown>;
};

function tableHandle(client: object, name: string): TableHandle {
  if (!("table" in client) || typeof client.table !== "function") {
    throw new OkmError("invalid", "The client has no table().", {
      fix: { summary: "Connect with the schema before inserting." },
    });
  }
  const handle: unknown = client.table(name);
  if (
    typeof handle !== "object" ||
    handle === null ||
    !("insert" in handle) ||
    typeof handle.insert !== "function"
  ) {
    throw new OkmError("invalid", `Table ${name} is not on this client.`, {
      fix: { summary: "A tenant table is reached with for({ tenantId })." },
    });
  }
  return handle as TableHandle;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
