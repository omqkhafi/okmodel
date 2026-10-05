/**
 * Random operations on the gate schema, and the one function that runs them.
 *
 * An operation is plain data, so a failing fast-check run prints a case a person
 * can read and replay. `runOp` turns it into client calls; `settle` turns the
 * result or the `OkmError` into a value that two runs can compare.
 */

import fc from "fast-check";

import { OkmError } from "../src/contracts/error.js";
import { has, none } from "../src/dialects/pg/index.js";
import { key, POOL, TENANT_TABLES, type TenantTable } from "./gate-schema.js";

/** Which rows a call sees. */
export type View = "active" | "with" | "only";

/** A write, as data. */
export type WriteOp =
  | {
      readonly t: "insert";
      readonly table: TenantTable;
      readonly n: number;
      readonly label: number;
      readonly parent: number;
      readonly other: number;
    }
  | {
      readonly t: "update";
      readonly table: TenantTable;
      readonly n: number;
      readonly label: number;
      readonly parent: number;
      readonly chain: readonly number[];
    }
  | {
      readonly t: "delete";
      readonly table: TenantTable;
      readonly n: number;
      readonly view: "active" | "only";
      readonly chain: readonly number[];
    }
  | {
      readonly t: "archive";
      readonly table: TenantTable;
      readonly n: number;
      readonly chain: readonly number[];
    }
  | { readonly t: "restore"; readonly table: TenantTable; readonly n: number }
  | { readonly t: "restoreGroup"; readonly table: TenantTable; readonly n: number };

/** A read, as data. */
export type ReadOp =
  | {
      readonly t: "find";
      readonly table: TenantTable;
      readonly view: View;
      readonly chain: readonly number[];
      readonly where: number;
      readonly label: number;
      readonly include: number;
      readonly limit: number;
    }
  | {
      readonly t: "count";
      readonly table: TenantTable;
      readonly view: View;
      readonly chain: readonly number[];
    }
  | {
      readonly t: "exists";
      readonly table: TenantTable;
      readonly view: View;
      readonly chain: readonly number[];
    }
  | { readonly t: "one"; readonly table: TenantTable; readonly view: View; readonly n: number }
  | { readonly t: "page"; readonly table: TenantTable; readonly view: View; readonly limit: number }
  | {
      readonly t: "aggregate";
      readonly table: TenantTable;
      readonly view: View;
      readonly chain: readonly number[];
    };

/** A transaction, as data. */
export type TxOp = {
  readonly t: "tx";
  readonly ops: readonly (WriteOp | ReadOp)[];
  readonly inner: { readonly ops: readonly (WriteOp | ReadOp)[]; readonly fail: boolean } | null;
  readonly after: readonly (WriteOp | ReadOp)[];
  readonly retry: number;
  readonly isolation: "read committed" | "repeatable read" | "serializable";
  readonly fail: boolean;
};

/** A batch, as data. */
export type BatchOp = { readonly t: "batch"; readonly ops: readonly WriteOp[] };

/** Any operation. */
export type Op = WriteOp | ReadOp | TxOp | BatchOp;

/** One tenant doing one operation. */
export type Step = { readonly who: 0 | 1; readonly op: Op };

/** Presets each table offers. */
export const PRESETS: Readonly<Record<TenantTable, readonly string[]>> = {
  orgs: [],
  projects: ["starred", "rich", "inOrg"],
  tasks: ["starred", "open", "urgent"],
  labels: [],
  projectLabels: [],
};

/** Name of the column a table is filtered and made unique by. */
const NAME_FIELD: Readonly<Record<TenantTable, string>> = {
  orgs: "name",
  projects: "name",
  tasks: "title",
  labels: "name",
  projectLabels: "id",
};

/** Letter of the table's ids in {@link key}. */
const KIND = { orgs: "o", projects: "p", tasks: "t", labels: "l", projectLabels: "j" } as const;

