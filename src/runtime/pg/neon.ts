/**
 * `connect` for Neon (`okmodel/pg/neon`).
 *
 * A string or an existing pool is one endpoint. A `{ primary, replicas }` object
 * loads the topology module. The client is typed by the schema passed in.
 * `mode` is `websocket` (the default) or `http`.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, type NeonConfig } from "../../adapters/pg/neon.js";
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
      mod.default(target, options, ((config: NeonConfig) =>
        open({
          url: config.url,
          mode: options.mode,
          max: config.max,
          idleTimeoutMs: config.idleTimeoutMs,
          timeouts: config.timeouts,
          prepared: config.prepared,
          searchPath: config.searchPath,
        } as NeonConfig)) as never),
    );
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
  return opened.then((pool) => createClient(options.schema, pool, options, owned));
}

function isPool(target: NeonTarget | TopologyInput): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
