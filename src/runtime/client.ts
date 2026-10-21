/**
 * Connected client: plan cache, one endpoint, and the read methods.
 *
 * `connect()` starts the dialect and `requires` checks. Queries wait for them.
 * The plan cache is per client and bounded.
 */

import type { DriverPool, ExecuteOptions, WireValue } from "../contracts/driver.js";
import type { IdGenerators } from "../contracts/generator.js";
import {
  OkmError,
  safe,
  throwNamed,
  type ErrorStatuses,
  type OkmErrorOptions,
} from "../contracts/error.js";
import type { MapPostgresErrorOptions, MapPostgresErrorSchema } from "../dialects/pg/errors.js";
import type { PresetUse, QuerySchema } from "../dialects/pg/model.js";
import {
  appliedRules,
  archiveRules,
  bindCall,
  compileCall,
  decodeResult,
  logicalIntent,
  readNeedsOperatorSql,
  copiedReadKeys,
  readOptionNames,
  rejectKeys,
  type AppliedRule,
  type ArchiveView,
  type IncludeHooks,
  type Plan,
  type ReadCall,
  type CallScope,
  type ReadOp,
} from "./plan.js";
import type {
  CatalogArtifact,
  Connected,
  Hookm,
  Inspection,
  RoutingDecision,
  TableApi,
  Timeouts,
} from "./types.js";

/** How many plans one client keeps. */
const PLAN_LIMIT = 64;

/** A client's connection state. The lazy read modules take it. */
export type Session = {
  readonly schema: QuerySchema;
  readonly pool: DriverPool;
  readonly ownsPool: boolean;
  readonly http: ErrorStatuses | undefined;
  readonly includeValues: boolean;
  readonly logger:
    | { error?(entry: { readonly code: string; readonly summary: string }): void }
    | undefined;
  readonly connected: Promise<void>;
  readonly cache: Map<string, Plan>;
  /** `connect({ catalogDir })`. The typed raw lock sits beside `catalog.json`. */
  readonly dir: string | undefined;
  readonly generators: IdGenerators | undefined;
  /** Ceilings from `connect({ timeouts })`. */
  readonly timeouts: Timeouts | undefined;
  /** Observers from `connect({ hookm })`. */
  readonly hookm: readonly Hookm[] | undefined;
  /**
   * Write-observer slot from `connect({ onWrite })`.
   *
   * Shared by reference across `held()` session copies. Controller loads lazily.
   */
  readonly o?: import("./observe-emit.js").ObservingSlot;
  /**
   * Warning slot from `connect({ warnings })`.
   *
   * `undefined` when the caller did not pass one. The property stays present so
   * the assignment does not need a spread.
   */
  readonly w: ((schema: QuerySchema, call: ReadCall, stack?: string) => void) | undefined;
  /**
   * Query observer from `connect({ onQuery })`.
   *
   * `undefined` when the caller did not pass one. Present so the assignment
   * does not need a spread.
   */
  readonly q: object | undefined;
  /** Set on the client a transaction hands out. `extras` are the methods only that client has. */
  readonly tx?: { readonly extras: object; readonly depth: number };
  /** Tenant value or an unscoped reason. Absent on the root client. */
  readonly scope?: CallScope;
  /**
   * Shared close. `for()` and `unscoped()` reuse the same promise.
   *
   * `early` is set when `close()` runs before `connected` settles (QA-M5).
   */
  readonly closing: { current: Promise<void> | undefined; early: boolean };
};

/** Per-call modifiers of a read. */
export type Mods = {
  readonly all?: string;
  readonly required?: boolean;
  /** Presets chained on the handle. The presets module resolves them on first use. */
  readonly uses?: PresetUse | undefined;
};

const SINGLE_ENDPOINT: RoutingDecision = {
  endpoint: "primary",
  role: "primary",
  reason: "single-endpoint",
};

/**
 * Builds a client for one pool.
 *
 * @param schema - Caller schema
 * @param pool - Endpoint pool
 * @param options - Errors, logger, and whether `close` ends the pool
 * @returns The typed client
 */