/** Includes each table offers, as a list the op picks from. */
const INCLUDES: Readonly<Record<TenantTable, readonly object[]>> = {
  orgs: [{ projects: { limit: 3 } }],
  projects: [
    { org: true },
    { tasks: { limit: 3 } },
    { labels: { limit: 3 } },
    { org: true, tasks: { limit: 3 }, labels: { limit: 3 } },
  ],
  tasks: [{ project: true }],
  labels: [{ projects: { limit: 3 } }],
  projectLabels: [{ project: true, label: true }, { label: true }],
};

/** A table API, as the gate tests call it. Every method takes plain data. */
export type Handle = {
  readonly [method: string]: (...args: unknown[]) => unknown;
};

/** A client the gate tests drive: a scoped client or a transaction client. */
export type Client = { readonly [table: string]: unknown };

/** Thrown by a step that asks for a rollback. */
export class Rollback extends Error {
  constructor() {
    super("rollback requested by the test");
  }
}

/** The name pool: three names, shared by both tenants. */
export function name(label: number): string {
  return `n${String(label)}`;
}

/**
 * The preset names a chain picks on a table.
 *
 * @param table - Table
 * @param chain - Indexes into the table's presets
 * @returns Preset names, at most two, without repeats
 */
export function pickPresets(table: TenantTable, chain: readonly number[]): string[] {
  const names = PRESETS[table];
  if (names.length === 0) return [];
  const chosen: string[] = [];
  for (const index of chain) {
    const preset = names[index % names.length];
    if (preset !== undefined && !chosen.includes(preset)) chosen.push(preset);
  }
  return chosen;
}

function call(target: unknown, method: string, ...args: unknown[]): unknown {
  const fn = (target as Handle)[method];
  if (typeof fn !== "function") throw new Error(`no method ${method}`);
  return fn.apply(target, args);
}

/**
 * The handle for a table with a view and presets applied.
 *
 * @param client - A scoped client or a transaction client
 * @param table - Table
 * @param view - Which rows it sees
 * @param chain - Preset indexes
 * @returns The handle
 */
export function handle(
  client: Client,
  table: TenantTable,
  view: View,
  chain: readonly number[],
): Handle {
  let current = client[table] as Handle;
  if (view === "with") current = call(current, "withArchived") as Handle;
  if (view === "only") current = call(current, "onlyArchived") as Handle;
  for (const preset of pickPresets(table, chain)) {
    current =
      preset === "inOrg"
        ? (call(current, preset, key("o", 0)) as Handle)
        : (call(current, preset) as Handle);
  }
  return current;
}

function row(op: Extract<WriteOp, { t: "insert" }>): object {
  const id = key(KIND[op.table], op.n);
  switch (op.table) {
    case "orgs":
      return { id, name: name(op.label) };
    case "projects":
      return { id, orgId: key("o", op.parent), name: name(op.label), budget: op.label * 100 };
    case "tasks":
      return {
        id,
        projectId: key("p", op.parent),
        title: name(op.label),
        priority: op.label + 1,
      };
    case "labels":
      return { id, name: name(op.label) };
    case "projectLabels":
      return { id, projectId: key("p", op.parent), labelId: key("l", op.other) };
  }
}

function setOf(op: Extract<WriteOp, { t: "update" }>): object {
  switch (op.table) {
    case "orgs":
      return { name: name(op.label) };
    case "projects":
      return { name: name(op.label), budget: op.label * 100 };
    case "tasks":
      return { title: name(op.label), done: op.label === 1, priority: op.label + 1 };
    case "labels":
      return { name: name(op.label) };
    case "projectLabels":
      return { labelId: key("l", op.parent) };
  }
}

/**
 * Starts a write and returns its handle, not awaited, so `batch` can take it.
 *
 * @param client - A scoped client or a transaction client
 * @param op - The write
 * @returns A thenable
 */
