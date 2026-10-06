/**
 * Driver contract (spec §4.2). Types only: this module has no runtime.
 *
 * Adapters implement these shapes. Values cross the boundary as wire text.
 * Codecs stay in the dialect.
 */

/** How a driver runs transactions. Atomic `batch` is not a mode. */
export type TransactionMode = "interactive" | "batch" | "none";

/** How a driver prepares statements. */
export type PreparedMode = "named" | "unnamed" | "none";

/**
 * Execution capabilities for one driver (spec §4).
 *
 * Atomic `batch` is required on every driver and is not a flag.
 */
export type DriverCapabilities = {
  /** `reserve` exists only when this is `"interactive"`. */
  readonly transactions: TransactionMode;
  /** Rows can be pulled in chunks. */
  readonly stream: boolean;
  /** `LISTEN` / `NOTIFY`. */
  readonly listen: boolean;
  /** An in-flight statement can be aborted. */
  readonly cancel: boolean;
  /** Prepared-statement mode this driver uses. */
  readonly prepared: PreparedMode;
  /** The server can describe a statement without running it. */
  readonly describe: boolean;
};

/** A Postgres wire value. Null is SQL NULL. */
export type WireValue = string | null;

/** One statement. `$1` is `params[0]`. */
export type Statement = {
  readonly text: string;
  /** Wire parameters. Omitted when the statement has none. */
  readonly params?: readonly WireValue[];
};

/** A server notice, normalised from the driver's own notice object. */
export type Notice = {
  readonly severity: string;
  readonly code?: string;
  readonly message: string;
};

/**
 * Result of one statement.
 *
 * `count` is the affected-row count. `rows` are wire text.
 */
export type ExecuteResult = {
  readonly rows: readonly (readonly WireValue[])[];
  readonly count: number;
  readonly notices: readonly Notice[];
};

/** Per-call cancellation and deadline (spec §4.2, §15). */
export type ExecuteOptions = {
  /** Abort the call. An abort is kind `cancelled`. */
  readonly signal?: AbortSignal;
  /**
   * Milliseconds for the whole call.
   *
   * A deadline is kind `timeout`.
   */
  readonly timeout?: number;
  /**
   * Read routing hint.
   *
   * Drivers ignore it. A topology router reads it. Absent, the router
   * classifies the statement.
   */
  readonly route?: "primary" | "replica";
};

/** Column names and parameter count from a describe. */
export type DescribeResult = {
  readonly columns: readonly string[];
  readonly parameterCount: number;
};

/** Pool counters for selection strategies (spec §4.2). */
export type DriverStats = {
  readonly size: number;
  readonly idle: number;
  readonly inflight: number;
  readonly waiting: number;
};

/**
 * Why a call ended before a statement result (D124).
 *
 * `outcome_unknown` means a commit was sent and the result never arrived.
 * The dialect maps it to OKM1401. Adapters do not construct `OkmError`.
 */
export type DriverFailureKind = "timeout" | "cancelled" | "outcome_unknown";

/**
 * Fields on {@link DriverError}.
 *
 * `batchIndex` is the failing statement, or `null` when the failure is the
 * commit itself (a deferred constraint). `kind` is set for a timeout, an
 * abort, or a commit whose result never arrived, and is absent on a database
 * error.
 */
export type DriverErrorFields = {
  readonly sqlstate?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly detail?: string;
  readonly cause?: unknown;
  readonly batchIndex?: number | null;
  readonly kind?: DriverFailureKind;
};

/**
 * A connection checked out of a pool.
 *
 * Present when `transactions` is `"interactive"`. `batch` on a connection
 * that already has a transaction uses a savepoint and does not commit the
 * outer transaction (D124).
 */
export type DriverConnection = {
  /** Runs one statement on this connection. */
  execute(
    text: string,
    params?: readonly WireValue[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;

  /** Atomic batch. Inside a transaction this is a savepoint and does not commit the outer one. */
  batch(
    statements: readonly Statement[],
    options?: ExecuteOptions,
  ): Promise<readonly ExecuteResult[]>;

  /** Returns the connection after `RESET ALL` and `pg_advisory_unlock_all()`. */
  release(): Promise<void>;

  /** Aborts the in-flight statement. Present when `cancel` is set. */
  cancel?(): void;
};

/**
 * One endpoint's pool.
 *
 * `reserve`, `stream`, `describe`, `listen`, and `cancel` are present only
 * when the matching capability is set.
 */
export type DriverPool = {
  /** Declared execution capabilities. */
  readonly capabilities: DriverCapabilities;

  /** Runs one statement on some connection. */
  execute(
    text: string,
    params?: readonly WireValue[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;

  /** Atomic batch. All statements commit, or none do. */
  batch(
    statements: readonly Statement[],
    options?: ExecuteOptions,
  ): Promise<readonly ExecuteResult[]>;

  /** Checks out one connection. Present when `transactions` is `"interactive"`. */
  reserve?(): Promise<DriverConnection>;

  /** Describes a statement without running it. Present when `describe` is set. */
  describe?(text: string, params?: readonly WireValue[]): Promise<DescribeResult>;

  /** Yields row chunks. Present when `stream` is set. */
  stream?(
    text: string,
    params?: readonly WireValue[],
  ): AsyncIterable<readonly (readonly WireValue[])[]>;

  /** Listens on a channel. Present when `listen` is set. The returned function stops listening. */
  listen?(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>;

  /** Aborts in-flight statements on this pool. Present when `cancel` is set. */
  cancel?(): void;

  /** Pool counters. */
  stats(): DriverStats;

  /** Closes every connection. */
  close(): Promise<void>;
};

/**
 * Pool options shared by adapters.
 *
 * One `open` is one endpoint. The runtime does not share a pool across
 * endpoints.
 */
export type DriverPoolConfig = {
  /** Connections in the pool. PGlite is always one. */
  readonly max?: number;
  /**
   * Ceilings in milliseconds. An adapter reads `acquire`: it waits for a
   * connection up to that long, then fails with OKM1846. Omitted means wait
   * without a deadline. The other keys belong to the runtime.
   */
  readonly timeouts?: DriverTimeouts;
};

/**
 * Ceilings from `connect({ timeouts })`, in milliseconds (spec §15).
 *
 * `acquire` bounds the wait for a connection (OKM1846). `statement` is the
 * default `timeout` of a call that sets none. `transaction` bounds a whole
 * `tx()`. `idleInTransaction` bounds the time a `tx()` waits between
 * statements. Every one but `acquire` fails as kind `timeout`.
 */
export type DriverTimeouts = {
  readonly acquire?: number;
  readonly statement?: number;
  readonly transaction?: number;
  readonly idleInTransaction?: number;
};