export function createClient<S extends QuerySchema>(
  schema: S,
  pool: DriverPool,
  options: {
    readonly endpoint?: string;
    readonly ownsPool?: boolean;
    readonly http?: ErrorStatuses | undefined;
    readonly includeValues?: boolean | undefined;
    readonly errors?: {
      readonly http?: ErrorStatuses | undefined;
      readonly includeValues?: boolean | undefined;
    };
    readonly logger?: Session["logger"] | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly timeout?: number | undefined;
    readonly timeouts?: Timeouts | undefined;
    readonly hookm?: readonly Hookm[] | undefined;
    readonly onWrite?: import("./observe-types.js").OnWrite | undefined;
    readonly warnings?: ((schema: QuerySchema, call: ReadCall, stack?: string) => void) | undefined;
    readonly onQuery?: object | undefined;
    readonly catalog?: CatalogArtifact | undefined;
    readonly catalogDir?: string | undefined;
    readonly requireMeta?: boolean | undefined;
    readonly generators?: IdGenerators | undefined;
  },
  ownsPool?: boolean,
): Connected<S> {
  const http = options.http ?? options.errors?.http;
  const includeValues = (options.includeValues ?? options.errors?.includeValues) === true;
  const owned = ownsPool ?? options.ownsPool === true;
  const closing: { current: Promise<void> | undefined; early: boolean } = {
    current: undefined,
    early: false,
  };
  const checked = checkServer(
    pool,
    schema,
    http,
    options.requireMeta === true,
    callOptions(options),
    options,
    options.onWrite,
  );
  // QA-M5: `connected` always has a handler. A caller that closes before awaiting
  // it must not leave a rejection unhandled. A caller who awaits it later gets
  // a clear error instead of the pool's.
  const connected = checked.catch((error: unknown) => {
    if (!closing.early) throw error;
    throw new OkmError(
      "unavailable",
      "The client was closed before it connected. Await connected before close(), or do not close it before use.",
      { kind: "unavailable", fix: { summary: "Await client.connected before calling close()." } },
    );
  });
  connected.catch(() => undefined);
  const session: Session = {
    schema,
    pool,
    ownsPool: owned,
    http,
    includeValues,
    logger: options.logger,
    connected,
    cache: new Map(),
    dir: options.catalogDir,
    generators: options.generators,
    timeouts: options.timeouts,
    hookm: options.hookm,
    ...(options.onWrite !== undefined ? { o: { w: options.onWrite, c: undefined } } : {}),
    w: options.warnings,
    q: options.onQuery,
    closing,
  };
  return openClient(session);
}

export function openClient<S extends QuerySchema>(session: Session): Connected<S> {
  const names = Object.keys(session.schema.model);
  const tables: Record<string, TableApi<QuerySchema, string>> = {};
  for (const name of names) tables[name] = tableApi(session, name);
  const close = (): Promise<void> => {
    if (!session.ownsPool) return Promise.resolve();
    session.closing.early = true;
    session.closing.current ??= session.pool.close();
    return session.closing.current;
  };
  const client: Record<string, unknown> = {
    ...tables,
    table(name: string) {
      const found = tables[name];
      if (found !== undefined) return found;
      try {
        if (
          session.schema.model[name] !== undefined &&
          session.schema.tenancy !== undefined &&
          session.scope === undefined
        ) {
          session.schema.tenancy.missing(name);
        }
        throwNamed(
          "OKM1120",
          name,
          names,
          `Table ${name} is not in the schema. Accepted names: ${names.join(", ")}.`,
        );
      } catch (error) {
        if (error instanceof OkmError) throw attachHttp(session.http, error);
        throw error;
      }
    },
    close,
    connected: session.connected,
    capabilities: session.pool.capabilities,
    tx: (...args: unknown[]) => import("./transaction.js").then((mod) => mod.tx(session, args)),
    batch: (ops: unknown, options?: object) => batchHandle(session, ops, options),
    ...session.tx?.extras,
  };
  const hooks = session.schema.hooks;
  if (hooks !== undefined) {
    for (const hook of hooks) {
      hook(client, {
        names,
        tables,
        scoped: session.scope !== undefined,
        open: (scope) => openClient({ ...session, scope }),
      });
    }
  }
  attachAsyncDispose(client, close);
  return client as unknown as Connected<S>;
}

