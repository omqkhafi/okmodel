/**
 * `connect` for Bun.sql (`okmodel/pg/bun`).
 *
 * A string or an existing pool is one endpoint. A `{ primary, replicas }` object
 * loads the topology module. The client is typed by the schema passed in.
 * This entry runs on Bun. Node cannot load the `bun` import inside the adapter.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { markClientPool, open, type BunSqlConfig } from "../../adapters/pg/bunsql.js";
import { createClient } from "../client.js";
import type { RoutedClient, TopologyInput, TopologyOptions } from "../topology.js";
import type { SessionContext } from "../session/index.js";
import type { Bounded, ConnectOptions, Connected, Limits, NoLimits } from "../types.js";

export { open, type BunSqlConfig, type BunSqlTls } from "../../adapters/pg/bunsql.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/bunsql.js";
export { DriverError } from "../../adapters/error.js";

/** A connection string or a pool from {@link open}. */
export type BunSqlTarget = string | DriverPool;

/** Driver options `connect` forwards to {@link open}. */
export type BunSqlConnectOptions<
  S extends QuerySchema,
  C = undefined,
  D extends Limits = Limits,
> = ConnectOptions<S, C, D> & Omit<BunSqlConfig, "url"> & TopologyOptions;

/**
 * Connects one Postgres endpoint through Bun.sql, or a primary and its replicas.
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
  options: BunSqlConnectOptions<S, C, D>,
): Promise<RoutedClient<Bounded<S, D>, C>>;
export function connect<
  const S extends QuerySchema,
  const C extends SessionContext | undefined = undefined,
  const D extends Limits = NoLimits,
>(target: BunSqlTarget, options: BunSqlConnectOptions<S, C, D>): Connected<Bounded<S, D>, C>;
export function connect<
  const S extends QuerySchema,
  const C extends SessionContext | undefined = undefined,
>(
  target: BunSqlTarget | TopologyInput,
  options: BunSqlConnectOptions<S, C>,
): Connected<S, C> | Promise<RoutedClient<S, C>> {
  if (typeof target === "object" && !isPool(target)) {
    return import("../topology.js").then((mod) =>
      mod.default(target, options, ((config: BunSqlConfig) => {
        const pool = open(config);
        markClientPool(pool);
        return pool;
      }) as never),
    );
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
  if (!isPool(target)) markClientPool(pool);
  return createClient(options.schema, pool, options, owned);
}

function isPool(target: BunSqlTarget | TopologyInput): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
