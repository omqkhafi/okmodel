/**
 * Bounds the Neon startup check.
 *
 * Loaded only when `connect` is given a `signal` or a positive `timeout`.
 * The check is read-only, so giving up on it is safe: the caller's abort
 * settles `connected` as `cancelled`, and a positive `timeout` settles it as
 * `timeout`. The request or socket may still be open; it is aborted or
 * destroyed, and its later rejection is ignored.
 */

import {
  NEON_HTTP_CAPABILITIES,
  NEON_WEBSOCKET_CAPABILITIES,
} from "../../adapters/capabilities.js";
import {
  neonEarly,
  neonPool,
  neonSettle,
  open,
  rejectAfterClose,
  type NeonConfig,
} from "../../adapters/pg/neon.js";
import { cancelled, timedOut } from "../../adapters/error.js";
import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { createClient } from "../client.js";
import type { SessionContext } from "../session/index.js";
import type { Connected } from "../types.js";
import type { NeonConnectOptions } from "./neon.js";

type Bound = {
  readonly signal: AbortSignal | undefined;
  readonly timeout: number | undefined;
};

/**
 * Connects one Neon URL and races the startup check against `signal` and `timeout`.
 *
 * An already-aborted signal does not open a socket.
 *
 * @param target - Connection URL
 * @param options - Schema, mode, and the startup bound
 * @returns The client. Await `connected` for the check
 */
export function connectBounded<S extends QuerySchema, C extends SessionContext | undefined>(
  target: string,
  options: NeonConnectOptions<S, C>,
): Promise<Connected<S, C>> {
  if (options.signal?.aborted === true) return Promise.resolve(deadClient(options));
  const config = {
    url: target,
    mode: options.mode,
    max: options.max,
    idleTimeoutMs: options.idleTimeoutMs,
    timeouts: options.timeouts,
    prepared: options.prepared,
    searchPath: options.searchPath,
    [neonEarly]: true,
  } as NeonConfig;
  return open(config).then((pool) => admit(pool, options), mapOpen);
}

function deadClient<S extends QuerySchema, C extends SessionContext | undefined>(
  options: NeonConnectOptions<S, C>,
): Connected<S, C> {
  const error = cancelled();
  const pool: DriverPool = {
    capabilities: options.mode === "http" ? NEON_HTTP_CAPABILITIES : NEON_WEBSOCKET_CAPABILITIES,
    execute: () => Promise.reject(error),
    batch: () => Promise.reject(error),
    stats: () => ({ size: 0, idle: 0, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
  return createClient(options.schema, pool, strip(options), true) as unknown as Connected<S, C>;
}

function admit<S extends QuerySchema, C extends SessionContext | undefined>(
  pool: DriverPool,
  options: NeonConnectOptions<S, C>,
): Connected<S, C> {
  let checking = true;
  let shut = false;
  let settled: Promise<void> | undefined;
  const bound: Bound = { signal: options.signal, timeout: options.timeout };
  const wrapped: DriverPool = {
    capabilities: pool.capabilities,
    execute: (text, params, call) => {
      if (shut && !checking) return rejectAfterClose();
      if (checking && bound.signal?.aborted === true) {
        checking = false;
        abandon(pool);
        return Promise.reject(cancelled());
      }
      const work = pool.execute(text, params, call);
      if (!checking) return work;
      return race(work, bound, () => {
        checking = false;
        abandon(pool);
      });
    },
    batch: (statements, call) =>
      shut && !checking ? rejectAfterClose() : pool.batch(statements, call),
    stats: () => pool.stats(),
    close: () => settled!.then(() => pool.close()),
    ...(pool.reserve !== undefined
      ? { reserve: () => (shut && !checking ? rejectAfterClose() : pool.reserve!()) }
      : {}),
  };
  const client = createClient(options.schema, wrapped, strip(options), true);
  const done = (): void => {
    checking = false;
    release(pool);
  };
  settled = client.connected.then(done, done);
  return client as unknown as Connected<S, C>;
}

function strip<S extends QuerySchema, C extends SessionContext | undefined>(
  options: NeonConnectOptions<S, C>,
): NeonConnectOptions<S, C> {
  if (options.signal === undefined && options.timeout === undefined) return options;
  const { signal: _signal, timeout: _timeout, ...rest } = options;
  return rest;
}

function race<T>(work: Promise<T>, bound: Bound, onLose: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = bound.signal;
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined && signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      stop();
      run();
    };
    const lose = (error: ReturnType<typeof cancelled>): void => {
      if (settled) return;
      try {
        onLose();
      } catch {
        // The socket may already be gone.
      }
      finish(() => reject(error));
    };
    let onAbort: (() => void) | undefined;
    const timeout = bound.timeout;
    if (timeout !== undefined && timeout > 0) timer = setTimeout(() => lose(timedOut()), timeout);
    if (signal !== undefined) {
      onAbort = (): void => lose(cancelled());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function release(pool: DriverPool): void {
  settle(pool, false);
}

function abandon(pool: DriverPool): void {
  settle(pool, true);
  const raw = (pool as unknown as Record<symbol, unknown>)[neonPool];
  if (typeof raw === "object" && raw !== null) destroyClients(raw);
}

function settle(pool: DriverPool, abort: boolean): void {
  const fn = (pool as unknown as Record<symbol, unknown>)[neonSettle];
  if (typeof fn === "function") fn(abort);
}

function destroyClients(raw: object): void {
  const clients = (raw as { _clients?: readonly SocketClient[] })._clients;
  if (clients === undefined) return;
  for (const client of clients) {
    const stream = client.connection?.stream;
    if (stream !== undefined && typeof stream.destroy === "function") {
      stream.destroy();
      continue;
    }
    try {
      client.end?.();
    } catch {
      // Already closing.
    }
  }
}

type SocketClient = {
  connection?: { stream?: { destroy?: () => void } };
  end?: () => void;
};

function mapOpen(error: unknown): Promise<never> {
  return import("../../dialects/pg/errors.js").then((mod) =>
    Promise.reject(mod.mapPostgresError(error)),
  );
}
