/**
 * The slice of Bun.sql this adapter uses.
 *
 * `bun` is the runtime, not an npm package, and it ships no types. The
 * published declarations name these types instead of importing `bun`, so a
 * consumer can typecheck `okmodel/pg/bun` without `bun-types`.
 */

/** A pending query. `raw()` asks for rows as arrays. */
export interface SQLQuery extends Promise<unknown> {
  /** Rows as arrays instead of objects. */
  raw(): SQLQuery;
}

/** One pooled Bun.sql client. */
export interface SQL {
  /**
   * Runs a statement.
   *
   * @param text - SQL text
   * @param values - Positional parameters
   */
  unsafe(text: string, values?: readonly unknown[]): SQLQuery;
  /**
   * Checks out one connection.
   *
   * @param options - `signal` aborts the wait
   */
  reserve(options?: { readonly signal?: AbortSignal }): Promise<ReservedSQL>;
  /** Closes the pool. */
  close(): Promise<void>;
  /**
   * Subscribes to one `LISTEN` channel.
   *
   * @param channel - Channel name
   * @param onnotify - Payload callback
   */
  listen(channel: string, onnotify: (payload: string) => void): Promise<SQLListen>;
}

/** A `LISTEN` registration. */
export interface SQLListen {
  /** Drops this registration. */
  unlisten(): Promise<void>;
}

/**
 * One connection reserved from {@link SQL.reserve}.
 *
 * `release` returns it to the pool.
 */
export interface ReservedSQL extends SQL {
  /** Returns the connection to the pool. */
  release(): void;
}
