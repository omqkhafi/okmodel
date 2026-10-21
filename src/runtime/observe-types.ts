/**
 * Write-observer event shapes (`okm.observe/1`).
 *
 * Normative copy: `docs/observer-events.md`. Additive-only inside this contract.
 * The public entry is `okmodel/observe` (lazy). Nothing here enters the runtime
 * entry.
 */

/** Dialect tag on every write event. Postgres only in this train. */
export type ObserveDialect = "postgres";

/**
 * How `rowCount` was derived.
 *
 * `changed` is inserted, updated, or deleted rows (an upsert counts inserted
 * plus updated). `returned` is a statement whose SQL ran `RETURNING`.
 * `unknown` means the driver gave no command tag. `matched` is reserved.
 */
export type RowCountMode = "changed" | "matched" | "returned" | "unknown";

/** One primary-key record. Present only when that table was opted in. */
export type ObserveKey = Readonly<Record<string, unknown>>;

/** One statement that ran inside a unit. */
export type WriteEvent = {
  readonly type: "write";
  readonly unit: string;
  readonly seq: number;
  readonly dialect: ObserveDialect;
  readonly table: string | null;
  readonly op: "insert" | "update" | "delete" | "upsert" | "archive" | "restore" | "raw";
  readonly rowCount: number | null;
  readonly rowCountMode: RowCountMode;
  readonly keys?: readonly ObserveKey[];
  readonly tenant: Readonly<Record<string, unknown>> | null;
  readonly settings: readonly string[];
  readonly durationMs: number;
  readonly tag?: string;
  readonly source: "client" | "raw";
};

/** A savepoint that released or rolled back inside a unit. */
export type SavepointEvent = {
  readonly type: "savepoint";
  readonly unit: string;
  readonly name: string;
  readonly state: "released" | "rolled_back";
  readonly depth: number;
};

/** Tri-state end of a unit. */
export type OutcomeEvent = {
  readonly type: "outcome";
  readonly unit: string;
  readonly outcome: "committed" | "rolled_back" | "unknown";
  /** Writes that survived savepoint rollbacks. */
  readonly writes: number;
  readonly dbTxId?: string;
};

/** Low-level events delivered to `onWrite`. */
export type ObserveEvent = WriteEvent | SavepointEvent | OutcomeEvent;

/**
 * Raw `connect({ onWrite })` handler.
 *
 * May return a promise. The write path does not await it; `flush()` does.
 */
export type OnWrite = (event: ObserveEvent) => void | Promise<void>;

/** Where a statement ran. */
export type QueryRoute = {
  readonly endpoint: string;
  readonly role: "primary" | "replica";
};

/** A caller-supplied limit. Default limits are not reported. */
export type QueryLimit = {
  readonly value: number;
  readonly source: string;
};

/** Failure fields. No message and no row values. */
export type QueryError = {
  readonly kind: string;
  readonly category: string;
  readonly code: string;
  /** SQLSTATE when the server sent one. */
  readonly sqlstate?: string;
};

/**
 * One statement, delivered after it settles.
 *
 * `unit` and `seq` are set only inside a transaction, a batch, or an
 * autocommit write unit. `params` and `stack` are set only when the observer
 * opts in.
 */
export type QueryEvent = {
  readonly id: string;
  readonly unit?: string;
  readonly seq?: number;
  readonly dialect: ObserveDialect;
  readonly table: string | null;
  readonly op: string;
  readonly summary: string;
  readonly fingerprint: string;
  readonly text: string;
  readonly durationMs: number;
  readonly queueMs: number | null;
  readonly queryMs: number;
  readonly decodeMs: number | null;
  readonly rowCount: number | null;
  readonly rowCountMode: RowCountMode;
  readonly route: QueryRoute;
  readonly error?: QueryError;
  readonly tag?: string;
  readonly limit?: QueryLimit;
  readonly params?: readonly unknown[];
  readonly stack?: string;
};

/**
 * Raw `connect({ onQuery })` handler.
 *
 * May return a promise. The statement path does not await it; `flush()` does.
 */
export type OnQuery = (event: QueryEvent) => void | Promise<void>;