/**
 * Adds `[Symbol.asyncDispose]` when the runtime defines it.
 *
 * Older engines have no such symbol. Reading it there is `undefined`, so the
 * client is left unchanged.
 *
 * @param client - The connected client
 * @param close - Idempotent close for this client
 */
function attachAsyncDispose(client: object, close: () => Promise<void>): void {
  const symbol = (Symbol as { readonly asyncDispose?: symbol }).asyncDispose;
  if (typeof symbol !== "symbol") return;
  Object.defineProperty(client, symbol, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: () => close(),
  });
}

function tableApi(
  session: Session,
  table: string,
  view?: ArchiveView,
  uses?: PresetUse,
): TableApi<QuerySchema, string> {
  const base: Mods = { uses };
  const mods: WriteMods = { archive: view, uses };
  const api: Record<string, unknown> = {
    find(options: object = {}) {
      if ("lock" in options) {
        return lazyRead(session, () => import("./lock.js"), table, options, base, view);
      }
      if ("distinct" in options || "distinctOn" in options) {
        return lazyRead(session, () => import("./distinct.js"), table, options, base, view);
      }
      return start(session, "find", table, options, base, view);
    },
    one(options: object = {}) {
      return start(session, "one", table, options, base, view);
    },
    count(options: object = {}) {
      return start(session, "count", table, options, base, view);
    },
    exists(options: object = {}) {
      return start(session, "exists", table, options, base, view);
    },
    page(options: object) {
      return lazyRead(session, () => import("./page.js"), table, options, base, view);
    },
    aggregate(options: object = {}) {
      return lazyRead(session, () => import("./aggregate.js"), table, options, base, view);
    },
    insert(data: unknown, options: object = {}) {
      return writeHandle(session, "insert", table, data, options, mods);
    },
    update(target: unknown, options: object = {}) {
      return writeHandle(session, "update", table, target, options, mods);
    },
    delete(target: unknown, options: object = {}) {
      return writeHandle(session, "delete", table, target, options, mods);
    },
  };
  // One arrow for both walks. `sync` is the same loader with `expect` instead of `all`.
  for (const walk of ["descendants", "ancestors"]) {
    api[walk] = (id: unknown, options?: object) =>
      lazyRead(session, () => import("./tree.js"), table, { id, walk, options }, base, view);
  }
  api.sync = (id: unknown, relation: unknown, ids: unknown, options?: object) =>
    lazyRead(
      session,
      () => import("./sync.js"),
      table,
      { id, relation, ids, options },
      base,
      view,
      true,
    );
  const hooks = session.schema.hooks;
  if (hooks !== undefined) {
    for (const hook of hooks) {
      hook(api, {
        table,
        ...(view !== undefined ? { view } : {}),
        uses,
        reopen: (next) =>
          tableApi(session, table, next, uses) as unknown as Record<string, unknown>,
        session,
      });
    }
  }
  // A preset records the call. The presets module runs it when the handle is used.
  for (const name in session.schema.model[table]?.presets as object) {
    api[name] = (...args: unknown[]) => tableApi(session, table, view, [uses, name, args]);
  }
  // `raw` and `explain` read this. The symbol is not a method, so an app that
  // never imports those functions does not keep them.
  (api as Record<symbol, unknown>)[Symbol.for("okm.lane")] = [session, table, mapError, loadRaw];
  return api as unknown as TableApi<QuerySchema, string>;
}

/** `batch` loads its module when it is awaited. `.replica()` is refused there (OKM1840). */
function batchHandle(
  session: Session,
  ops: unknown,
  options: object | undefined,
  replica?: true,
): Promise<unknown> & Record<string, unknown> {
  return queryHandle(
    () => import("./batch.js").then((mod) => mod.batch(session, ops, options, replica)),
    {
      replica: () => batchHandle(session, ops, options, true),
    },
  ) as unknown as Promise<unknown> & Record<string, unknown>;
}

