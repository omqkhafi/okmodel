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
import type { MapPostgresErrorOptions } from "../dialects/pg/errors.js";
import type { PresetUse, QuerySchema } from "../dialects/pg/model.js";
import {
  appliedRules,
  archiveRules,
  bindCall,
  compileCall,
  decodeResult,
  logicalIntent,
  readNeedsOperatorSql,
  readOptionNames,
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
  readonly generators: IdGenerators | undefined;
  /** Ceilings from `connect({ timeouts })`. */
  readonly timeouts: Timeouts | undefined;
  /** Observers from `connect({ hookm })`. */
  readonly hookm: readonly Hookm[] | undefined;
  /** Set on the client a transaction hands out. `extras` are the methods only that client has. */
  readonly tx?: { readonly extras: object; readonly depth: number };
  /** Tenant value or an unscoped reason. Absent on the root client. */
  readonly scope?: CallScope;
  /** Shared close. `for()` and `unscoped()` reuse the same promise. */
  readonly closing: { current: Promise<void> | undefined };
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
    readonly ownsPool: boolean;
    readonly http?: ErrorStatuses | undefined;
    readonly includeValues?: boolean | undefined;
    readonly logger?: Session["logger"] | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly timeout?: number | undefined;
    readonly timeouts?: Timeouts | undefined;
    readonly hookm?: readonly Hookm[] | undefined;
    readonly catalog?: CatalogArtifact | undefined;
    readonly catalogDir?: string | undefined;
    readonly requireMeta?: boolean | undefined;
    readonly generators?: IdGenerators | undefined;
  },
): Connected<S> {
  const connected = checkServer(
    pool,
    schema,
    options.http,
    options.requireMeta === true,
    callOptions(options),
    {
      ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
      ...(options.catalogDir !== undefined ? { catalogDir: options.catalogDir } : {}),
    },
  );
  const session: Session = {
    schema,
    pool,
    ownsPool: options.ownsPool,
    http: options.http,
    includeValues: options.includeValues === true,
    logger: options.logger,
    connected,
    cache: new Map(),
    generators: options.generators,
    timeouts: options.timeouts,
    hookm: options.hookm,
    closing: { current: undefined },
  };
  return openClient(session);
}

