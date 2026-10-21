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
  /** The transaction or write the phase belongs to. See {@link txScope}. */
  readonly scope?: object | undefined;
};

/**
 * The object that names a transaction's unit.
 *
 * Every client a `tx()` hands out, at any savepoint depth, carries the same
 * state object, so concurrent units on one client never share a unit.
 *
 * @param tx - `Session.tx` or `RunHost.tx`
 * @returns The transaction state, or `undefined` outside a transaction
 */
export function txScope(tx: object | undefined): object | undefined {
  return (tx as { state?: object } | undefined)?.state;
}

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
  readonly scope: object;
  writes: WriteEvent[];
  /** Surviving write + savepoint events in delivery order (outcome appended later). */
  ordered: Array<WriteEvent | SavepointEvent>;
  frames: Frame[];
  seq: number;
  /** Sequence for query events that share this unit. */
  querySeq: number;
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
  private readonly units = new WeakMap<object, Unit>();
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
   * Opens the scope's unit when it has none (autocommit / standalone batch).
   *
   * Inside a `tx()` the scope is the transaction's and its unit already exists.
   *
   * @param scope - The transaction, or the autocommit write
   * @returns The scope's unit id
   */
  ensureUnit(scope: object): string {
    return this.unitOf(scope).id;
  }

  private unitOf(scope: object): Unit {
    let unit = this.units.get(scope);
    if (unit === undefined) {
      unit = this.makeUnit(scope);
      this.units.set(scope, unit);
    }
    return unit;
  }

  /**
   * The scope's next query sequence, when it has a unit.
   *
   * Does not open a unit. A read outside a transaction gets no unit.
   *
   * @param scope - The transaction or autocommit write the statement runs in
   * @returns Unit id and sequence, or `undefined` when the scope has no unit
   */
  nextQueryPlace(
    scope: object | undefined,
  ): { readonly unit: string; readonly seq: number } | undefined {
    const unit = scope === undefined ? undefined : this.units.get(scope);
    if (unit === undefined) return undefined;
    const seq = unit.querySeq;
    unit.querySeq += 1;
    return { unit: unit.id, seq };
  }

  /**
   * Tag copied onto events when the handler carries a valid one.
   *
   * @returns The tag, or `undefined` when the handler has none
   */
  observeTag(): string | undefined {
    const value = (this.onWrite as { tag?: unknown }).tag;
    return typeof value === "string" && observeTagOk(value) ? value : undefined;
  }

  private makeUnit(scope: object): Unit {
    this.evictIfNeeded(0);
    const unit: Unit = {
      id: nextUnitId(),
      scope,
      writes: [],
      ordered: [],
      frames: [],
      seq: 0,
      querySeq: 0,
    };
    this.queue.push({ id: unit.id, unit });
    return unit;
  }

  private evictIfNeeded(incoming: number): void {
    while (this.pendingEvents + incoming > this.maxPending && this.queue.length > 0) {
      const oldest = this.queue[0];
      if (oldest === undefined) return;
      if (this.units.get(oldest.unit.scope) === oldest.unit && this.queue.length === 1) return;
      this.queue.shift();
      const dropped = oldest.unit.ordered.length;
      this.pendingEvents = Math.max(0, this.pendingEvents - dropped);
      if (this.units.get(oldest.unit.scope) === oldest.unit) this.units.delete(oldest.unit.scope);
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
   * @param scope - The transaction or batch the phase belongs to
   * @param phase - start, commit, or rollback
   * @param depth - 0 for the transaction, 1+ for savepoints
   * @param name - Savepoint name when depth ≥ 1
   * @param opts - `unknown` when COMMIT was lost (OKM1401)
   */
  onPhase(
    scope: object,
    phase: TransactionEvent["phase"],
    depth: number,
    name: string | undefined,
    opts?: { readonly unknown?: boolean },
  ): void {
    if (opts?.unknown === true) {
      this.finish(scope, "unknown");
      return;
    }
    if (depth === 0) {
      if (phase === "start") {
        this.units.set(scope, this.makeUnit(scope));
        return;
      }
      this.finish(scope, phase === "commit" ? "committed" : "rolled_back");
      return;
    }
    const unit = this.units.get(scope);
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
   * Records write drafts into the scope's unit (creates one when needed).
   *
   * @param scope - The transaction or autocommit write the statements ran in
   * @param drafts - One draft per statement, in send order
   */
  recordWrites(scope: object, drafts: readonly WriteDraft[]): void {
    if (drafts.length === 0) return;
    this.evictIfNeeded(drafts.length);
    const unit = this.unitOf(scope);
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
   * @param scope - The autocommit write
   * @param outcome - committed or rolled_back
   */
  endAutocommit(scope: object, outcome: "committed" | "rolled_back"): void {
    this.finish(scope, outcome);
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

  private finish(scope: object, outcome: OutcomeEvent["outcome"]): void {
    const unit = this.units.get(scope);
    this.units.delete(scope);
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

const TAG_TEXT = /^[A-Za-z0-9_.:/-]{1,64}$/;

/**
 * Whether `value` is a tag the contract accepts.
 *
 * @param value - Handler tag
 * @returns True when it is 1–64 characters from the allowed set
 */
export function observeTagOk(value: string): boolean {
  return TAG_TEXT.test(value);
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
  if (host.scope !== undefined) host.observer?.onPhase(host.scope, phase, depth, name, opts);
}