type WriteOp = "insert" | "update" | "delete";
type WriteMods = {
  readonly all?: string;
  readonly expect?: number;
  readonly archive?: ArchiveView | undefined;
  readonly uses?: PresetUse | undefined;
};

/** The typed `raw(db, sql, params)` chunk. `raw` calls it through the lane. */
const loadRaw = (): Promise<typeof import("./raw.js")> => import("./raw.js");

let writers: Promise<typeof import("./write.js")> | undefined;

function loadWrite(): Promise<typeof import("./write.js")> {
  writers ??= import("./write.js");
  return writers;
}

/**
 * A query handle that starts its work once, the first time it is awaited.
 *
 * @param run - The work. Called at most once
 * @param extra - Methods that stay on the handle beside `then`
 * @returns The handle
 */
export function queryHandle<T extends object>(
  run: () => Promise<unknown>,
  extra: T,
): Promise<unknown> & T {
  let pending: Promise<unknown> | undefined;
  const once = (): Promise<unknown> => {
    pending ??= run();
    return pending;
  };
  const self = {
    // oxlint-disable-next-line unicorn/no-thenable
    then(onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
      return once().then(onFulfilled, onRejected);
    },
    catch(onRejected?: (error: unknown) => unknown) {
      return self.then(undefined, onRejected);
    },
    finally(fn: () => void) {
      return self.then(
        (value) => {
          fn();
          return value;
        },
        (error: unknown) => {
          fn();
          throw error;
        },
      );
    },
    safe() {
      return safe(once());
    },
    ...extra,
  };
  return self as unknown as Promise<unknown> & T;
}

function writeHandle(
  session: Session,
  op: WriteOp,
  table: string,
  input: unknown,
  options: object,
  mods: WriteMods,
): Promise<unknown> & Record<string, unknown> {
  const view = (kind: "sql" | "inspect" | "describe") =>
    loadWrite().then((mod) => mod.explainHandle(session, op, table, input, options, mods, kind));
  return queryHandle(() => runWrite(session, op, table, input, options, mods), {
    // `batch` plans each operation and runs the statements of all of them as one unit.
    "~plan": () => runWrite(session, op, table, input, options, mods, true),
    sql: () => view("sql"),
    inspect: () => view("inspect"),
    describe: () => view("describe"),
    expect(count: number) {
      return writeHandle(session, op, table, input, options, { ...mods, expect: count });
    },
    all(reason: string) {
      return writeHandle(session, op, table, input, options, { ...mods, all: reason });
    },
  }) as unknown as Promise<unknown> & Record<string, unknown>;
}

async function runWrite(
  session: Session,
  op: WriteOp,
  table: string,
  input: unknown,
  options: object,
  mods: WriteMods,
  plan?: true,
): Promise<unknown> {
  await session.connected;
  const mod = await loadWrite();
  try {
    return await mod.executeWrite(session, op, table, input, options, mods, session.scope, plan);
  } catch (error) {
    throw logged(session, await mapError(session, error));
  }
}

function rejectedRead(error: unknown): Promise<unknown> & Record<string, unknown> {
  const fail = (): Promise<never> => Promise.reject(error);
  return queryHandle(fail, {
    all: () => rejectedRead(error),
    required: () => rejectedRead(error),
    inspect: fail,
    sql: fail,
    stream() {
      return {
        [Symbol.asyncIterator]() {
          return { next: fail };
        },
      };
    },
  }) as unknown as Promise<unknown> & Record<string, unknown>;
}

