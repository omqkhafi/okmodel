/**
 * Write observers (`okmodel/observe`).
 *
 * Lazy entry. Builds on the executor emission in `observe-emit.ts`. Does not
 * enter the runtime entry. See `docs/observer-events.md`.
 */

import { OkmError } from "../contracts/error.js";
import type {
  ObserveEvent,
  OnWrite,
  OutcomeEvent,
  SavepointEvent,
  WriteEvent,
} from "./observe-types.js";

export type {
  ObserveDialect,
  ObserveEvent,
  ObserveKey,
  OnWrite,
  OutcomeEvent,
  RowCountMode,
  SavepointEvent,
  WriteEvent,
} from "./observe-types.js";

/** Default pending-event ceiling per client (G-0 delivery rule 9). */
export const OBSERVE_BUFFER_MAX = 10_000;

/** Options for {@link writeObserver}. */
export type WriteObserverOptions = {
  /**
   * Key columns to capture (G-5).
   *
   * Accepted and ignored until G-5 fills `WriteEvent.keys`.
   */
  readonly keys?: readonly string[];
  /** Surviving writes after a committed unit. */
  readonly committed?: (u: {
    readonly unit: string;
    readonly writes: readonly WriteEvent[];
  }) => void | Promise<void>;
  /** A unit that rolled back and had surviving writes before the outcome. */
  readonly rolledBack?: (u: { readonly unit: string }) => void | Promise<void>;
  /** COMMIT sent and the connection was lost (`outcome_unknown`). */
  readonly unknown?: (u: {
    readonly unit: string;
    readonly writes: readonly WriteEvent[];
  }) => void | Promise<void>;
  /** A throwing or rejecting handler, or a buffer overflow (OKM2200). */
  readonly onObserverError?: (
    err: unknown,
    event: WriteEvent | OutcomeEvent | SavepointEvent,
  ) => void;
  /** Low-level stream for tooling. */
  readonly onEvent?: (e: ObserveEvent) => void | Promise<void>;
  /** Pending-event ceiling. Defaults to {@link OBSERVE_BUFFER_MAX}. */
  readonly maxPending?: number;
};

/** What {@link writeObserver} returns: a connect `onWrite` handler with `flush`. */
export type WriteObserver = OnWrite & {
  /** Settles tracked handler promises for this observer. Never rejects on handler errors. */
  flush(): Promise<void>;
  /** @internal Ceiling and error hook the emitter reads from the function object. */
  readonly maxPending: number;
  /** @internal */
  onObserverError?: WriteObserverOptions["onObserverError"];
};

/**
 * Buffers low-level events and calls exactly one of `committed` | `rolledBack` |
 * `unknown` per unit. A unit with zero surviving writes calls nothing.
 *
 * @param options - Callbacks and optional key list (ignored until G-5)
 * @returns Handler for `connect({ onWrite })`
 */
export function writeObserver(options: WriteObserverOptions = {}): WriteObserver {
  const units = new Map<string, WriteEvent[]>();
  const pending: Promise<unknown>[] = [];
  const maxPending = options.maxPending ?? OBSERVE_BUFFER_MAX;

  const track = (result: void | Promise<void>, event: ObserveEvent): void => {
    if (result === undefined || typeof (result as Promise<void>).then !== "function") return;
    const tracked = Promise.resolve(result).then(
      () => undefined,
      (err: unknown) => {
        if (event.type === "savepoint") return;
        try {
          options.onObserverError?.(err, event);
        } catch {
          // Isolation: onObserverError must not affect the write path.
        }
      },
    );
    pending.push(tracked);
  };

  const call = (
    fn: (() => void | Promise<void>) | undefined,
    event: WriteEvent | OutcomeEvent,
  ): void => {
    if (fn === undefined) return;
    let result: void | Promise<void>;
    try {
      result = fn();
    } catch (err) {
      try {
        options.onObserverError?.(err, event);
      } catch {
        // Isolation.
      }
      return;
    }
    track(result, event);
  };

  const onWrite: WriteObserver = Object.assign(
    (event: ObserveEvent): void => {
      let low: void | Promise<void>;
      try {
        low = options.onEvent?.(event);
      } catch (err) {
        if (event.type !== "savepoint") {
          try {
            options.onObserverError?.(err, event);
          } catch {
            // Isolation.
          }
        }
        low = undefined;
      }
      if (low !== undefined) track(low, event);

      if (event.type === "write") {
        let list = units.get(event.unit);
        if (list === undefined) {
          list = [];
          units.set(event.unit, list);
        }
        list.push(event);
        return;
      }
      if (event.type === "savepoint") return;
      const writes = units.get(event.unit) ?? [];
      units.delete(event.unit);
      if (writes.length === 0) return;
      if (event.outcome === "committed") {
        call(() => options.committed?.({ unit: event.unit, writes }), event);
        return;
      }
      if (event.outcome === "unknown") {
        call(() => options.unknown?.({ unit: event.unit, writes }), event);
        return;
      }
      call(() => options.rolledBack?.({ unit: event.unit }), event);
    },
    {
      maxPending,
      onObserverError: options.onObserverError,
      flush(): Promise<void> {
        if (pending.length === 0) return Promise.resolve();
        const batch = pending.splice(0, pending.length);
        return Promise.all(batch.map((p) => p.catch(() => undefined))).then(() => undefined);
      },
    },
  );

  return onWrite;
}

/**
 * Settles tracked handler promises for a {@link WriteObserver}.
 *
 * Prefer `observer.flush()` on the value returned by {@link writeObserver}.
 *
 * @param observer - Handler from {@link writeObserver}
 * @returns When every tracked promise has settled
 */
export function flush(observer: WriteObserver): Promise<void> {
  return observer.flush();
}

/**
 * Builds the OKM2200 warning used when the per-client event buffer overflows.
 *
 * @returns The operations warning
 */
export function observerBufferOverflow(): OkmError {
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
