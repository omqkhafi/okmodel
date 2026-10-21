/**
 * `connect` for PGlite (`okmodel/pg/pglite`).
 *
 * Opening a database is async. An existing pool is reused and not closed.
 * Closing that client marks the client closed.
 * A `{ primary, replicas }` object loads the topology module. A replica URL is
 * that endpoint's data directory.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, seal, type PgliteConfig } from "../../adapters/pg/pglite.js";
import { createClient } from "../client.js";
import type { RoutedClient, TopologyInput, TopologyOptions } from "../topology.js";
import type { Bounded, ConnectOptions, Connected, Limits, NoLimits } from "../types.js";

export { open, type PgliteConfig } from "../../adapters/pg/pglite.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/pglite.js";
export { DriverError } from "../../adapters/error.js";

/** A data directory, a pool from {@link open}, or omitted for memory. */
export type PgliteTarget = string | DriverPool | undefined;

/** Driver options `connect` forwards to {@link open}. */
export type PgliteConnectOptions<S extends QuerySchema, D extends Limits = Limits> = ConnectOptions<
  S,
  D
> &
  Omit<PgliteConfig, "dataDir"> &
  TopologyOptions;

/**
 * Connects one PGlite endpoint, or a primary and its replicas, and returns a client for `schema`.
 *
 * A string, a pool, or an omitted target is one endpoint. A topology loads on
 * demand. Reads use the first healthy replica. A replica `url` is that
 * endpoint's data directory.
 *
 * @typeParam S - Schema
 * @typeParam D - The `limits` literal. It decides which reads need no `limit`
 * @param target - Data directory, existing pool, omitted for memory, or `{ primary, replicas }`
 * @param options - Schema, errors, and logger
 * @returns The client
 */
export function connect<const S extends QuerySchema, const D extends Limits = NoLimits>(
  target: TopologyInput,
  options: PgliteConnectOptions<S, D>,
): Promise<RoutedClient<Bounded<S, D>>>;
export function connect<const S extends QuerySchema, const D extends Limits = NoLimits>(
  target: PgliteTarget,
  options: PgliteConnectOptions<S, D>,
): Promise<Connected<Bounded<S, D>>>;
export async function connect<const S extends QuerySchema>(
  target: PgliteTarget | TopologyInput,
  options: PgliteConnectOptions<S>,
): Promise<Connected<S> | RoutedClient<S>> {
  if (typeof target === "object" && !isPool(target)) {
    return import("../topology.js").then((mod) => mod.default(target, options, open as never));
  }
  const pool = isPool(target)
    ? seal(target)
    : await open({
        ...(target !== undefined ? { dataDir: target } : {}),
        ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
      });
  return createClient(options.schema, pool, options, true);
}

function isPool(target: PgliteTarget | TopologyInput): target is DriverPool {
  return (
    typeof target === "object" && target !== null && "execute" in target && "capabilities" in target
  );
}