function start(
  session: Session,
  op: ReadOp,
  table: string,
  options: object,
  mods: Mods,
  view?: ArchiveView,
): Promise<unknown> & Record<string, unknown> {
  const model = session.schema.model[table];
  let call: ReadCall;
  try {
    call = readCall(op, table, options, mods.all, session.scope, model, session.schema, view);
  } catch (error) {
    return rejectedRead(error instanceof OkmError ? attachHttp(session.http, error) : error);
  }
  return readHandle(
    session,
    table,
    call,
    mods,
    async (plan, rows) => {
      const value = await decodeRows(plan, rows, table);
      if (mods.required === true && value === null) {
        throw new OkmError(
          "not_found",
          `one() on ${table} matched no row.`,
          withHttp(session.http, { kind: "not_found", table }),
        );
      }
      return value;
    },
    () => ({
      all(reason: string) {
        return start(session, op, table, options, { ...mods, all: reason }, view);
      },
      required() {
        return start(session, op, table, options, { ...mods, required: true }, view);
      },
      stream(batch?: object) {
        return streamLazy(session, call, mods, view, batch);
      },
    }),
  );
}

/** What a lazy read module exports: the handle for one call. */
type LazyRead = {
  readonly build: (
    session: Session,
    table: string,
    options: object,
    mods: Mods,
    view: ArchiveView | undefined,
  ) => Promise<unknown> & Record<string, unknown>;
};

/**
 * `page`, `aggregate`, and a tree walk plan in their own chunks. `sync` uses
 * the same loader: `expect` instead of `inspect` and `all`.
 *
 * The chunk loads on the first await, `sql()`, or `inspect()`. A failed import
 * fails the call. The tenant and active-set predicates live in the planner, so
 * a call that cannot load never runs without them.
 *
 * @param sync - When true, the handle has `expect` and not `inspect` or `all`
 */
function lazyRead(
  session: Session,
  load: () => Promise<LazyRead>,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
  sync?: true,
): Promise<unknown> & Record<string, unknown> {
  // The handle is a thenable, so it travels inside an object to stay a handle.
  const read = () => load().then((mod) => ({ it: mod.build(session, table, options, mods, view) }));
  const sql = () => read().then((box) => (box.it.sql as () => unknown)());
  const extra: Record<string, unknown> = { sql };
  if (sync) {
    extra.expect = (count: number) =>
      lazyRead(session, load, table, options, { ...mods, expect: count } as Mods, view, true);
  } else {
    extra.inspect = () => read().then((box) => (box.it.inspect as () => unknown)());
    extra.all = (reason: string) =>
      lazyRead(session, load, table, options, { ...mods, all: reason }, view);
  }
  return queryHandle(() => read().then((box) => box.it), extra) as unknown as Promise<unknown> &
    Record<string, unknown>;
}

/** A bound plan and its wire parameters. */
type Prepared = { readonly plan: Plan; readonly params: readonly (string | null)[] };

/** Rows as the driver returns them. */
type Rows = readonly (readonly (string | null)[])[];

/**
 * Decodes the rows of a prepared read, with includes when the plan has them.
 *
 * @param plan - Compiled plan
 * @param rows - Wire rows
 * @param table - Table name, for `not_unique`
 * @returns Rows, one row or null, a count, or a boolean
 */
export async function decodeRows(plan: Plan, rows: Rows, table: string): Promise<unknown> {
  return plan.outputs.includes.length === 0
    ? decodeResult(plan, rows, table)
    : (await import("./include.js")).decodeIncluded(plan, rows, table);
}

/**
 * A lazy read handle for one planned call.
 *
 * `find`, `one`, `count`, and `exists` use it, and so do the lazy `page` and
 * `aggregate` modules. It plans once, caches the plan per client, maps the
 * error, and offers `inspect` and `sql`.
 *
 * @param session - Client session
 * @param table - Table name
 * @param call - The read
 * @param mods - Signal and timeout
 * @param decode - Turns the wire rows into the result
 * @param extra - Methods that belong to this read, given the memoised prepare
 * @returns The handle
 */
