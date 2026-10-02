/**
 * One pool per endpoint.
 *
 * The router picks an endpoint. This pool then picks a connection. A checkout
 * never borrows a connection from another endpoint. Waiting longer than
 * `timeouts.acquire` fails with OKM1846.
 */

import { isConnectionLoss } from "../drivers/errors.js";
import type { DriverConnection, DriverPool, ExecuteResult, Statement } from "../drivers/types.js";
import { acquireTimeout } from "./error.js";
import type { EndpointRole } from "./types.js";

/** A connection reserved from one endpoint. */
export type HeldConnection = {
  /** Runs one statement on this connection. */
  execute(text: string, params?: readonly (string | null)[]): Promise<ExecuteResult>;
  /**
   * Atomic batch on this connection.
   *
   * The adapter starts its own transaction when the connection is idle.
   * Inside a spike transaction, use {@link HeldConnection.savepointBatch}.
   */
  batch(statements: readonly Statement[]): Promise<readonly ExecuteResult[]>;
  /**
   * Runs statements on a savepoint of the current transaction.
   *
   * A failure rolls back to the savepoint and leaves the transaction open.
   */
  savepointBatch(statements: readonly Statement[]): Promise<readonly ExecuteResult[]>;
  /** Returns the connection to this endpoint's pool. */
  release(): void;
};

/** Pool counters the router reads. */
export type PoolStats = {
  /** Configured checkout limit. */
  readonly size: number;
  /** Free slots. */
  readonly idle: number;
  /** Checkouts in use. */
  readonly inflight: number;
  /** Callers waiting for a slot. */
  readonly waiting: number;
};

/** A statement the pool sent, for tests that assert where SQL landed. */
export type StatementEvent = {
  /** Endpoint name. */
  readonly endpoint: string;
  /** SQL text. */
  readonly text: string;
};

/**
 * The connections of one endpoint.
 */
export type EndpointPool = {
  /** Endpoint name. */
  readonly name: string;
  /** Primary or replica. */
  readonly role: EndpointRole;
  /** Selection weight. */
  readonly weight: number;
  /** Pool counters. */
  stats(): PoolStats;
  /**
   * Runs one statement on whatever connection the adapter picks.
   *
   * Probes use this. It does not take a spike checkout slot.
   *
   * @param text - SQL
   * @returns The adapter result
   */
  query(text: string): Promise<ExecuteResult>;
  /**
   * Reserves one connection.
   *
   * @param timeoutMs - How long to wait for a free slot and for the adapter
   * @returns A connection the caller must release
   */
  acquire(timeoutMs: number): Promise<HeldConnection>;
  /** Closes the adapter pool and rejects waiters. */
  close(): Promise<void>;
};

type Waiter = {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Wraps one driver pool as an endpoint pool.
 *
 * @param options - Name, role, limit, and the adapter pool
 * @returns The endpoint pool
 */
export function openEndpointPool(options: {
  readonly name: string;
  readonly role: EndpointRole;
  readonly weight: number;
  readonly max: number;
  readonly driver: DriverPool;
  readonly onStatement?: ((event: StatementEvent) => void) | undefined;
}): EndpointPool {
  const max = Math.max(1, options.max);
  let used = 0;
  const waiters: Waiter[] = [];
  let closed = false;

  function give(): void {
    const next = waiters.shift();
    if (next === undefined) {
      used = Math.max(0, used - 1);
      return;
    }
    if (next.timer !== undefined) clearTimeout(next.timer);
    let released = false;
    next.resolve(() => {
      if (released) return;
      released = true;
      give();
    });
  }

  function take(timeoutMs: number): Promise<() => void> {
    if (closed) return Promise.reject(new Error(`Pool '${options.name}' is closed.`));
    if (used < max) {
      used += 1;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        give();
      });
    }
    if (timeoutMs <= 0) return Promise.reject(acquireTimeout(options.name, timeoutMs));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index < 0) return;
        waiters.splice(index, 1);
        reject(acquireTimeout(options.name, timeoutMs));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function failWaiters(): void {
    for (const waiter of waiters.splice(0)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(new Error(`Pool '${options.name}' is closed.`));
    }
  }

  return {
    name: options.name,
    role: options.role,
    weight: options.weight,
    stats() {
      return {
        size: max,
        idle: Math.max(0, max - used),
        inflight: used,
        waiting: waiters.length,
      };
    },
    query(text) {
      options.onStatement?.({ endpoint: options.name, text });
      return options.driver.execute(text);
    },
    acquire(timeoutMs) {
      return checkout(options, take, timeoutMs);
    },
    async close() {
      closed = true;
      failWaiters();
      await options.driver.close();
    },
  };
}

async function checkout(
  options: {
    readonly name: string;
    readonly driver: DriverPool;
    readonly onStatement?: ((event: StatementEvent) => void) | undefined;
  },
  take: (timeoutMs: number) => Promise<() => void>,
  timeoutMs: number,
): Promise<HeldConnection> {
  const releaseSlot = await take(timeoutMs);
  let connection: DriverConnection;
  try {
    connection = await reserveWithin(options.driver, options.name, timeoutMs);
  } catch (error) {
    releaseSlot();
    throw error;
  }
  let released = false;
  const note = (text: string): void => {
    options.onStatement?.({ endpoint: options.name, text });
  };
  return {
    execute(text, params) {
      note(text);
      return connection.execute(text, params);
    },
    batch(statements) {
      for (const statement of statements) note(statement.text);
      return connection.batch(statements);
    },
    savepointBatch(statements) {
      for (const statement of statements) note(statement.text);
      return runSavepoint(connection, statements);
    },
    release() {
      if (released) return;
      released = true;
      connection.release();
      releaseSlot();
    },
  };
}

function reserveWithin(
  driver: DriverPool,
  endpoint: string,
  timeoutMs: number,
): Promise<DriverConnection> {
  const reserve = driver.reserve;
  if (reserve === undefined) {
    return Promise.reject(new Error(`Endpoint '${endpoint}' has no reserve().`));
  }
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(acquireTimeout(endpoint, timeoutMs));
    }, timeoutMs);
    reserve().then(
      (connection) => {
        clearTimeout(timer);
        if (timedOut) {
          connection.release();
          return;
        }
        resolve(connection);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(error);
      },
    );
  });
}

let savepointIds = 0;

async function runSavepoint(
  connection: DriverConnection,
  statements: readonly Statement[],
): Promise<readonly ExecuteResult[]> {
  const name = `okm_sp_${String(savepointIds)}`;
  savepointIds += 1;
  await connection.execute(`SAVEPOINT ${name}`);
  const results: ExecuteResult[] = [];
  try {
    for (const statement of statements) {
      results.push(await connection.execute(statement.text, statement.params));
    }
    await connection.execute(`RELEASE SAVEPOINT ${name}`);
    return results;
  } catch (error) {
    if (!isConnectionLoss(error)) {
      await connection.execute(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      await connection.execute(`RELEASE SAVEPOINT ${name}`).catch(() => undefined);
    }
    throw error;
  }
}
