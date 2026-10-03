/**
 * `connect` for node-postgres (`okmodel/pg/pg`).
 *
 * One URL or an existing pool is one endpoint. The client is typed by the
 * schema passed in, not by `Register`.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, type NodePostgresConfig } from "../../adapters/pg/nodepostgres.js";
import { createClient } from "../client.js";
import type { ConnectOptions, Connected } from "../types.js";

export { open, type NodePostgresConfig } from "../../adapters/pg/nodepostgres.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/nodepostgres.js";
export { DriverError } from "../../adapters/error.js";

/** A connection string or a pool from {@link open}. */
export type NodePostgresTarget = string | DriverPool;

/** Driver options `connect` forwards to {@link open}. */
export type NodePostgresConnectOptions<S extends QuerySchema> = ConnectOptions<S> &
  Omit<NodePostgresConfig, "url">;

/**
 * Connects one Postgres endpoint through node-postgres and returns a client for `schema`.
 *
 * Named prepared statements are off unless `prepared` is `"named"`.
 * `prepared: "named"` is not for transaction-mode poolers.
 *
 * @typeParam S - Schema
 * @param target - URL or an existing pool
 * @param options - Schema, errors, logger, and driver options
 * @returns The client. Await `connected` for the dialect check
 */
export function connect<const S extends QuerySchema>(
  target: NodePostgresTarget,
  options: NodePostgresConnectOptions<S>,
): Connected<S> {
  if (isPool(target)) {
    return createClient(options.schema, target, {
      ownsPool: false,
      http: options.errors?.http,
      includeValues: options.errors?.includeValues,
      logger: options.logger,
      signal: options.signal,
      timeout: options.timeout,
      catalog: options.catalog,
      catalogDir: options.catalogDir,
      requireMeta: options.requireMeta,
      generators: options.generators,
    });
  }
  const pool = open({
    url: target,
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
    ...(options.prepared !== undefined ? { prepared: options.prepared } : {}),
    ...(options.searchPath !== undefined ? { searchPath: options.searchPath } : {}),
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  });
  return createClient(options.schema, pool, {
    ownsPool: true,
    http: options.errors?.http,
    includeValues: options.errors?.includeValues,
    logger: options.logger,
    signal: options.signal,
    timeout: options.timeout,
    catalog: options.catalog,
    catalogDir: options.catalogDir,
    requireMeta: options.requireMeta,
    generators: options.generators,
  });
}

function isPool(target: NodePostgresTarget): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