export function readHandle(
  session: Session,
  table: string,
  call: ReadCall,
  mods: Mods,
  decode: (plan: Plan, rows: Rows) => unknown,
  extra?: (prepare: () => Promise<Prepared>) => Record<string, unknown>,
): Promise<unknown> & Record<string, unknown> {
  let prepared: Prepared | undefined;
  const origin = call;
  const warnStack = session.w && new Error().stack;
  const searched = "search" in call;
  const prepare = async (): Promise<Prepared> => {
    if (prepared !== undefined) return prepared;
    if (mods.uses !== undefined) {
      call = (await import("./presets.js")).refine(session.schema, origin, mods.uses);
    }
    if (searched) {
      call = (await import("./text-search.js")).applyTextSearch(session.schema, call);
    }
    const hooks = await hooksFor(call);
    if (readNeedsOperatorSql(session.schema, call) || hooks?.needsOperator(session.schema, call)) {
      await loadOperatorSql();
    }
    if (call.build === undefined && selectHasWindow(call.select)) {
      call = (await import("./window.js")).attach(session.schema, call);
    }
    session.w?.(session.schema, call, warnStack);
    const bound = bindCall(session.schema, call, hooks);
    let plan = session.cache.get(bound.key);
    if (plan === undefined) {
      plan = compileCall(session.schema, call, bound.key, hooks);
      if (session.cache.size >= PLAN_LIMIT) {
        const oldest = session.cache.keys().next().value;
        if (oldest !== undefined) session.cache.delete(oldest);
      }
      session.cache.set(bound.key, plan);
    }
    prepared = { plan, params: bound.params };
    return prepared;
  };
  // True when the statement can be planned now: no include, no preset, no operator SQL to load.
  const sync = (): boolean =>
    !searched &&
    call.include === undefined &&
    mods.uses === undefined &&
    !selectHasWindow(call.select) &&
    !readNeedsOperatorSql(session.schema, call);
  const run = async (): Promise<unknown> => {
    await session.connected;
    const { plan, params } = await prepare();
    // 65,533 matches postgres.js (refuses at 65,534). Keep the literal here so
    // the param-limit chunk stays out of the featureless startup graph (B-48).
    if (params.length > 65_533) {
      (await import("./param-limit.js")).refuseParamLimit(params.length);
    }
    if (session.q !== undefined) {
      return (await import("./observe-query.js")).runObservedRead(
        session,
        table,
        plan,
        params,
        call,
        decode,
      );
    }
    try {
      const result = await session.pool.execute(
        plan.text,
        params as readonly WireValue[],
        callOptions(call, session.timeouts?.statement),
      );
      if (session.hookm && result.notices.length) {
        void import("./hookm.js").then((mod) => mod.notices(session.hookm, result.notices));
      }
      return await decode(plan, result.rows);
    } catch (error) {
      return failRead(session, table, call, error);
    }
  };
  return queryHandle(run, {
    // A query is awaitable and also has inspect/sql/safe. It stays lazy until awaited.
    inspect(): Inspection | Promise<Inspection> {
      const source = session.schema.model[table]?.source;
      if (call.include === undefined && prepared !== undefined) {
        return finish(session, inspection(prepared.plan, prepared.params, call, source), call);
      }
      if (sync()) {
        const bound = bindNow(session, call);
        prepared = bound;
        return finish(session, inspection(bound.plan, bound.params, call, source), call);
      }
      return prepare().then(({ plan, params }) =>
        finish(session, inspection(plan, params, call, source), call),
      );
    },
    sql() {
      if (call.include === undefined && prepared !== undefined) {
        return { text: prepared.plan.text, params: prepared.params };
      }
      if (sync()) {
        const { plan, params } = bindNow(session, call);
        prepared = { plan, params };
        return { text: plan.text, params };
      }
      return prepare().then(({ plan, params }) => ({ text: plan.text, params }));
    },
    ...extra?.(prepare),
  }) as unknown as Promise<unknown> & Record<string, unknown>;
}

function streamLazy(
  session: Session,
  call: ReadCall,
  mods: Mods,
  view: ArchiveView | undefined,
  batch: object | undefined,
): AsyncIterable<unknown> {
  return (async function* () {
    const { streamRows } = await import("./read-stream.js");
    yield* streamRows(session, call, mods, view, batch, (error) => logged(session, error));
  })();
}

