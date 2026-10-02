/**
 * Pools keyed by resolved connection configuration.
 *
 * A cap (`maxOpenTargets`) evicts the least-recently-used idle pool. A pool
 * with a reserved connection is never evicted. Idle pools close after
 * `idleTimeout`. An authentication failure (SQLSTATE 28P01 or 28000) on open
 * re-resolves the target once and replaces the pool.
 */

import { DriverError } from "../drivers/errors.js";
import { openPostgresJs, type PostgresJsOptions } from "../drivers/postgresjs.js";
import type { DriverConnection, DriverPool, ExecuteResult } from "../drivers/types.js";
import { connectionUrl, resolveTarget, type TargetSource } from "./resolver.js";
import type { RegistryRole } from "./registry.js";
import type { Target } from "./target.js";

/** Counters for the cap, eviction, and credential rotation. */
export type TargetPoolStats = {
  /** Pools that still hold a driver. */
  readonly openPools: number;
  /** Pools with a reserved connection. */
  readonly reserved: number;
  /** Pools closed because the cap was exceeded. */
  readonly evictions: number;
  /** Times an authentication failure caused one re-resolve. */
  readonly authRetries: number;
};

/** A connection held out of a target pool. */
export type ReservedTarget = {
  /** Runs one statement on the reserved connection. */
  execute(sql: string): Promise<ExecuteResult>;
  /** Returns the connection. The pool may then be evicted. */
  release(): void;
};

type Slot = {
  url: string;
  pool: DriverPool;
  reserved: number;
  lastUsed: number;
  retried: boolean;
};

/**
 * Opens, reuses, and evicts one pool per resolved URL.
 */
export type TargetPools = {
  /**
   * Runs one statement on the target's pool.
   *
   * @param target - Logical destination
   * @param role - Credential to resolve
   * @param sql - SQL
   * @returns The driver result
   */
  query(target: Target, role: RegistryRole, sql: string): Promise<ExecuteResult>;
  /**
   * Reserves one connection.
   *
   * The pool cannot be evicted until `release`.
   *
   * @param target - Logical destination
   * @param role - Credential to resolve
   * @returns A connection the caller must release
   */
  reserve(target: Target, role: RegistryRole): Promise<ReservedTarget>;
  /**
   * Closes pools that have been idle for `idleTimeout` and hold no reservation.
   *
   * @returns How many pools closed
   */
  sweep(): Promise<number>;
  /**
   * Closes the cached pool but keeps the URL it was opened with.
   *
   * The next `query` opens that URL again. An authentication failure then
   * re-resolves once. Tests use this to drop a live session after a password
   * change: Postgres does not drop an already-open session.
   *
   * @param target - Logical destination
   */
  releaseIdle(target: Target): Promise<void>;
  /** Cap, reservation, eviction, and auth-retry counters. */
  stats(): TargetPoolStats;
  /** Closes every pool. */
  close(): Promise<void>;
};

/**
 * Builds the capped pool map.
 *
 * @param options - Resolver source, cap, idle time, and driver options
 * @returns The pool map
 */
