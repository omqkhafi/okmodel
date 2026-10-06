/**
 * `connect` for node-postgres (`okmodel/pg/pg`).
 *
 * A string or an existing pool is one endpoint. A `{ primary, replicas }` object
 * loads the topology module. The client is typed by the schema passed in, not
 * by `Register`.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, type NodePostgresConfig } from "../../adapters/pg/nodepostgres.js";
import { createClient } from "../client.js";
import type { RoutedClient, TopologyInput, TopologyOptions } from "../topology.js";
import type { ConnectOptions, Connected } from "../types.js";

export { open, type NodePostgresConfig } from "../../adapters/pg/nodepostgres.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/nodepostgres.js";
export { DriverError } from "../../adapters/error.js";

/** A connection string or a pool from {@link open}. */
export type NodePostgresTarget = string | DriverPool;

/** Driver options `connect` forwards to {@link open}. */
export type NodePostgresConnectOptions<S extends QuerySchema> = ConnectOptions<S> &
  Omit<NodePostgresConfig, "url"> &
  TopologyOptions;

/**
 * Connects one Postgres endpoint through node-postgres, or a primary and its replicas.
 *
 * A string or a pool is one endpoint. A topology loads on demand and the promise
 * resolves to the client. Reads use the first healthy replica.
 *
 * Named prepared statements are off unless `prepared` is `"named"`.
 * `prepared: "named"` is not for transaction-mode poolers.
 *
 * @typeParam S - Schema
 * @param target - URL, an existing pool, or `{ primary, replicas }`
 * @param options - Schema, errors, logger, and driver options
 * @returns The client. A topology returns a promise. Await `connected` for the dialect check
 */
export function connect<const S extends QuerySchema>(
  target: TopologyInput,
  options: NodePostgresConnectOptions<S>,
): Promise<RoutedClient<S>>;
export function connect<const S extends QuerySchema>(
  target: NodePostgresTarget,
  options: NodePostgresConnectOptions<S>,
): Connected<S>;
export function connect<const S extends QuerySchema>(
  target: NodePostgresTarget | TopologyInput,
  options: NodePostgresConnectOptions<S>,
): Connected<S> | Promise<RoutedClient<S>> {
  if (typeof target === "object" && !isPool(target)) {
    return import("../topology.js").then((mod) => mod.default(target, options, open as never));
  }
  const owned = !isPool(target);
  const pool = isPool(target)
    ? target
    : open({
        url: target,
        ...(options.max !== undefined ? { max: options.max } : {}),
        ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
        ...(options.prepared !== undefined ? { prepared: options.prepared } : {}),
        ...(options.searchPath !== undefined ? { searchPath: options.searchPath } : {}),
        ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
      });
  return createClient(options.schema, pool, {
    ownsPool: owned,
    http: options.errors?.http,
    includeValues: options.errors?.includeValues,
    logger: options.logger,
    signal: options.signal,
    timeout: options.timeout,
    timeouts: options.timeouts,
    hookm: options.hookm,
    catalog: options.catalog,
    catalogDir: options.catalogDir,
    requireMeta: options.requireMeta,
    generators: options.generators,
  });
}

function isPool(target: NodePostgresTarget | TopologyInput): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