function archiveRecord(
  model: QuerySchema["model"][string] | undefined,
  view: ArchiveView | undefined,
): { readonly ruleLines: readonly AppliedRule[] } | undefined {
  if (model?.archive === undefined) return undefined;
  const rules = archiveRules(model, view);
  if (rules === undefined) return undefined;
  return { ruleLines: rules };
}

/**
 * Builds the logical read from caller options.
 *
 * @param op - Read kind
 * @param table - Table name
 * @param options - `where`, `select`, `orderBy`, `limit`, `include`
 * @param all - Reason given to `.all`
 * @param scope - Tenant scope, when the client has one
 * @param model - Table model
 * @param schema - Connected schema
 * @param view - Archive visibility
 * @returns The call the planner binds
 */
export function readCall(
  op: ReadOp,
  table: string,
  options: object,
  all: string | undefined,
  scope: CallScope | undefined,
  model: QuerySchema["model"][string] | undefined,
  schema: QuerySchema,
  view?: ArchiveView,
): ReadCall {
  const record = options as Record<string, unknown>;
  rejectKeys(record, readOptionNames(op), op, true);
  const call: Record<string, unknown> = {
    op,
    table,
    ...callOptions(record),
    ...archiveRecord(model, view),
  };
  for (const key of copiedReadKeys) {
    if (record[key] !== undefined) call[key] = record[key];
  }
  if ("search" in record) call.search = record.search;
  if (all !== undefined) call.all = all;
  if (scope !== undefined) call.scope = scope;
  if (schema.tenancy !== undefined && model !== undefined) {
    call.tenancyRules = schema.tenancy.rules(table, model.source, scope);
  }
  if (view !== undefined) call.archive = view;
  return call as ReadCall;
}

async function checkServer(
  pool: DriverPool,
  schema: QuerySchema,
  http: ErrorStatuses | undefined,
  requireMeta: boolean,
  options: ExecuteOptions | undefined,
  source: {
    readonly catalog?: CatalogArtifact | undefined;
    readonly catalogDir?: string | undefined;
  },
  onWrite: object | undefined,
): Promise<void> {
  const { acceptServer } = await import("./server-check.js");
  await acceptServer(pool, schema, http, requireMeta, options, source, onWrite);
}

export async function failRead(
  session: Session,
  table: string,
  call: ReadCall,
  error: unknown,
): Promise<never> {
  const mapped = await mapError(session, error);
  if (session.schema.model[table]?.conceal !== true) throw logged(session, mapped);
  const { scrubCall } = await import("./exposure.js");
  throw logged(session, scrubCall(mapped, session.schema, call));
}

async function mapError(session: Session, error: unknown): Promise<OkmError> {
  if (error instanceof OkmError) {
    return session.http === undefined
      ? error
      : new OkmError(error.code, error.message, { ...errorFields(error), http: session.http });
  }
  const { mapPostgresError } = await import("../dialects/pg/errors.js");
  return mapPostgresError(error, mapOptions(session.http, session.includeValues, session.schema));
}

function errorFields(error: OkmError): {
  readonly kind: OkmError["kind"];
  readonly table?: string;
  readonly columns?: readonly string[];
  readonly fix?: OkmError["fix"];
} {
  return {
    kind: error.kind,
    ...(error.table !== undefined ? { table: error.table } : {}),
    ...(error.columns.length > 0 ? { columns: error.columns } : {}),
    fix: error.fix,
  };
}

let includeHooks: Promise<IncludeHooks> | undefined;

let operatorSql: Promise<void> | undefined;

function loadOperatorSql(): Promise<void> {
  operatorSql ??= import("./operator-sql.js").then(() => undefined);
  return operatorSql;
}

/** A non-string `select` entry is a window helper. Field names stay on the plain path. */
function selectHasWindow(select: unknown): boolean {
  return Array.isArray(select) && select.some((item) => typeof item !== "string");
}

