/**
 * `connect` for Neon (`okmodel/pg/neon`).
 *
 * A string or an existing pool is one endpoint. A `{ primary, replicas }` object
 * loads the topology module. The client is typed by the schema passed in.
 * `mode` is `websocket` (the default) or `http`.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, openReplica, rejectAfterClose, type NeonConfig } from "../../adapters/pg/neon.js";
import { createClient } from "../client.js";
import type { RoutedClient, TopologyInput, TopologyOptions } from "../topology.js";
import type { SessionContext } from "../session/index.js";
import type { Bounded, ConnectOptions, Connected, Limits, NoLimits } from "../types.js";

export { open, type NeonConfig, type NeonMode } from "../../adapters/pg/neon.js";
export {
  capabilities,
  hasCapability,
  httpCapabilities,
  readCapability,
} from "../../adapters/pg/neon.js";
export { DriverError } from "../../adapters/error.js";

/** A connection string or a pool from {@link open}. */
export type NeonTarget = string | DriverPool;

/** Driver options `connect` forwards to {@link open}. */
export type NeonConnectOptions<
  S extends QuerySchema,
  C = undefined,
  D extends Limits = Limits,
> = ConnectOptions<S, C, D> & Omit<NeonConfig, "url"> & TopologyOptions;

/**
 * Connects one Neon endpoint, or a primary and its replicas.
 *
 * A string or a pool is one endpoint. A topology loads on demand and the promise
 * resolves to the client. Reads use the first healthy replica.
 *
 * `mode: "websocket"` is the default. Interactive `tx()` needs it. `mode: "http"`
 * is one-shot HTTP: `batch()` is atomic and `tx()` is refused.
 *
 * Named prepared statements are off unless `prepared` is `"named"`.
 * `prepared: "named"` is not for transaction-mode poolers.
 *
 * @typeParam S - Schema
 * @typeParam C - The `session` context
 * @typeParam D - The `limits` literal. It decides which reads need no `limit`
 * `timeout` and `signal` bound the read-only startup check. A positive
 * `timeout` that elapses is kind `timeout`. An aborted `signal` is kind
 * `cancelled`. A later call still refuses a positive `timeout`.
 *
 * @param target - URL, an existing pool, or `{ primary, replicas }`
 * @param options - Schema, mode, errors, logger, and driver options
 * @returns The client. A topology returns a promise. Await `connected` for the dialect check
 */
export function connect<
  const S extends QuerySchema,
  const C extends SessionContext | undefined = undefined,
  const D extends Limits = NoLimits,
>(
  target: TopologyInput,
  options: NeonConnectOptions<S, C, D>,
): Promise<RoutedClient<Bounded<S, D>, C>>;
export function connect<
  const S extends QuerySchema,
  const C extends SessionContext | undefined = undefined,
  const D extends Limits = NoLimits,
>(target: NeonTarget, options: NeonConnectOptions<S, C, D>): Promise<Connected<Bounded<S, D>, C>>;
export function connect<
  const S extends QuerySchema,
  const C extends SessionContext | undefined = undefined,
>(
  target: NeonTarget | TopologyInput,
  options: NeonConnectOptions<S, C>,
): Promise<Connected<S, C> | RoutedClient<S, C>> {
  if (typeof target === "object" && !isPool(target)) {
    return import("../topology.js").then((mod) =>
      mod.default(target, options, ((
        config: NeonConfig & { readonly role?: "primary" | "replica" },
      ) => {
        const fields = {
          url: config.url,
          mode: options.mode,
          max: config.max,
          idleTimeoutMs: config.idleTimeoutMs,
          timeouts: config.timeouts,
          prepared: config.prepared,
          searchPath: config.searchPath,
        } as NeonConfig;
        // A replica that cannot be warmed stays a pool. The primary still rejects.
        if (config.role === "replica") return openReplica(fields);
        return open(fields).catch(mapOpenFailure);
      }) as never),
    );
  }
  if (typeof target === "string" && boundsStartup(options)) {
    return import("./neon-startup.js").then((mod) => mod.connectBounded(target, options));
  }
  const owned = !isPool(target);
  const opened = isPool(target)
    ? Promise.resolve(target)
    : open({
        url: target,
        mode: options.mode,
        max: options.max,
        idleTimeoutMs: options.idleTimeoutMs,
        timeouts: options.timeouts,
        prepared: options.prepared,
        searchPath: options.searchPath,
      } as NeonConfig);
  return opened.then(
    (pool) =>
      owned ? admitCheck(pool, options) : createClient(options.schema, pool, options, false),
    mapOpenFailure,
  );
}

/**
 * Reports whether `connect` must race the startup check.
 *
 * A positive `timeout` or any `signal` loads that path. `timeout: 0` stays on
 * the shared execute path, which already fails at once as kind `timeout`.
 *
 * @param options - Connect options
 * @returns True when the check is bounded
 */
function boundsStartup(options: {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}): boolean {
  return options.signal !== undefined || (options.timeout ?? 0) > 0;
}

/**
 * A WebSocket `open` failure is an {@link OkmError}, as a query failure is.
 *
 * The adapter throws a `DriverError`. The kind is decided with the other drivers.
 *
 * @param error - Rejection from {@link open}
 * @returns A rejected promise
 */
function mapOpenFailure(error: unknown): Promise<never> {
  return import("../../dialects/pg/errors.js").then((mod) =>
    Promise.reject(mod.mapPostgresError(error)),
  );
}

/**
 * Builds a client whose `close()` lets a pending startup check finish.
 *
 * Every call waits for `connected`, so only the check reaches the pool while it
 * runs. After `close()`, a call is OKM1120 whether or not the check had settled.
 *
 * @param pool - The pool `connect` opened
 * @param options - Connect options
 * @returns The client
 */
function admitCheck<S extends QuerySchema, C extends SessionContext | undefined>(
  pool: DriverPool,
  options: NeonConnectOptions<S, C>,
): Connected<S, C> {
  let checking = true;
  let shut = false;
  let settled: Promise<void> | undefined;
  const refused = (): Promise<never> | undefined =>
    shut && !checking ? rejectAfterClose() : undefined;
  const client = createClient(
    options.schema,
    {
      ...pool,
      execute: (text, params, call) => refused() ?? pool.execute(text, params, call),
      batch: (statements, call) => refused() ?? pool.batch(statements, call),
      ...(pool.reserve !== undefined ? { reserve: () => refused() ?? pool.reserve!() } : {}),
      close() {
        shut = true;
        return settled!.then(() => pool.close());
      },
    },
    options,
    true,
  );
  const done = (): void => {
    checking = false;
  };
  settled = client.connected.then(done, done);
  return client as unknown as Connected<S, C>;
}

function isPool(target: NeonTarget | TopologyInput): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