export function openTargetPools(options: {
  readonly source: TargetSource;
  readonly maxOpenTargets: number;
  readonly idleTimeout: number;
  readonly applicationName: string;
  readonly now?: () => number;
}): TargetPools {
  const maxOpenTargets = Math.max(1, options.maxOpenTargets);
  const now = options.now ?? Date.now;
  const driverOptions: PostgresJsOptions = {
    max: 1,
    applicationName: options.applicationName,
    idleTimeout: 1,
  };
  const pools = new Map<string, Slot>();
  const bound = new Map<string, string>();
  let evictions = 0;
  let authRetries = 0;

  async function evict(keep?: string): Promise<void> {
    while (pools.size > maxOpenTargets) {
      const victim = [...pools.values()]
        .filter((slot) => slot.reserved === 0 && slot.url !== keep)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (victim === undefined) return;
      await forget(victim.url, true);
    }
  }

  async function forget(url: string, countEviction: boolean): Promise<void> {
    const slot = pools.get(url);
    if (slot === undefined) return;
    pools.delete(url);
    if (countEviction) evictions += 1;
    for (const [name, boundUrl] of bound) {
      if (boundUrl === url) bound.delete(name);
    }
    await slot.pool.close();
  }

  async function openSlot(url: string): Promise<Slot> {
    const pool = openPostgresJs(url, driverOptions);
    try {
      await pool.execute("select 1");
    } catch (error) {
      await pool.close().catch(() => undefined);
      throw error;
    }
    return { url, pool, reserved: 0, lastUsed: now(), retried: false };
  }

  async function connect(
    target: Target,
    role: RegistryRole,
    staleUrl: string | undefined,
    attempt: number,
  ): Promise<Slot> {
    const url = staleUrl ?? connectionUrl(resolveTarget(options.source, target, role));
    try {
      const slot = await openSlot(url);
      pools.set(url, slot);
      bound.set(target.name, url);
      slot.lastUsed = now();
      await evict(url);
      const kept = pools.get(url);
      if (kept === undefined) {
        throw new Error(`Pool for ${target.name} was evicted while reserved work was starting.`);
      }
      return kept;
    } catch (error) {
      if (isAuthFailure(error) && attempt === 0) {
        authRetries += 1;
        const fresh = connectionUrl(resolveTarget(options.source, target, role));
        return connect(target, role, fresh, 1);
      }
      throw error;
    }
  }

  async function ensure(target: Target, role: RegistryRole): Promise<Slot> {
    const cached = bound.get(target.name);
    if (cached !== undefined) {
      const existing = pools.get(cached);
      if (existing !== undefined) {
        existing.lastUsed = now();
        return existing;
      }
    }
    return connect(target, role, cached, 0);
  }

  return {
    async query(target, role, sql) {
      const slot = await ensure(target, role);
      try {
        const result = await slot.pool.execute(sql);
        slot.lastUsed = now();
        return result;
      } catch (error) {
        if (!isAuthFailure(error) || slot.retried) throw error;
        slot.retried = true;
        authRetries += 1;
        await forget(slot.url, false);
        const fresh = connectionUrl(resolveTarget(options.source, target, role));
        const replaced = await connect(target, role, fresh, 1);
        replaced.retried = true;
        replaced.lastUsed = now();
        return replaced.pool.execute(sql);
      }
    },
    async reserve(target, role) {
      const slot = await ensure(target, role);
      if (slot.pool.reserve === undefined) {
        throw new Error(`Pool for ${target.name} cannot reserve a connection.`);
      }
      const connection = await slot.pool.reserve();
      slot.reserved += 1;
      let released = false;
      const held: ReservedTarget = {
        execute(sql) {
          return connection.execute(sql);
        },
        release() {
          if (released) return;
          released = true;
          releaseConnection(connection);
          slot.reserved = Math.max(0, slot.reserved - 1);
          slot.lastUsed = now();
        },
      };
      return held;
    },
    async sweep() {
      const cutoff = now() - options.idleTimeout;
      const stale = [...pools.values()].filter(
        (slot) => slot.reserved === 0 && slot.lastUsed <= cutoff,
      );
      for (const slot of stale) await forget(slot.url, false);
      return stale.length;
    },
    async releaseIdle(target) {
      const url = bound.get(target.name);
      if (url === undefined) return;
      const slot = pools.get(url);
      if (slot === undefined || slot.reserved > 0) return;
      pools.delete(url);
      await slot.pool.close();
    },
    stats() {
      let reserved = 0;
      for (const slot of pools.values()) {
        if (slot.reserved > 0) reserved += 1;
      }
      return { openPools: pools.size, reserved, evictions, authRetries };
    },
    async close() {
      const slots = [...pools.values()];
      pools.clear();
      bound.clear();
      for (const slot of slots) await slot.pool.close();
    },
  };
}

function releaseConnection(connection: DriverConnection): void {
  connection.release();
}

/**
 * True when opening a connection was refused for a password or an auth method.
 *
 * SQLSTATE 28P01 is an invalid password. 28000 is an invalid authorization
 * specification.
 *
 * @param error - Driver or server error
 * @returns Whether the pool should re-resolve once
 */
export function isAuthFailure(error: unknown): boolean {
  const state = sqlstateOf(error);
  return state === "28P01" || state === "28000";
}

function sqlstateOf(error: unknown): string | undefined {
  if (error instanceof DriverError) return error.sqlstate;
  if (typeof error !== "object" || error === null) return undefined;
  if ("sqlstate" in error && typeof error.sqlstate === "string") return error.sqlstate;
  if ("code" in error && typeof error.code === "string" && error.code.length > 0) {
    return error.code;
  }
  if ("cause" in error) return sqlstateOf(error.cause);
  return undefined;
}
