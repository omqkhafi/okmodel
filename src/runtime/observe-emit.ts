/**
 * Write-observer emission and unit tracking.
 *
 * Loaded only when `connect({ onWrite })` is set, or when both hookm and an
 * observer share the same phase path. Hookm stays a separate import when no
 * observer is registered. One emission point drives `hookm.onTransaction` and
 * unit outcomes so they cannot disagree.
 */

import { OkmError } from "../contracts/error.js";
import type { Hookm, TransactionEvent } from "./types.js";
import type {
  ObserveEvent,
  ObserveKey,
  OnWrite,
  OutcomeEvent,
  SavepointEvent,
  WriteEvent,
} from "./observe-types.js";

/** Default pending-event ceiling (mirrored by `okmodel/observe`). */
const DEFAULT_MAX_PENDING = 10_000;

/** Optional hooks carried on a {@link OnWrite} function from `writeObserver`. */
type OnWriteExtras = OnWrite & {
  readonly maxPending?: number;
  onObserverError?: (err: unknown, event: WriteEvent | OutcomeEvent | SavepointEvent) => void;
};

/** Lazy slot shared by reference across session copies. */
export type ObservingSlot = {
  readonly w: OnWrite;
  c: ObserverController | undefined;
};

/** What emission needs once the controller is resolved. */
export type ObserveHost = {
  readonly hookm?: readonly Hookm[] | undefined;
  readonly observer?: ObserverController | undefined;
};

/**
 * Ensures the observer controller exists on the slot.
 *
 * @param slot - Per-client observing slot
 * @returns The controller
 */
export function resolveObserver(slot: ObservingSlot): ObserverController {
  slot.c ??= createObserver(slot.w);
  return slot.c;
}

/**
 * Settles tracked handler promises for this slot.
 *
 * @param slot - Slot from `connect({ onWrite })`
 * @returns When every tracked promise has settled
 */
export function flushSlot(slot: ObservingSlot): Promise<void> {
  return slot.c?.flush() ?? Promise.resolve();
}

/** Metadata for one statement (or one batch slot) before unit/seq are assigned. */
export type WriteDraft = {
  readonly table: string | null;
  readonly op: WriteEvent["op"];
  readonly tenant: Readonly<Record<string, unknown>> | null;
  readonly settings: readonly string[];
  readonly durationMs: number;
  readonly tag?: string;
  readonly source: "client" | "raw";
  /** Omitted means the driver gave no command tag. */
  readonly rowCount?: number | null;
  /** Omitted means `unknown`. */
  readonly rowCountMode?: WriteEvent["rowCountMode"];
  /** Primary-key records. Omitted when this statement did not opt in. */
  readonly keys?: readonly ObserveKey[];
};

type Frame = {
  readonly depth: number;
  readonly name: string;
  /** Index into `writes` when this savepoint opened. */
  readonly writeStart: number;
  /** Index into `ordered` when this savepoint opened. */
  readonly orderedStart: number;
};

type Unit = {
  readonly id: string;
  writes: WriteEvent[];
  /** Surviving write + savepoint events in delivery order (outcome appended later). */
  ordered: Array<WriteEvent | SavepointEvent>;
  frames: Frame[];
  seq: number;
};

let unitSeq = 0;

/** Open units in start order so overflow drops the oldest. */
type Queue = {
  readonly id: string;
  unit: Unit;
};

/**
 * Builds a process-local opaque unit id.
 *
 * @returns A new unit id
 */
function nextUnitId(): string {
  unitSeq += 1;
  return `u${unitSeq.toString(36)}`;
}

/**
 * Creates the per-client observer controller for `onWrite`.
 *
 * @param onWrite - Low-level handler from `connect`
 * @returns Controller stored on the session
 */
export function createObserver(onWrite: OnWrite): ObserverController {
  return new ObserverController(onWrite);
}

/**
 * Per-client write observer: buffers per unit, delivers after commit/rollback,
 * tracks handler promises for `flush()`.
 */