export function openClient<S extends QuerySchema>(session: Session): Connected<S> {
  const names = Object.keys(session.schema.model);
  const tables: Record<string, TableApi<QuerySchema, string>> = {};
  for (const name of names) tables[name] = tableApi(session, name);
  const close = (): Promise<void> => {
    if (!session.ownsPool) return Promise.resolve();
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
  return queryHandle(() => runWrite(session, op, table, input, options, mods), {
    // `batch` plans each operation and runs the statements of all of them as one unit.
    "~plan": () => runWrite(session, op, table, input, options, mods, true),
    sql() {
      return loadWrite().then((mod) =>
        mod.explainWrite(
          session.schema,
          op,
          table,
          input,
          options,
          mods,
          session.generators,
          session.scope,
        ),
      );
    },
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

function start(
  session: Session,
  op: ReadOp,
  table: string,
  options: object,
  mods: Mods,
  view?: ArchiveView,
): Promise<unknown> & Record<string, unknown> {
  const model = session.schema.model[table];
  const call = readCall(op, table, options, mods.all, session.scope, model, session.schema, view);
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
    (prepare) => ({
      all(reason: string) {
        return start(session, op, table, options, { ...mods, all: reason }, view);
      },
      required() {
        return start(session, op, table, options, { ...mods, required: true }, view);
      },
      stream() {
        return streamLazy(session, call, prepare);
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
 * `page` and `aggregate` plan in their own chunks.
 *
 * The chunk loads on the first await, `sql()`, or `inspect()`. A failed import
 * fails the call. The tenant and active-set predicates live in the planner, so
 * a call that cannot load never runs without them.
 */
function lazyRead(
  session: Session,
  load: () => Promise<LazyRead>,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  // The handle is a thenable, so it travels inside an object to stay a handle.
  const read = () => load().then((mod) => ({ it: mod.build(session, table, options, mods, view) }));
  return queryHandle(() => read().then((box) => box.it), {
    inspect: () => read().then((box) => (box.it.inspect as () => unknown)()),
    sql: () => read().then((box) => (box.it.sql as () => unknown)()),
    all: (reason: string) =>
      lazyRead(session, load, table, options, { ...mods, all: reason }, view),
  }) as unknown as Promise<unknown> & Record<string, unknown>;
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
  const prepare = async (): Promise<Prepared> => {
    if (prepared !== undefined) return prepared;
    if (mods.uses !== undefined) {
      call = (await import("./presets.js")).refine(session.schema, origin, mods.uses);
    }
    if (readNeedsOperatorSql(session.schema, call)) await loadOperatorSql();
    const hooks = await hooksFor(call);
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
    call.include === undefined &&
    mods.uses === undefined &&
    !readNeedsOperatorSql(session.schema, call);
  const run = async (): Promise<unknown> => {
    await session.connected;
    const { plan, params } = await prepare();
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
      const mapped = await mapError(session, error);
      if (session.schema.model[table]?.conceal !== true) throw logged(session, mapped);
      const { scrubCall } = await import("./exposure.js");
      throw logged(session, scrubCall(mapped, session.schema, call));
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
        const bound = bindNow(session.schema, call);
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
        const { plan, params } = bindNow(session.schema, call);
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
  prepare: () => Promise<Prepared>,
): AsyncIterable<unknown> {
  return (async function* () {
    const { streamRows } = await import("./read-stream.js");
    yield* streamRows(session, call, prepare, (error) => logged(session, error));
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
  const accepted = readOptionNames(op);
  for (const key of Object.keys(record)) {
    if (!accepted.includes(key)) {
      throwNamed(
        "OKM1120",
        key,
        accepted,
        `Option ${key} is not accepted by ${op}. Accepted options: ${accepted.join(", ")}.`,
      );
    }
  }
  return {
    op,
    table,
    ...(record.where !== undefined ? { where: record.where } : {}),
    ...(record.select !== undefined ? { select: record.select } : {}),
    ...(record.orderBy !== undefined ? { orderBy: record.orderBy } : {}),
    ...(record.limit !== undefined ? { limit: record.limit } : {}),
    ...(record.include !== undefined ? { include: record.include } : {}),
    ...callOptions(record),
    ...(all !== undefined ? { all } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(schema.tenancy !== undefined && model !== undefined
      ? { tenancyRules: schema.tenancy.rules(table, model.source, scope) }
      : {}),
    ...(view !== undefined ? { archive: view } : {}),
    ...archiveRecord(model, view),
  };
}

async function checkServer(
  pool: DriverPool,
  schema: QuerySchema,
  http: ErrorStatuses | undefined,
  requireMeta: boolean,
  options: ExecuteOptions | undefined,
  source: { readonly catalog?: CatalogArtifact; readonly catalogDir?: string },
): Promise<void> {
  const server = await import("./server-check.js");
  let rows: readonly (readonly (string | null)[])[];
  try {
    const result = await pool.execute(server.versionQuery, undefined, options);
    rows = result.rows;
  } catch (error) {
    const { mapPostgresError } = await import("../dialects/pg/errors.js");
    throw mapPostgresError(error, mapOptions(http, false));
  }
  await server.acceptServer(pool, schema, rows, http, requireMeta, options, source);
}

async function mapError(session: Session, error: unknown): Promise<OkmError> {
  if (error instanceof OkmError) {
    return session.http === undefined
      ? error
      : new OkmError(error.code, error.message, { ...errorFields(error), http: session.http });
  }
  const { mapPostgresError } = await import("../dialects/pg/errors.js");
  return mapPostgresError(error, mapOptions(session.http, session.includeValues));
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

function hooksFor(call: ReadCall): Promise<IncludeHooks | undefined> {
  if (call.include === undefined) return Promise.resolve(undefined);
  includeHooks ??= import("./include.js").then((mod) => mod.includeHooks);
  return includeHooks;
}

function bindNow(
  schema: Session["schema"],
  call: ReadCall,
): { readonly plan: Plan; readonly params: readonly (string | null)[] } {
  const bound = bindCall(schema, call);
  const plan = compileCall(schema, call, bound.key);
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

function callOptions(
  input: {
    readonly signal?: AbortSignal | undefined;
    readonly timeout?: number | undefined;
  },
  statement?: number,
): ExecuteOptions | undefined {
  const timeout = input.timeout ?? statement;
  if (input.signal === undefined && timeout === undefined) return undefined;
  return {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function mapOptions(
  http: ErrorStatuses | undefined,
  includeValues: boolean,
): MapPostgresErrorOptions {
  return {
    ...(http !== undefined ? { http } : {}),
    ...(includeValues ? { includeValues: true } : {}),
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
