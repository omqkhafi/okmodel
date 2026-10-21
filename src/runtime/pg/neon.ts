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
import type { ConnectOptions, Connected } from "../types.js";

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
export type NeonConnectOptions<S extends QuerySchema> = ConnectOptions<S> &
  Omit<NeonConfig, "url"> &
  TopologyOptions;

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
 * @param target - URL, an existing pool, or `{ primary, replicas }`
 * @param options - Schema, mode, errors, logger, and driver options
 * @returns The client. A topology returns a promise. Await `connected` for the dialect check
 */
export function connect<const S extends QuerySchema>(
  target: TopologyInput,
  options: NeonConnectOptions<S>,
): Promise<RoutedClient<S>>;
export function connect<const S extends QuerySchema>(
  target: NeonTarget,
  options: NeonConnectOptions<S>,
): Promise<Connected<S>>;
export function connect<const S extends QuerySchema>(
  target: NeonTarget | TopologyInput,
  options: NeonConnectOptions<S>,
): Promise<Connected<S> | RoutedClient<S>> {
  if (typeof target === "object" && !isPool(target)) {
    return import("../topology.js").then((mod) =>
      mod.default(target, options, ((config: NeonConfig) =>
        open({
          url: config.url,
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
          ...(config.max !== undefined ? { max: config.max } : {}),
          ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
          ...(config.prepared !== undefined ? { prepared: config.prepared } : {}),
          ...(config.searchPath !== undefined ? { searchPath: config.searchPath } : {}),
        })) as never),
    );
  }
  const owned = !isPool(target);
  const opened = isPool(target)
    ? Promise.resolve(target)
    : open({
        url: target,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.max !== undefined ? { max: options.max } : {}),
        ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
        ...(options.prepared !== undefined ? { prepared: options.prepared } : {}),
        ...(options.searchPath !== undefined ? { searchPath: options.searchPath } : {}),
      });
  return opened.then((pool) =>
    createClient(options.schema, pool, {
      ownsPool: owned,
      http: options.errors?.http,
      includeValues: options.errors?.includeValues,
      logger: options.logger,
      signal: options.signal,
      timeout: options.timeout,
      timeouts: options.timeouts,
      hookm: options.hookm,
      onWrite: options.onWrite,
      catalog: options.catalog,
      catalogDir: options.catalogDir,
      requireMeta: options.requireMeta,
      generators: options.generators,
    }),
  );
}

function isPool(target: NeonTarget | TopologyInput): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