export class ObserverController {
  private readonly onWrite: OnWriteExtras;
  private open: Unit | undefined;
  private readonly pending: Promise<unknown>[] = [];
  private readonly queue: Queue[] = [];
  private pendingEvents = 0;
  private readonly maxPending: number;

  /**
   * @param onWrite - Low-level handler (may carry writeObserver extras)
   */
  constructor(onWrite: OnWrite) {
    this.onWrite = onWrite as OnWriteExtras;
    this.maxPending =
      typeof this.onWrite.maxPending === "number" && this.onWrite.maxPending > 0
        ? this.onWrite.maxPending
        : DEFAULT_MAX_PENDING;
  }

  /**
   * Opens a unit when none is open (autocommit / standalone batch).
   *
   * Nested under an open `tx()` unit this is a no-op: writes join that unit.
   *
   * @returns The open unit id
   */
  ensureUnit(): string {
    if (this.open !== undefined) return this.open.id;
    this.open = this.makeUnit();
    return this.open.id;
  }

  private makeUnit(): Unit {
    this.evictIfNeeded(0);
    const unit: Unit = {
      id: nextUnitId(),
      writes: [],
      ordered: [],
      frames: [],
      seq: 0,
    };
    this.queue.push({ id: unit.id, unit });
    return unit;
  }

  private evictIfNeeded(incoming: number): void {
    while (this.pendingEvents + incoming > this.maxPending && this.queue.length > 0) {
      const oldest = this.queue[0];
      if (oldest === undefined) return;
      if (this.open?.id === oldest.id && this.queue.length === 1) return;
      this.queue.shift();
      const dropped = oldest.unit.ordered.length;
      this.pendingEvents = Math.max(0, this.pendingEvents - dropped);
      if (this.open?.id === oldest.id) this.open = undefined;
      this.reportOverflow(oldest.unit);
    }
  }

  private reportOverflow(unit: Unit): void {
    const event: OutcomeEvent = {
      type: "outcome",
      unit: unit.id,
      outcome: "rolled_back",
      writes: 0,
    };
    const err = overflowError();
    try {
      this.onWrite.onObserverError?.(err, event);
    } catch {
      // Isolation.
    }
  }

  /**
   * Transaction or savepoint phase shared with `hookm.onTransaction`.
   *
   * @param phase - start, commit, or rollback
   * @param depth - 0 for the transaction, 1+ for savepoints
   * @param name - Savepoint name when depth ≥ 1
   * @param opts - `unknown` when COMMIT was lost (OKM1401)
   */
  onPhase(
    phase: TransactionEvent["phase"],
    depth: number,
    name: string | undefined,
    opts?: { readonly unknown?: boolean },
  ): void {
    if (opts?.unknown === true) {
      this.finish("unknown");
      return;
    }
    if (depth === 0) {
      if (phase === "start") {
        this.open = this.makeUnit();
        return;
      }
      if (phase === "commit") {
        this.finish("committed");
        return;
      }
      this.finish("rolled_back");
      return;
    }
    const unit = this.open;
    if (unit === undefined) return;
    if (phase === "start") {
      unit.frames.push({
        depth,
        name: name ?? `okm_t${String(depth)}`,
        writeStart: unit.writes.length,
        orderedStart: unit.ordered.length,
      });
      return;
    }
    const frame = unit.frames.pop();
    if (frame === undefined) return;
    if (phase === "commit") {
      const event: SavepointEvent = {
        type: "savepoint",
        unit: unit.id,
        name: frame.name,
        state: "released",
        depth: frame.depth,
      };
      unit.ordered.push(event);
      return;
    }
    // Drop writes that lived only inside this savepoint.
    unit.writes.splice(frame.writeStart);
    unit.ordered.length = frame.orderedStart;
    const event: SavepointEvent = {
      type: "savepoint",
      unit: unit.id,
      name: frame.name,
      state: "rolled_back",
      depth: frame.depth,
    };
    unit.ordered.push(event);
  }