export function startWrite(client: Client, op: WriteOp): PromiseLike<unknown> {
  const id = key(KIND[op.table], op.n);
  switch (op.t) {
    case "insert":
      return call(
        handle(client, op.table, "active", []),
        "insert",
        row(op),
      ) as PromiseLike<unknown>;
    case "update":
      return call(handle(client, op.table, "active", op.chain), "update", {
        where: { id },
        set: setOf(op),
      }) as PromiseLike<unknown>;
    case "delete":
      return call(handle(client, op.table, op.view, op.chain), "delete", {
        where: { id },
      }) as PromiseLike<unknown>;
    case "archive":
      return call(handle(client, op.table, "active", op.chain), "archive", {
        where: { id },
      }) as PromiseLike<unknown>;
    case "restore":
      return call(handle(client, op.table, "only", []), "restore", {
        where: { id },
      }) as PromiseLike<unknown>;
    case "restoreGroup":
      return (async () => {
        const found = (await call(handle(client, op.table, "only", []), "find", {
          where: { id },
          limit: 1,
        })) as readonly { readonly archiveId: string | null }[];
        const archiveId = found[0]?.archiveId;
        if (archiveId === undefined || archiveId === null) return { count: 0 };
        return await (call(handle(client, op.table, "only", []), "restore", {
          archiveId,
        }) as PromiseLike<unknown>);
      })();
  }
}

function whereOf(op: Extract<ReadOp, { t: "find" }>): object | undefined {
  const field = NAME_FIELD[op.table];
  switch (op.where) {
    case 1:
      return op.table === "projectLabels" ? undefined : { [field]: name(op.label) };
    case 2:
      if (op.table === "projects") return { tasks: has({ title: name(op.label) }) };
      if (op.table === "orgs") return { projects: has({ name: name(op.label) }) };
      if (op.table === "labels") return { projects: has({ name: name(op.label) }) };
      return undefined;
    case 3:
      if (op.table === "projects") return { labels: none({ name: name(op.label) }) };
      if (op.table === "orgs") return { projects: none({ name: name(op.label) }) };
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Runs one read or write against a client and returns what it gave back.
 *
 * @param client - A scoped client or a transaction client
 * @param op - The operation
 * @returns The value the call resolved to
 */
export async function runLeaf(client: Client, op: WriteOp | ReadOp): Promise<unknown> {
  switch (op.t) {
    case "insert":
    case "update":
    case "delete":
    case "archive":
    case "restore":
    case "restoreGroup":
      return await startWrite(client, op);
    case "find": {
      const includes = INCLUDES[op.table];
      const include =
        op.view === "only" || includes.length === 0
          ? undefined
          : includes[op.include % (includes.length + 1)];
      const where = whereOf(op);
      return await (call(handle(client, op.table, op.view, op.chain), "find", {
        ...(where !== undefined ? { where } : {}),
        ...(include !== undefined ? { include } : {}),
        orderBy: { id: "asc" },
        limit: op.limit,
      }) as PromiseLike<unknown>);
    }
    case "count":
      return await (call(
        handle(client, op.table, op.view, op.chain),
        "count",
      ) as PromiseLike<unknown>);
    case "exists":
      return await (call(
        handle(client, op.table, op.view, op.chain),
        "exists",
      ) as PromiseLike<unknown>);
    case "one":
      return await (call(handle(client, op.table, op.view, []), "one", {
        where: { id: key(KIND[op.table], op.n) },
      }) as PromiseLike<unknown>);
    case "page": {
      const items: unknown[] = [];
      let after: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = (await call(handle(client, op.table, op.view, []), "page", {
          orderBy: { id: "asc" },
          limit: op.limit,
          ...(after !== null ? { after } : {}),
        })) as { readonly items: readonly unknown[]; readonly next: string | null };
        items.push(...page.items);
        if (page.next === null) break;
        after = page.next;
      }
      return items;
    }
    case "aggregate":
      return await (call(handle(client, op.table, op.view, op.chain), "aggregate", {
        count: true,
        ...(op.table === "projects" ? { sum: ["budget"] } : {}),
        ...(op.table === "tasks" ? { sum: ["priority"] } : {}),
      }) as PromiseLike<unknown>);
  }
}

/** A value two runs can compare. */
export type Settled =
  | { readonly ok: unknown }
  | { readonly error: { readonly code: string; readonly kind: string } };

/** Error categories a random operation may end in. Anything else fails the property. */
const EXPECTED_CATEGORIES = new Set(["input", "conflict", "not_found"]);

/**
 * Runs `fn` and returns its value, or the code and kind of the `OkmError` it threw.
 *
 * An error outside the expected categories (a safety violation, a driver failure, a
 * plain `Error`) is rethrown, so the property fails on it.
 *
 * @param fn - The call
 * @returns The settled value
 */
export async function settle(fn: () => PromiseLike<unknown>): Promise<Settled> {
  try {
    return { ok: await fn() };
  } catch (error) {
    if (error instanceof OkmError && EXPECTED_CATEGORIES.has(error.category)) {
      return { error: { code: error.code, kind: error.kind } };
    }
    throw error;
  }
}

/** Fields that differ between two runs of the same steps, and how the comparison treats them. */
export class Canon {
  private readonly groups = new Map<string, string>();

  /**
   * Rewrites a result so two runs of the same steps compare equal.
   *
   * Timestamps are dropped, `archivedAt` becomes a flag, and an `archiveId`
   * becomes the order in which it first appeared.
   *
   * @param value - A result
   * @returns The same shape without run-specific values
   */
  normalise(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.normalise(item));
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(value)) {
      if (field === "createdAt" || field === "updatedAt") continue;
      if (field === "created_at" || field === "updated_at") continue;
      if (field === "archivedAt" || field === "archived_at") {
        out[field] = item !== null;
      } else if (field === "archiveId" || field === "archive_id") {
        out[field] = typeof item === "string" ? this.group(item) : item;
      } else {
        out[field] = this.normalise(item);
      }
    }
    return out;
  }

  /** The label of an archive id: `g1` for the first one seen, `g2` for the next. */
  group(id: string): string {
    const known = this.groups.get(id);
    if (known !== undefined) return known;
    const label = `g${String(this.groups.size + 1)}`;
    this.groups.set(id, label);
    return label;
  }
}

