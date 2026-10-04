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
import type { QuerySchema } from "../dialects/pg/model.js";
import {
  appliedRules,
  bindCall,
  compileCall,
  decodeResult,
  logicalIntent,
  readNeedsOperatorSql,
  type IncludeHooks,
  type Plan,
  type ReadCall,
  type ReadOp,
} from "./plan.js";
import type { CatalogArtifact, Connected, Inspection, RoutingDecision, TableApi } from "./types.js";

/** How many plans one client keeps. */
const PLAN_LIMIT = 64;

type Session = {
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
};

type Mods = {
  readonly all?: string;
  readonly required?: boolean;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
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
  };
  const tables: Record<string, TableApi<QuerySchema, string>> = {};
  for (const name of Object.keys(schema.model)) {
    tables[name] = tableApi(session, name);
  }
  let closing: Promise<void> | undefined;
  const client = {
    ...tables,
    table(name: string) {
      const found = tables[name];
      if (found !== undefined) return found;
      try {
        throwNamed(
          "OKM1120",
          name,
          Object.keys(tables),
          `Table ${name} is not in the schema. Accepted names: ${Object.keys(tables).join(", ")}.`,
        );
      } catch (error) {
        if (error instanceof OkmError) throw attachHttp(session.http, error);
        throw error;
      }
    },
    close() {
      if (!options.ownsPool) return Promise.resolve();
      closing ??= pool.close();
      return closing;
    },
    connected,
  };
  attachAsyncDispose(client, () => client.close());
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

function tableApi(session: Session, table: string): TableApi<QuerySchema, string> {
  return {
    find(options: object = {}) {
      return start(session, "find", table, options, {});
    },
    one(options: object = {}) {
      return start(session, "one", table, options, {});
    },
    count(options: object = {}) {
      return start(session, "count", table, options, {});
    },
    exists(options: object = {}) {
      return start(session, "exists", table, options, {});
    },
    insert(data: unknown, options: object = {}) {
      return writeHandle(session, "insert", table, data, options, {});
    },
    update(target: unknown, options: object = {}) {
      return writeHandle(session, "update", table, target, options, {});
    },
    delete(target: unknown, options: object = {}) {
      return writeHandle(session, "delete", table, target, options, {});
    },
  } as unknown as TableApi<QuerySchema, string>;
}

type WriteOp = "insert" | "update" | "delete";
type WriteMods = { readonly all?: string; readonly expect?: number };

let writers: Promise<typeof import("./write.js")> | undefined;

function loadWrite(): Promise<typeof import("./write.js")> {
  writers ??= import("./write.js");
  return writers;
}

function writeHandle(
  session: Session,
  op: WriteOp,
  table: string,
  input: unknown,
  options: object,
  mods: WriteMods,
): Promise<unknown> & Record<string, unknown> {
  let pending: Promise<unknown> | undefined;
  const run = (): Promise<unknown> => {
    pending ??= runWrite(session, op, table, input, options, mods);
    return pending;
  };
  const self = {
    // oxlint-disable-next-line unicorn/no-thenable
    then(onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
      return run().then(onFulfilled, onRejected);
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
      return safe(run());
    },
    sql() {
      return loadWrite().then((mod) =>
        mod.explainWrite(session.schema, op, table, input, options, mods, session.generators),
      );
    },
    expect(count: number) {
      return writeHandle(session, op, table, input, options, { ...mods, expect: count });
    },
    all(reason: string) {
      return writeHandle(session, op, table, input, options, { ...mods, all: reason });
    },
  };
  return self as unknown as Promise<unknown> & Record<string, unknown>;
}

