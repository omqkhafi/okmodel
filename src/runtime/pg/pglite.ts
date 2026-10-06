/**
 * `connect` for PGlite (`okmodel/pg/pglite`).
 *
 * Opening a database is async. An existing pool is reused and not closed.
 * A `{ primary, replicas }` object loads the topology module. A replica URL is
 * that endpoint's data directory.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, type PgliteConfig } from "../../adapters/pg/pglite.js";
import { createClient } from "../client.js";
import type { TopologyInput, TopologyOptions } from "../topology.js";
import type { ConnectOptions, Connected } from "../types.js";

export { open, type PgliteConfig } from "../../adapters/pg/pglite.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/pglite.js";
export { DriverError } from "../../adapters/error.js";

/** A data directory, a pool from {@link open}, or omitted for memory. */
export type PgliteTarget = string | DriverPool | undefined;

/** Driver options `connect` forwards to {@link open}. */
export type PgliteConnectOptions<S extends QuerySchema> = ConnectOptions<S> &
  Omit<PgliteConfig, "dataDir"> &
  TopologyOptions;

/**
 * Connects one PGlite endpoint, or a primary and its replicas, and returns a client for `schema`.
 *
 * A string, a pool, or an omitted target is unchanged. A topology loads on
 * demand. Until read routing, every operation uses the primary. A replica
 * `url` is that endpoint's data directory.
 *
 * @typeParam S - Schema
 * @param target - Data directory, existing pool, omitted for memory, or `{ primary, replicas }`
 * @param options - Schema, errors, and logger
 * @returns The client
 */
export function connect<const S extends QuerySchema>(
  target: TopologyInput,
  options: PgliteConnectOptions<S>,
): Promise<Connected<S>>;
export function connect<const S extends QuerySchema>(
  target: PgliteTarget,
  options: PgliteConnectOptions<S>,
): Promise<Connected<S>>;
export async function connect<const S extends QuerySchema>(
  target: PgliteTarget | TopologyInput,
  options: PgliteConnectOptions<S>,
): Promise<Connected<S>> {
  if (typeof target === "object" && !isPool(target)) {
    return import("../topology.js").then((mod) => mod.default(target, options, open as never));
  }
  const pool = isPool(target)
    ? target
    : await open({
        ...(target !== undefined ? { dataDir: target } : {}),
        ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
      });
  return createClient(options.schema, pool, {
    ownsPool: !isPool(target),
    http: options.errors?.http,
    includeValues: options.errors?.includeValues,
    logger: options.logger,
    signal: options.signal,
    requireMeta: options.requireMeta,
    timeout: options.timeout,
    timeouts: options.timeouts,
    hookm: options.hookm,
    catalog: options.catalog,
    catalogDir: options.catalogDir,
    generators: options.generators,
  });
}

function isPool(target: PgliteTarget | TopologyInput): target is DriverPool {
  return (
    typeof target === "object" && target !== null && "execute" in target && "capabilities" in target
  );
}