/**
 * Every `tenantId` in a result, however deep.
 *
 * @param value - A result
 * @returns The values found
 */
export function tenantsIn(value: unknown): string[] {
  const found: string[] = [];
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry);
    } else if (item !== null && typeof item === "object") {
      for (const [field, entry] of Object.entries(item)) {
        if (field === "tenantId" && typeof entry === "string") found.push(entry);
        else walk(entry);
      }
    }
  };
  walk(value);
  return found;
}

// ── arbitraries ─────────────────────────────────────────────────────────────

const table = fc.constantFrom(...TENANT_TABLES);
const n = fc.integer({ min: 0, max: POOL - 1 });
const label = fc.integer({ min: 0, max: 2 });
const chain = fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 2 });
const view = fc.constantFrom<View>("active", "with", "only");

const insert: fc.Arbitrary<WriteOp> = fc.record({
  t: fc.constant("insert" as const),
  table,
  n,
  label,
  parent: n,
  other: n,
});
const update: fc.Arbitrary<WriteOp> = fc.record({
  t: fc.constant("update" as const),
  table,
  n,
  label,
  parent: n,
  chain,
});
const remove: fc.Arbitrary<WriteOp> = fc.record({
  t: fc.constant("delete" as const),
  table,
  n,
  view: fc.constantFrom("active" as const, "only" as const),
  chain,
});
const archive: fc.Arbitrary<WriteOp> = fc.record({
  t: fc.constant("archive" as const),
  table,
  n,
  chain,
});
const restore: fc.Arbitrary<WriteOp> = fc.record({ t: fc.constant("restore" as const), table, n });
const restoreGroup: fc.Arbitrary<WriteOp> = fc.record({
  t: fc.constant("restoreGroup" as const),
  table,
  n,
});

