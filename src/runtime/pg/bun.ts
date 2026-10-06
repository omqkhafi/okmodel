/**
 * `connect` for Bun.sql (`okmodel/pg/bun`).
 *
 * A string or an existing pool is one endpoint. A `{ primary, replicas }` object
 * loads the topology module. The client is typed by the schema passed in.
 * This entry runs on Bun. Node cannot load the `bun` import inside the adapter.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, type BunSqlConfig } from "../../adapters/pg/bunsql.js";
import { createClient } from "../client.js";
import type { TopologyInput, TopologyOptions } from "../topology.js";
import type { ConnectOptions, Connected } from "../types.js";

export { open, type BunSqlConfig, type BunSqlTls } from "../../adapters/pg/bunsql.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/bunsql.js";
export { DriverError } from "../../adapters/error.js";

/** A connection string or a pool from {@link open}. */
export type BunSqlTarget = string | DriverPool;

/** Driver options `connect` forwards to {@link open}. */
export type BunSqlConnectOptions<S extends QuerySchema> = ConnectOptions<S> &
  Omit<BunSqlConfig, "url"> &
  TopologyOptions;

/**
 * Connects one Postgres endpoint through Bun.sql, or a primary and its replicas.
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
  options: BunSqlConnectOptions<S>,
): Promise<Connected<S>>;
export function connect<const S extends QuerySchema>(
  target: BunSqlTarget,
  options: BunSqlConnectOptions<S>,
): Connected<S>;
export function connect<const S extends QuerySchema>(
  target: BunSqlTarget | TopologyInput,
  options: BunSqlConnectOptions<S>,
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

function isPool(target: BunSqlTarget | TopologyInput): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
