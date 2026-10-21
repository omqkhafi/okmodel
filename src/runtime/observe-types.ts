/**
 * Write-observer event shapes (`okm.observe/1`).
 *
 * Normative copy: `docs/observer-events.md`. Additive-only inside this contract.
 * The public entry is `okmodel/observe` (lazy). Nothing here enters the runtime
 * entry.
 */

/** Dialect tag on every write event. Postgres only in this train. */
export type ObserveDialect = "postgres";

/** How `rowCount` was derived. G-4 always emits `unknown`. */
export type RowCountMode = "changed" | "matched" | "returned" | "unknown";

/** One write key (G-5). Present only when keys are requested and available. */
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