/** Any single write. Inserts weigh most, so there is data to act on. */
export const writeOp: fc.Arbitrary<WriteOp> = fc.oneof(
  { arbitrary: insert, weight: 5 },
  { arbitrary: update, weight: 2 },
  { arbitrary: remove, weight: 2 },
  { arbitrary: archive, weight: 3 },
  { arbitrary: restore, weight: 2 },
  { arbitrary: restoreGroup, weight: 1 },
);

/** Any single read. */
export const readOp: fc.Arbitrary<ReadOp> = fc.oneof(
  {
    arbitrary: fc.record({
      t: fc.constant("find" as const),
      table,
      view,
      chain,
      where: fc.integer({ min: 0, max: 3 }),
      label,
      include: fc.integer({ min: 0, max: 4 }),
      limit: fc.integer({ min: 1, max: 6 }),
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ t: fc.constant("count" as const), table, view, chain }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant("exists" as const), table, view, chain }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant("one" as const), table, view, n }), weight: 1 },
  {
    arbitrary: fc.record({
      t: fc.constant("page" as const),
      table,
      view,
      limit: fc.integer({ min: 1, max: 3 }),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ t: fc.constant("aggregate" as const), table, view, chain }), weight: 1 },
);

const leaf = fc.oneof(writeOp, readOp);

/** A batch of one to three writes. */
export const batchOp: fc.Arbitrary<BatchOp> = fc.record({
  t: fc.constant("batch" as const),
  // A batch takes no restore (D183). `batch-refusals.test.ts` covers the refusal.
  ops: fc.array(
    writeOp.filter((op) => op.t !== "restore" && op.t !== "restoreGroup"),
    { minLength: 1, maxLength: 3 },
  ),
});

/** A transaction with an optional nested savepoint. */
export const txOp: fc.Arbitrary<TxOp> = fc.record({
  t: fc.constant("tx" as const),
  ops: fc.array(leaf, { maxLength: 3 }),
  inner: fc.option(fc.record({ ops: fc.array(leaf, { maxLength: 3 }), fail: fc.boolean() }), {
    nil: null,
  }),
  after: fc.array(leaf, { maxLength: 2 }),
  retry: fc.integer({ min: 0, max: 3 }),
  isolation: fc.constantFrom(
    "read committed" as const,
    "repeatable read" as const,
    "serializable" as const,
  ),
  fail: fc.boolean(),
});

/** Any operation. */
export const anyOp: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: writeOp, weight: 6 },
  { arbitrary: readOp, weight: 6 },
  { arbitrary: batchOp, weight: 2 },
  { arbitrary: txOp, weight: 3 },
);

/** Steps in which each tenant is equally likely to act. */
export function steps(max: number): fc.Arbitrary<Step[]> {
  return fc.array(fc.record({ who: fc.constantFrom<0 | 1>(0, 1), op: anyOp }), {
    minLength: 6,
    maxLength: max,
  });
}

/**
 * Inserts the same small data set for a tenant, with the same ids and names as the other.
 *
 * @param who - Tenant index
 * @returns Steps that create two projects, two tasks, a label and a join row
 */
export function seed(who: 0 | 1): Step[] {
  const insertRow = (
    table: TenantTable,
    index: number,
    labelIndex: number,
    parent: number,
    other = 0,
  ): Step => ({
    who,
    op: { t: "insert", table, n: index, label: labelIndex, parent, other },
  });
  return [
    insertRow("orgs", 0, 0, 0),
    insertRow("orgs", 1, 1, 0),
    insertRow("projects", 0, 0, 0),
    insertRow("projects", 1, 1, 1),
    insertRow("tasks", 0, 0, 0),
    insertRow("tasks", 1, 1, 1),
    insertRow("labels", 0, 0, 0),
    insertRow("projectLabels", 0, 0, 0, 0),
  ];
}

/** The table API method that runs a top-level write, for a step to report. */
export const NAME_FIELDS = NAME_FIELD;
