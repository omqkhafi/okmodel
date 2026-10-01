/**
 * Driver contract for the spike.
 *
 * The shapes follow spec section 4.2. `tx` is the runtime's transaction helper
 * from section 15; this spike puts it on the pool because there is no client yet.
 * Codecs stay out of the adapter: cell values are Postgres wire text.
 */

/** How a driver prepares statements. One connection declares one default. */
export type PreparedMode = "named" | "unnamed" | "none";

/** Execution capabilities. Atomic `batch` is not a flag. */
export type DriverCapabilityFlags = {
  readonly transactions: "interactive" | "batch";
  /** Rows can be pulled in chunks. */
  readonly stream: boolean;
  /** `LISTEN` / `NOTIFY`. */
  readonly listen: boolean;
  /** An in-flight statement can be aborted with `AbortSignal`. */
  readonly cancel: boolean;
  /** What the adapter does unless a call overrides it. */
  readonly prepared: PreparedMode;
  /** The server can describe a statement without running it. */
  readonly describe: boolean;
};

/** One SQL statement and its wire parameters. `$1` is params[0]. */
export type Statement = {
  readonly text: string;
  readonly params?: readonly (string | null)[] | undefined;
};

/** A server notice. Drivers normalise their own notice objects into this. */
export type Notice = {
  readonly severity: string;
  readonly code?: string | undefined;
  readonly message: string;
};

/**
 * Result of one statement.
 *
 * `rows` are wire text, or null. `columns` names those cells in order.
 * `count` is the command-tag count: affected rows for a write, returned rows
 * for a select.
 */
export type ExecuteResult = {
  readonly rows: readonly (readonly (string | null)[])[];
  readonly columns: readonly string[];
  readonly count: number;
  readonly notices: readonly Notice[];
};

/** Per-call options from spec section 4.2 and section 15. */
export type ExecuteOptions = {
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds for the whole call. */
  readonly timeout?: number | undefined;
  /**
   * Asks the adapter for one prepared mode.
   * The default is the capability flag. A mode the driver does not list fails.
   */
  readonly prepared?: PreparedMode | undefined;
};

/** Column names and parameter count from a describe, without running the statement. */
export type DescribeResult = {
  readonly columns: readonly string[];
  readonly parameterCount: number;
};

/** Pool counters for selection strategies. Spec section 4.2. */
export type DriverStats = {
  readonly size: number;
  readonly idle: number;
  readonly inflight: number;
  readonly waiting: number;
};

/**
 * A connection checked out of a pool.
 *
 * Present when `transactions` is `interactive`. `batch` on this connection
 * uses a savepoint when a transaction is already open.
 */
export type DriverConnection = {
  /**
   * Runs one statement on this connection.
   *
   * @param text - SQL, with `$1` placeholders
   * @param params - Wire parameters
   * @param options - Cancellation, timeout, and prepared mode
   * @returns Rows, count, and notices
   */
  execute(
    text: string,
    params?: readonly (string | null)[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
  /**
   * Atomic batch on this connection.
   *
   * Inside a transaction this is a savepoint. A statement failure rolls back
   * to that savepoint and leaves the transaction open.
   *
   * @param statements - Statements in order. None may read another's result
   * @param options - Apply to the whole batch
   * @returns One result per statement, in order
   */
  batch(
    statements: readonly Statement[],
    options?: ExecuteOptions,
  ): Promise<readonly ExecuteResult[]>;
  /** Returns the connection to the pool. */
  release(): void;
};

/**
 * One endpoint's pool.
 *
 * `reserve` and `tx` exist only for `transactions: "interactive"`.
 * `stream`, `listen`, `notify`, and `describe` exist only when that flag is set.
 */
export type DriverPool = {
  /** Declared execution capabilities. */
  readonly capabilities: DriverCapabilityFlags;
  /** Prepared modes this pool can actually request. */
  readonly preparedModes: readonly PreparedMode[];
  /**
   * Runs one statement on some connection.
   *
   * @param text - SQL, with `$1` placeholders
   * @param params - Wire parameters
   * @param options - Cancellation, timeout, and prepared mode
   * @returns Rows, count, and notices
   */
  execute(
    text: string,
    params?: readonly (string | null)[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
  /**
   * Atomic batch: all statements commit, or none do.
   *
   * @param statements - Statements in order
   * @param options - Apply to the whole batch
   * @returns One result per statement, in order
   */
  batch(
    statements: readonly Statement[],
    options?: ExecuteOptions,
  ): Promise<readonly ExecuteResult[]>;
  /**
   * Checks out one connection.
   *
   * Absent when `transactions` is `batch`.
   *
   * @returns A connection the caller must release
   */
  reserve?: (() => Promise<DriverConnection>) | undefined;
  /**
   * Runs `fn` in one transaction on a reserved connection.
   *
   * This is the spike's stand-in for the runtime `tx` helper. A thrown error
   * rolls the transaction back.
   *
   * @param fn - Work bound to one connection
   * @returns Whatever `fn` returns
   */
  tx?: (<T>(fn: (connection: DriverConnection) => Promise<T>) => Promise<T>) | undefined;
  /**
   * Describes a statement.
   *
   * @param text - SQL
   * @param params - Wire parameters, when the driver needs them to parse
   * @returns Column names and the parameter count
   */
  describe?:
    | ((text: string, params?: readonly (string | null)[]) => Promise<DescribeResult>)
    | undefined;
  /**
   * Yields row chunks.
   *
   * @param text - SQL
   * @param params - Wire parameters
   * @returns Chunks of rows
   */
  stream?:
    | ((
        text: string,
        params?: readonly (string | null)[],
      ) => AsyncIterable<readonly (readonly (string | null)[])[]>)
    | undefined;
  /**
   * Listens on a channel.
   *
   * @param channel - Channel name
   * @param onNotify - Called with each payload
   * @returns Stops listening
   */
  listen?:
    | ((channel: string, onNotify: (payload: string) => void) => Promise<() => Promise<void>>)
    | undefined;
  /**
   * Sends a notification.
   *
   * @param channel - Channel name
   * @param payload - Payload text
   */
  notify?: ((channel: string, payload: string) => Promise<void>) | undefined;
  /** Pool counters. */
  stats(): DriverStats;
  /**
   * Statements this pool has sent since the last call.
   *
   * Spike measurement. Not part of the spec contract. The count resets.
   *
   * @returns The number of statements sent
   */
  takeStatements(): number;
  /** Postgres `server_version`. */
  serverVersion(): Promise<string>;
  /** Closes every connection. */
  close(): Promise<void>;
};