  /**
   * Records write drafts into the open unit (creates one when needed).
   *
   * @param drafts - One draft per statement, in send order
   */
  recordWrites(drafts: readonly WriteDraft[]): void {
    if (drafts.length === 0) return;
    this.ensureUnit();
    const unit = this.open;
    if (unit === undefined) return;
    this.evictIfNeeded(drafts.length);
    for (const draft of drafts) {
      const event: WriteEvent = {
        type: "write",
        unit: unit.id,
        seq: unit.seq,
        dialect: "postgres",
        table: draft.table,
        op: draft.op,
        rowCount: draft.rowCount ?? null,
        rowCountMode: draft.rowCountMode ?? "unknown",
        tenant: draft.tenant,
        settings: draft.settings,
        durationMs: draft.durationMs,
        source: draft.source,
        ...(draft.tag !== undefined ? { tag: draft.tag } : {}),
        ...(draft.keys !== undefined ? { keys: draft.keys } : {}),
      };
      unit.seq += 1;
      unit.writes.push(event);
      unit.ordered.push(event);
      this.pendingEvents += 1;
    }
  }

  /**
   * Ends an autocommit or standalone-batch unit that never saw `onPhase`.
   *
   * @param outcome - committed or rolled_back
   */
  endAutocommit(outcome: "committed" | "rolled_back"): void {
    this.finish(outcome);
  }

  /**
   * Resolves when every tracked handler promise has settled.
   *
   * Handler errors never reject this promise.
   *
   * @returns Settled when the queue is empty
   */
  flush(): Promise<void> {
    if (this.pending.length === 0) return Promise.resolve();
    const batch = this.pending.splice(0, this.pending.length);
    return Promise.all(batch.map((p) => p.catch(() => undefined))).then(() => undefined);
  }

  private finish(outcome: OutcomeEvent["outcome"]): void {
    const unit = this.open;
    this.open = undefined;
    if (unit === undefined) return;
    const index = this.queue.findIndex((entry) => entry.id === unit.id);
    if (index >= 0) this.queue.splice(index, 1);
    this.pendingEvents = Math.max(0, this.pendingEvents - unit.ordered.length);
    const writes = unit.writes.length;
    const outcomeEvent: OutcomeEvent = {
      type: "outcome",
      unit: unit.id,
      outcome,
      writes,
    };
    for (const event of unit.ordered) this.deliver(event);
    this.deliver(outcomeEvent);
  }

  private deliver(event: ObserveEvent): void {
    let result: void | Promise<void>;
    try {
      result = this.onWrite(event);
    } catch (err) {
      this.observerError(err, event);
      return;
    }
    if (result !== undefined && typeof (result as Promise<void>).then === "function") {
      const tracked = Promise.resolve(result).then(
        () => undefined,
        (err: unknown) => {
          this.observerError(err, event);
        },
      );
      this.pending.push(tracked);
    }
  }

  private observerError(err: unknown, event: ObserveEvent): void {
    if (event.type === "savepoint") return;
    try {
      this.onWrite.onObserverError?.(err, event);
    } catch {
      // Isolation.
    }
  }
}

function overflowError(): OkmError {
  return new OkmError(
    "OKM2200",
    "The write-observer buffer dropped the oldest unit because it exceeded the pending-event ceiling.",
    {
      kind: "driver",
      fix: {
        summary:
          "Drain handlers with flush() more often, or raise maxPending on writeObserver. The write path does not wait.",
      },
    },
  );
}

/**
 * One emission point for `hookm.onTransaction` and observer unit phases.
 *
 * @param host - Session hookm and optional observer
 * @param phase - start, commit, or rollback
 * @param depth - 0 for the transaction, 1+ for savepoints
 * @param name - Savepoint name when depth ≥ 1
 * @param opts - `unknown` for a lost COMMIT (no hookm final phase)
 */
export function emitPhase(
  host: ObserveHost,
  phase: TransactionEvent["phase"],
  depth: number,
  name?: string,
  opts?: { readonly unknown?: boolean },
): void {
  if (opts?.unknown !== true && host.hookm !== undefined) {
    const event: TransactionEvent = { phase, depth };
    for (const hook of host.hookm) {
      try {
        hook.onTransaction?.(event);
      } catch {
        // Observer cannot change what it observes.
      }
    }
  }
  host.observer?.onPhase(phase, depth, name, opts);
}
