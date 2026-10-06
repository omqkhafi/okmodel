/**
 * `connect` for postgres.js (`okmodel/pg/postgresjs`).
 *
 * A string or an existing pool is one endpoint. A `{ primary, replicas }` object
 * loads the topology module. The client is typed by the schema passed in, not
 * by `Register`.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, type PostgresJsConfig } from "../../adapters/pg/postgresjs.js";
import { createClient } from "../client.js";
import type { TopologyInput, TopologyOptions } from "../topology.js";
import type { ConnectOptions, Connected } from "../types.js";

export { open, type PostgresJsConfig } from "../../adapters/pg/postgresjs.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/postgresjs.js";
export { DriverError } from "../../adapters/error.js";

/** A connection string or a pool from {@link open}. */
export type PostgresTarget = string | DriverPool;

/** Driver options `connect` forwards to {@link open}. */
export type PostgresConnectOptions<S extends QuerySchema> = ConnectOptions<S> &
  Omit<PostgresJsConfig, "url"> &
  TopologyOptions;

/**
 * Connects one Postgres endpoint, or a primary and its replicas, and returns a client for `schema`.
 *
 * A string or a pool is unchanged. A topology loads on demand and the promise
 * resolves to the client. Until read routing, every operation uses the primary.
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
  options: PostgresConnectOptions<S>,
): Promise<Connected<S>>;
export function connect<const S extends QuerySchema>(
  target: PostgresTarget,
  options: PostgresConnectOptions<S>,
): Connected<S>;
export function connect<const S extends QuerySchema>(
  target: PostgresTarget | TopologyInput,
  options: PostgresConnectOptions<S>,
): Connected<S> | Promise<Connected<S>> {
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

function isPool(target: PostgresTarget | TopologyInput): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
