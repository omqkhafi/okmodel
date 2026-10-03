/**
 * `connect` for PGlite (`okmodel/pg/pglite`).
 *
 * Opening a database is async. An existing pool is reused and not closed.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, type PgliteConfig } from "../../adapters/pg/pglite.js";
import { createClient } from "../client.js";
import type { ConnectOptions, Connected } from "../types.js";

export { open, type PgliteConfig } from "../../adapters/pg/pglite.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/pglite.js";
export { DriverError } from "../../adapters/error.js";

/** A data directory, a pool from {@link open}, or omitted for memory. */
export type PgliteTarget = string | DriverPool | undefined;

/** Driver options `connect` forwards to {@link open}. */
export type PgliteConnectOptions<S extends QuerySchema> = ConnectOptions<S> &
  Omit<PgliteConfig, "dataDir">;

/**
 * Connects one PGlite endpoint and returns a client for `schema`.
 *
 * @typeParam S - Schema
 * @param target - Data directory, existing pool, or omitted for memory
 * @param options - Schema, errors, and logger
 * @returns The client
 */
export async function connect<const S extends QuerySchema>(
  target: PgliteTarget,
  options: PgliteConnectOptions<S>,
): Promise<Connected<S>> {
  const shared = {
    http: options.errors?.http,
    includeValues: options.errors?.includeValues,
    logger: options.logger,
    signal: options.signal,
    timeout: options.timeout,
    catalog: options.catalog,
    catalogDir: options.catalogDir,
  };
  if (isPool(target)) {
    return createClient(options.schema, target, { ...shared, ownsPool: false });
  }
  const dataDir = target;
  const pool = await open({
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
  });
  return createClient(options.schema, pool, { ...shared, ownsPool: true });
}

function isPool(target: PgliteTarget): target is DriverPool {
  return (
    typeof target === "object" && target !== null && "execute" in target && "capabilities" in target
  );
}
