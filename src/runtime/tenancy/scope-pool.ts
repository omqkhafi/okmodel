/**
 * The pool wrapper that places `set_config` in front of a scoped unit.
 *
 * `rlsTenancy()` and `sessionSettings()` share it. One statement,
 * `select set_config(...), ...`, is the first statement of the transaction a
 * unit runs in, and `is_local` is always true. Loaded by those two imports only.
 */

import { OkmError } from "../../contracts/error.js";
import type {
  DriverConnection,
  DriverPool,
  ExecuteOptions,
  ExecuteResult,
  Statement,
  WireValue,
} from "../../contracts/driver.js";

const WRAPPED = Symbol("okmodel.rls.wrapped");
/** Shared with `openClient`, which reopens a client on the pool under every wrapper. */
export const INNER = Symbol.for("okmodel.pool.inner");

/** The tenant a wrapped unit runs as: a value for `app.tenant`, or an `app.unscoped` reason. */
export type Tenant = { readonly value: string } | { readonly unscoped: string };

/** One transaction-local setting: its name and the text `set_config` receives. */
export type Setting = readonly [name: string, value: string];

type ScopeState = {
  last: string | undefined;
  pending: Promise<void> | undefined;
  epoch: number;
  /** Sets issued on this connection. A rollback to a savepoint forgets the scope only if this moved. */
  sets: number;
  /** Statements of different scopes on this connection run one at a time. */
  chain: Promise<void>;
};

type ReadUnit = (
  text: string,
  params: readonly WireValue[] | undefined,
  prelude: Statement,
  options: ExecuteOptions | undefined,
) => Promise<ExecuteResult>;

type ReadStream = (
  text: string,
  params: readonly WireValue[] | undefined,
  prelude: Statement,
  options: ExecuteOptions | undefined,
) => AsyncIterable<readonly (readonly WireValue[])[]>;

/** A pool the topology router built. */
export type RoutedPool = DriverPool & {
  readonly okmReadOnlyUnit?: ReadUnit;
  readonly okmReadOnlyStream?: ReadStream;
  okmEndpoints?: () => readonly {
    readonly name: string;
    readonly generation: number;
    readonly pool: DriverPool;
  }[];
  okmGuardInstalled?: boolean;
};

type ScopeHooks = {
  okmForgetScope?: (mark?: number) => void;
  okmScopeMark?: () => number;
  okmScopePending?: () => Promise<void> | undefined;
};

const scopeStates = new WeakMap<object, ScopeState>();

function statementOf(text: string, params: readonly WireValue[] | undefined): Statement {
  return params === undefined ? { text } : { text, params };
}

/**
 * Runs one statement inside `BEGIN READ ONLY` after the scope's `set_config`.
 *
 * The caller releases the connection. A failure rolls the transaction back.
 *
 * @param conn - Reserved connection
 * @param text - User statement
 * @param params - Wire parameters
 * @param prelude - `set_config` statement
 * @param options - Deadline and cancellation, without a route hint
 * @returns The user statement's result
 */