function hooksFor(call: ReadCall): Promise<IncludeHooks | undefined> {
  if (call.include === undefined) return Promise.resolve(undefined);
  includeHooks ??= import("./include.js").then((mod) => mod.includeHooks);
  return includeHooks;
}

function bindNow(
  session: Session,
  call: ReadCall,
): { readonly plan: Plan; readonly params: readonly (string | null)[] } {
  session.w?.(session.schema, call);
  const bound = bindCall(session.schema, call);
  const plan = compileCall(session.schema, call, bound.key);
  return { plan, params: bound.params };
}

function finish(
  session: Session,
  view: Inspection,
  call: ReadCall,
): Inspection | Promise<Inspection> {
  if (session.schema.model[call.table]?.conceal !== true) return view;
  return import("./exposure.js").then((mod) => mod.redactView(session.schema, view, call));
}

function inspection(
  plan: Plan,
  params: readonly (string | null)[],
  call: ReadCall,
  source?: string,
): Inspection {
  return {
    intent: logicalIntent(call),
    rules: appliedRules(call, source),
    plan: { strategy: "postgres:single-statement", statements: 1, fingerprint: plan.fingerprint },
    sql: { text: plan.text, params },
    routing: SINGLE_ENDPOINT,
  };
}

/**
 * Attaches connect's HTTP statuses to options for one {@link OkmError}.
 *
 * @param http - Statuses from `connect({ errors })`
 * @param options - Error options that do not yet name a status map
 * @returns Options `toHttp()` can read
 */
export function withHttp(
  http: ErrorStatuses | undefined,
  options: OkmErrorOptions,
): OkmErrorOptions {
  return http === undefined ? options : { ...options, http };
}

/**
 * Copies `error` so {@link OkmError.toHttp} uses the statuses from `connect`.
 *
 * @param http - Statuses from `connect({ errors })`. Omitted, `error` is returned
 * @param error - Failure that did not carry those statuses
 * @returns The error `toHttp()` reads
 */
export function attachHttp(http: ErrorStatuses | undefined, error: OkmError): OkmError {
  if (http === undefined) return error;
  return new OkmError(error.code, error.message, { ...errorFields(error), http });
}

export function callOptions(
  input: {
    readonly signal?: AbortSignal | undefined;
    readonly timeout?: number | undefined;
    readonly route?: "primary" | "replica" | undefined;
    readonly pin?: { name?: string } | undefined;
  },
  statement?: number,
): (ExecuteOptions & { readonly pin?: { name?: string } }) | undefined {
  const timeout = input.timeout ?? statement;
  const route = input.route;
  const pin = input.pin;
  if (
    input.signal === undefined &&
    timeout === undefined &&
    route === undefined &&
    pin === undefined
  ) {
    return undefined;
  }
  return {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(route !== undefined ? { route } : {}),
    ...(pin !== undefined ? { pin } : {}),
  };
}

/**
 * Statuses and schema the Postgres error mapper reads.
 *
 * @param http - Status overrides from `connect`
 * @param includeValues - When true, a mapped error may include bound values
 * @param schema - Schema whose names the mapper can mention
 * @returns Mapper options
 */
export function mapOptions(
  http: ErrorStatuses | undefined,
  includeValues: boolean,
  schema: QuerySchema,
): MapPostgresErrorOptions {
  return {
    ...(http !== undefined ? { http } : {}),
    ...(includeValues ? { includeValues: true } : {}),
    schema: schema as QuerySchema & MapPostgresErrorSchema,
  };
}

/**
 * Maps a driver or query error and records it on the session logger.
 *
 * The archive hook uses this so a failed statement stays an `OkmError`.
 *
 * @param session - Pool, statuses, and logger
 * @param error - Rejection from the driver or the statement chunk
 * @returns Never. The mapped error is thrown
 */
export async function settleCall(session: Session, error: unknown): Promise<never> {
  throw logged(session, await mapError(session, error));
}

function logged(session: Session, error: OkmError): OkmError {
  session.logger?.error?.({ code: error.code, summary: error.summary });
  return error;
}
