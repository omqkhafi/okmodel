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
import type { SessionContext } from "../session/index.js";
import type { Bounded, ConnectOptions, Connected, Limits, NoLimits } from "../types.js";

export { open, type NodePostgresConfig } from "../../adapters/pg/nodepostgres.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/nodepostgres.js";
export { DriverError } from "../../adapters/error.js";

/** A connection string or a pool from {@link open}. */
export type NodePostgresTarget = string | DriverPool;

/** Driver options `connect` forwards to {@link open}. */
export type NodePostgresConnectOptions<
  S extends QuerySchema,
  C = undefined,
  D extends Limits = Limits,
> = ConnectOptions<S, C, D> & Omit<NodePostgresConfig, "url"> & TopologyOptions;

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
 * @typeParam C - The `session` context
 * @typeParam D - The `limits` literal. It decides which reads need no `limit`
 * @param target - URL, an existing pool, or `{ primary, replicas }`
 * @param options - Schema, errors, logger, and driver options
 * @returns The client. A topology returns a promise. Await `connected` for the dialect check
 */
export function connect<
  const S extends QuerySchema,
  const C extends SessionContext | undefined = undefined,
  const D extends Limits = NoLimits,
>(
  target: TopologyInput,
  options: NodePostgresConnectOptions<S, C, D>,
): Promise<RoutedClient<Bounded<S, D>, C>>;
export function connect<
  const S extends QuerySchema,
  const C extends SessionContext | undefined = undefined,
  const D extends Limits = NoLimits,
>(
  target: NodePostgresTarget,
  options: NodePostgresConnectOptions<S, C, D>,
): Connected<Bounded<S, D>, C>;
export function connect<
  const S extends QuerySchema,
  const C extends SessionContext | undefined = undefined,
>(
  target: NodePostgresTarget | TopologyInput,
  options: NodePostgresConnectOptions<S, C>,
): Connected<S, C> | Promise<RoutedClient<S, C>> {
  if (typeof target === "object" && !isPool(target)) {
    return import("../topology.js").then((mod) => mod.default(target, options, open as never));
  }
  const owned = !isPool(target);
  const pool = isPool(target)
    ? target
    : open({
        url: target,
        max: options.max,
        idleTimeoutMs: options.idleTimeoutMs,
        timeouts: options.timeouts,
        prepared: options.prepared,
        searchPath: options.searchPath,
        ssl: options.ssl,
      } as NodePostgresConfig);
  return createClient(options.schema, pool, options, owned);
}

function isPool(target: NodePostgresTarget | TopologyInput): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