export async function runReadOnly(
  conn: DriverConnection,
  text: string,
  params: readonly WireValue[] | undefined,
  prelude: Statement,
  options: ExecuteOptions | undefined,
): Promise<ExecuteResult> {
  await conn.execute("begin read only");
  try {
    await conn.execute(prelude.text, prelude.params);
    const result = await conn.execute(text, params, options);
    await conn.execute("commit");
    return result;
  } catch (error) {
    await conn.execute("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * Streams one query inside `BEGIN READ ONLY` after the scope's `set_config`.
 *
 * Rows come back in chunks of 64. The caller releases the connection.
 *
 * @param conn - Reserved connection
 * @param text - User query
 * @param params - Wire parameters
 * @param prelude - `set_config` statement
 * @returns Row chunks
 */
export async function* streamHeld(
  conn: DriverConnection,
  text: string,
  params: readonly WireValue[] | undefined,
  prelude: Statement,
): AsyncGenerator<readonly (readonly WireValue[])[]> {
  await conn.execute("begin read only");
  try {
    await conn.execute(prelude.text, prelude.params);
    await conn.execute(`declare okm_rls no scroll cursor for ${text}`, params);
    for (;;) {
      const chunk = await conn.execute("fetch 64 from okm_rls");
      if (chunk.rows.length === 0) break;
      yield chunk.rows;
    }
    await conn.execute("close okm_rls");
    await conn.execute("commit");
  } catch (error) {
    await conn.execute("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * Whether a pool is already a scope wrapper.
 *
 * @param pool - A client's pool
 * @returns True when {@link wrapPool} built it
 */
export function isWrapped(pool: object): boolean {
  return WRAPPED in pool;
}

/**
 * The pool under any scope wrappers.
 *
 * @param pool - A client's pool
 * @returns The pool a wrapper chain reserves
 */
export function innerPool(pool: DriverPool): DriverPool {
  const inner = (pool as { [INNER]?: DriverPool })[INNER];
  return inner ?? pool;
}

/** The pool a wrapper chain reserves: one chain for every scope on that connection. */
function rootPool(pool: DriverPool): DriverPool {
  let current = pool;
  for (;;) {
    const inner = (current as { [INNER]?: DriverPool })[INNER];
    if (inner === undefined) return current;
    current = inner;
  }
}

/**
 * The `set_config` statement for one unit.
 *
 * A tenant alone keeps its fixed text. Settings join it in one statement and
 * every name and value is a parameter.
 *
 * @param tenant - `app.tenant` or `app.unscoped`, when the unit has one
 * @param settings - Transaction-local settings, in order
 * @returns The prelude
 */
export function preludeOf(
  tenant: Tenant | undefined,
  settings: readonly Setting[] | undefined,
): Statement {
  if (tenant !== undefined && (settings === undefined || settings.length === 0)) {
    if ("unscoped" in tenant) return { text: "select set_config('app.unscoped', 'on', true)" };
    return { text: "select set_config('app.tenant', $1, true)", params: [tenant.value] };
  }
  const pairs: Setting[] = [...(settings ?? [])];
  if (tenant !== undefined) {
    pairs.unshift("unscoped" in tenant ? ["app.unscoped", "on"] : ["app.tenant", tenant.value]);
  }
  const calls = pairs.map((_, at) => `set_config($${2 * at + 1}, $${2 * at + 2}, true)`);
  return { text: `select ${calls.join(", ")}`, params: pairs.flat() };
}

/**
 * The key two units share when they set the same thing.
 *
 * A unit sets again only when its key differs from the last one set on the
 * connection (D241).
 *
 * @param tenant - The unit's tenant, when it has one
 * @param settings - The unit's settings
 * @returns A string that is equal for equal scopes
 */
export function scopeKeyOf(
  tenant: Tenant | undefined,
  settings: readonly Setting[] | undefined,
): string {
  const head =
    tenant === undefined ? "" : "unscoped" in tenant ? `u:${tenant.unscoped}` : tenant.value;
  return settings === undefined || settings.length === 0
    ? head
    : `${head}\n${JSON.stringify(settings)}`;
}

/**
 * Wraps a pool so every statement runs after the unit's `set_config`.
 *
 * Outside a transaction a write is `batch([prelude, statement])` and a read is
 * `BEGIN READ ONLY` on the routed endpoint. Inside a transaction the prelude
 * is queued as soon as the client exists, before any savepoint, and runs again
 * only when a statement's scope differs from the last one set.
 *
 * @param inner - The pool to wrap
 * @param tenant - The tenant part of the prelude
 * @param settings - The settings part of the prelude
 * @param inside - True on the client a transaction hands out
 * @param ensure - Runs before every statement. The RLS role check
 * @returns The wrapped pool
 */
export function wrapPool(
  inner: DriverPool,
  tenant: Tenant | undefined,
  settings: readonly Setting[] | undefined,
  inside: boolean,
  ensure: () => Promise<void> = () => Promise.resolve(),
): DriverPool {
  const setting = preludeOf(tenant, settings);
  const key = scopeKeyOf(tenant, settings);
  const unscoped = tenant !== undefined && "unscoped" in tenant;
  const state = inside ? scopeState(rootPool(inner)) : undefined;
  if (state !== undefined) queueScope(inner, setting, key, state);
  const arm = (): Promise<void> =>
    state === undefined ? Promise.resolve() : ensureScope(inner, setting, key, state);
  const wrapped: DriverPool = {
    capabilities: inner.capabilities,
    execute: async (text, params, options) => {
      await ensure();
      if (unscoped && isWriteSql(text)) unscopedWrite();
      if (inside) {
        if (state === undefined) {
          await arm();
          return inner.execute(text, params, options);
        }
        const release = await acquire(state);
        try {
          await ensureScope(inner, setting, key, state);
          return await inner.execute(text, params, options);
        } finally {
          release();
        }
      }
      if (isReadSql(text)) {
        return runScopedRead(inner, text, params, setting, options, tenant === undefined);
      }
      const results = await inner.batch([setting, statementOf(text, params)], options);
      const result = results[1];
      if (result === undefined) {
        throw new OkmError("OKM1111", "The driver returned no result for the statement.", {
          fix: { summary: "Use a Postgres driver that returns one result per batched statement." },
        });
      }
      return result;
    },
    batch: async (statements, options) => {
      await ensure();
      if (unscoped && statements.some((statement) => isWriteSql(statement.text))) unscopedWrite();
      if (inside) {
        if (state === undefined) {
          await arm();
          return inner.batch(statements, options);
        }
        const release = await acquire(state);
        try {
          await ensureScope(inner, setting, key, state);
          return await inner.batch(statements, options);
        } finally {
          release();
        }
      }
      if (statements.length > 0 && statements.every((statement) => isReadSql(statement.text))) {
        const results: ExecuteResult[] = [];
        for (const statement of statements) {
          results.push(
            await runScopedRead(
              inner,
              statement.text,
              statement.params,
              setting,
              options,
              tenant === undefined,
            ),
          );
        }
        return results;
      }
      const results = await inner.batch(
        [setting, ...statements.map((statement) => statementOf(statement.text, statement.params))],
        options,
      );
      return results.slice(1);
    },
    stats: () => inner.stats(),
    close: () => inner.close(),
  };
  if (state !== undefined) bindScopeHooks(inner, wrapped, state);
  if (inner.reserve !== undefined) wrapped.reserve = () => inner.reserve!();
  if (inner.describe !== undefined) {
    wrapped.describe = (text, params) => inner.describe!(text, params);
  }
  if (inner.listen !== undefined)
    wrapped.listen = (channel, onNotify) => inner.listen!(channel, onNotify);
  if (inner.cancel !== undefined) wrapped.cancel = () => inner.cancel!();
  if (inner.stream !== undefined || (inner as RoutedPool).okmReadOnlyStream !== undefined) {
    wrapped.stream = (text, params) =>
      streamScoped(inner, text, params, setting, key, inside, unscoped, ensure, arm, state);
  }
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  Object.defineProperty(wrapped, INNER, { value: inner });
  return wrapped;
}

async function runScopedRead(
  inner: DriverPool,
  text: string,
  params: readonly WireValue[] | undefined,
  setting: Statement,
  options: ExecuteOptions | undefined,
  batched: boolean,
): Promise<ExecuteResult> {
  const unit = (inner as RoutedPool).okmReadOnlyUnit;
  if (unit !== undefined) return unit(text, params, setting, options);
  if (inner.reserve === undefined) {
    // Neon over HTTP has no connection to hold. Settings alone run the read in
    // the one transaction([...]) the prelude opens.
    if (batched) {
      const results = await inner.batch([setting, statementOf(text, params)], options);
      const result = results[1];
      if (result !== undefined) return result;
    }
    throw new OkmError(
      "OKM1111",
      "Row-level security needs a driver that can reserve a connection.",
      {
        fix: { summary: "Use a Postgres driver that supports interactive transactions." },
      },
    );
  }
  const conn = await inner.reserve();
  try {
    return await runReadOnly(conn, text, params, setting, options);
  } finally {
    await conn.release();
  }
}

function streamScoped(
  inner: DriverPool,
  text: string,
  params: readonly WireValue[] | undefined,
  setting: Statement,
  key: string,
  inside: boolean,
  unscoped: boolean,
  ensure: () => Promise<void>,
  arm: () => Promise<void>,
  state: ScopeState | undefined,
): AsyncIterable<readonly (readonly WireValue[])[]> {
  return (async function* () {
    await ensure();
    if (unscoped && isWriteSql(text)) unscopedWrite();
    const routed = (inner as RoutedPool).okmReadOnlyStream;
    if (!inside && isReadSql(text) && routed !== undefined) {
      yield* routed(text, params, setting, undefined);
      return;
    }
    if (inside) {
      if (inner.stream === undefined) {
        throw new OkmError("OKM1111", "stream() inside tx() needs a driver stream.", {
          fix: { summary: "Stream outside the transaction, or read with find()." },
        });
      }
      if (state === undefined) {
        await arm();
        yield* inner.stream(text, params);
        return;
      }
      const release = await acquire(state);
      try {
        await ensureScope(inner, setting, key, state);
        yield* inner.stream(text, params);
      } finally {
        release();
      }
      return;
    }
    if (inner.reserve === undefined) {
      throw new OkmError(
        "OKM1111",
        "Row-level security needs a driver that can reserve a connection.",
        {
          fix: { summary: "Use a Postgres driver that supports interactive transactions." },
        },
      );
    }
    const conn = await inner.reserve();
    try {
      yield* streamHeld(conn, text, params, setting);
    } finally {
      await conn.release();
    }
  })();
}

function scopeState(pool: object): ScopeState {
  let state = scopeStates.get(pool);
  if (state === undefined) {
    state = { last: undefined, pending: undefined, epoch: 0, sets: 0, chain: Promise.resolve() };
    scopeStates.set(pool, state);
  }
  return state;
}

/**
 * Runs `run` after every earlier statement on this connection.
 *
 * The caller holds the returned release until its own statement has finished,
 * so a second scope cannot read the first scope's `set_config`.
 */
function acquire(state: ScopeState): Promise<() => void> {
  const previous = state.chain;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.chain = previous.then(
    () => gate,
    () => gate,
  );
  return previous.then(
    () => release,
    () => release,
  );
}

/**
 * Queues `set_config` as soon as the transaction client exists.
 *
 * That is after `BEGIN` and before the callback, so a later savepoint cannot
 * roll the setting back. A second scope waits until the first write finishes.
 */
function queueScope(inner: DriverPool, setting: Statement, key: string, state: ScopeState): void {
  if (state.last === key || state.pending !== undefined) return;
  const epoch = state.epoch;
  state.sets += 1;
  const run = inner.execute(setting.text, setting.params).then(() => {
    // Every statement waits for `pending` before it sets, so nothing ran
    // between this write and here and the next statement of this scope can skip it.
    if (state.pending !== run) return;
    state.pending = undefined;
    if (state.epoch === epoch) state.last = key;
  });
  state.pending = run;
  void run.catch(() => {
    if (state.pending === run) state.pending = undefined;
  });
}

/** Sets the scope when this statement's scope is not the one last applied. */
async function ensureScope(
  inner: DriverPool,
  setting: Statement,
  key: string,
  state: ScopeState,
): Promise<void> {
  const pending = state.pending;
  if (pending !== undefined) await pending;
  if (state.last === key) return;
  const epoch = state.epoch;
  state.sets += 1;
  await inner.execute(setting.text, setting.params);
  if (state.epoch !== epoch) return;
  state.last = key;
}

function bindScopeHooks(inner: DriverPool, wrapped: DriverPool, state: ScopeState): void {
  const hooks: ScopeHooks = {
    okmForgetScope(mark) {
      if (mark === state.sets) return;
      state.epoch += 1;
      state.last = undefined;
      state.pending = undefined;
      state.chain = Promise.resolve();
    },
    okmScopePending() {
      return state.pending;
    },
    okmScopeMark() {
      return state.sets;
    },
  };
  Object.assign(inner, hooks);
  Object.assign(wrapped, hooks);
}

function unscopedWrite(): never {
  throw new OkmError("OKM1701", "unscoped() cannot write under row-level security.", {
    fix: {
      summary:
        "Cross-tenant writes belong to the migration role. Use for() to write as one tenant.",
    },
  });
}

function isWriteSql(text: string): boolean {
  const sql = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (/^(insert|update|delete|refresh|truncate|create|alter|drop|grant|revoke|copy)\b/.test(sql)) {
    return true;
  }
  return sql.startsWith("with ") && /\b(insert|update|delete)\b/.test(sql);
}

function isReadSql(text: string): boolean {
  const sql = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (/^(select|values|table|show|explain)\b/.test(sql)) {
    return !/\sfor (no key update|key share|update|share)\b/.test(sql);
  }
  return sql.startsWith("with ") && !/\b(insert|update|delete)\b/.test(sql);
}