async function runWrite(
  session: Session,
  op: WriteOp,
  table: string,
  input: unknown,
  options: object,
  mods: WriteMods,
): Promise<unknown> {
  await session.connected;
  const mod = await loadWrite();
  try {
    return await mod.executeWrite(
      {
        schema: session.schema,
        pool: session.pool,
        ...(session.generators !== undefined ? { generators: session.generators } : {}),
      },
      op,
      table,
      input,
      options,
      mods,
    );
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
): Promise<unknown> & Record<string, unknown> {
  const call = readCall(op, table, options, mods.all);
  let prepared: { readonly plan: Plan; readonly params: readonly (string | null)[] } | undefined;
  const prepare = async (): Promise<{
    readonly plan: Plan;
    readonly params: readonly (string | null)[];
  }> => {
    if (prepared !== undefined) return prepared;
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
  const run = async (): Promise<unknown> => {
    await session.connected;
    const { plan, params } = await prepare();
    try {
      const result = await session.pool.execute(
        plan.text,
        params as readonly WireValue[],
        callOptions(mods),
      );
      const value =
        plan.outputs.includes.length === 0
          ? decodeResult(plan, result.rows, table)
          : (await import("./include.js")).decodeIncluded(plan, result.rows, table);
      if (mods.required === true && value === null) {
        throw new OkmError(
          "not_found",
          `one() on ${table} matched no row.`,
          withHttp(session.http, { kind: "not_found", table }),
        );
      }
      return value;
    } catch (error) {
      throw logged(session, await mapError(session, error));
    }
  };
  let pending: Promise<unknown> | undefined;
  const once = (): Promise<unknown> => {
    pending ??= run();
    return pending;
  };
  const self = {
    // A query is awaitable and also has inspect/sql/safe. It stays lazy until awaited.
    // oxlint-disable-next-line unicorn/no-thenable
    then(onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
      return once().then(onFulfilled, onRejected);
    },
    catch(onRejected?: (error: unknown) => unknown) {
      return this.then(undefined, onRejected);
    },
    finally(fn: () => void) {
      return this.then(
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
    inspect(): Inspection | Promise<Inspection> {
      const source = session.schema.model[table]?.source;
      if (call.include === undefined && prepared !== undefined) {
        return inspection(prepared.plan, prepared.params, call, source);
      }
      if (call.include === undefined && !readNeedsOperatorSql(session.schema, call)) {
        const bound = bindNow(session.schema, call);
        prepared = bound;
        return inspection(bound.plan, bound.params, call, source);
      }
      return prepare().then(({ plan, params }) => inspection(plan, params, call, source));
    },
    sql() {
      if (call.include === undefined && prepared !== undefined) {
        return { text: prepared.plan.text, params: prepared.params };
      }
      if (call.include === undefined && !readNeedsOperatorSql(session.schema, call)) {
        const { plan, params } = bindNow(session.schema, call);
        prepared = { plan, params };
        return { text: plan.text, params };
      }
      return prepare().then(({ plan, params }) => ({ text: plan.text, params }));
    },
    safe() {
      return safe(once());
    },
    all(reason: string) {
      return start(session, op, table, options, { ...mods, all: reason });
    },
    required() {
      return start(session, op, table, options, { ...mods, required: true });
    },
    stream() {
      return streamRows(session, call, prepare);
    },
  };
  return self as unknown as Promise<unknown> & Record<string, unknown>;
}

async function* streamRows(
  session: Session,
  call: ReadCall,
  prepare: () => Promise<{ readonly plan: Plan; readonly params: readonly (string | null)[] }>,
): AsyncIterable<unknown> {
  await session.connected;
  if (session.pool.capabilities.stream !== true || session.pool.stream === undefined) {
    throw logged(
      session,
      new OkmError(
        "OKM1111",
        "stream needs a driver with stream: true. This driver does not have it.",
        withHttp(session.http, {
          fix: { summary: "Use a driver that sets stream, or read with find." },
        }),
      ),
    );
  }
  const { plan, params } = await prepare();
  const decode =
    plan.outputs.includes.length === 0
      ? decodeResult
      : (await import("./include.js")).decodeIncluded;
  for await (const chunk of session.pool.stream(plan.text, params as readonly WireValue[])) {
    const decoded = decode(plan, chunk, call.table);
    if (!Array.isArray(decoded)) continue;
    for (const row of decoded) yield row;
  }
}

function readCall(op: ReadOp, table: string, options: object, all: string | undefined): ReadCall {
  const record = options as Record<string, unknown>;
  const accepted =
    op === "find"
      ? ["include", "limit", "orderBy", "select", "where"]
      : op === "one"
        ? ["include", "orderBy", "select", "where"]
        : ["where"];
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
    ...(all !== undefined ? { all } : {}),
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
  let rows: readonly (readonly (string | null)[])[];
  try {
    const result = await pool.execute(SERVER_CHECK, undefined, options);
    rows = result.rows;
  } catch (error) {
    const { mapPostgresError } = await import("../dialects/pg/errors.js");
    throw mapPostgresError(error, mapOptions(http, false));
  }
  const { acceptServer } = await import("./server-check.js");
  await acceptServer(pool, schema, rows, http, requireMeta, options, source);
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

function callOptions(input: {
  readonly signal?: AbortSignal | undefined;
  readonly timeout?: number | undefined;
}): ExecuteOptions | undefined {
  if (input.signal === undefined && input.timeout === undefined) return undefined;
  return {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
  };
}

/**
 * Version, dialect, and the `okm_meta` hash in one round trip.
 *
 * The hash subquery is a string so a database with no `okm_meta` still plans.
 * A null hash skips the compatibility check.
 */
const SERVER_CHECK =
  "select current_setting('server_version_num'), version(), (select (xpath('//catalog_hash/text()', query_to_xml('select catalog_hash from okm_meta where id = ''head''', true, false, '')))[1]::text where to_regclass('okm_meta') is not null)";

function mapOptions(
  http: ErrorStatuses | undefined,
  includeValues: boolean,
): MapPostgresErrorOptions {
  return {
    ...(http !== undefined ? { http } : {}),
    ...(includeValues ? { includeValues: true } : {}),
  };
}

function logged(session: Session, error: OkmError): OkmError {
  session.logger?.error?.({ code: error.code, summary: error.summary });
  return error;
}
