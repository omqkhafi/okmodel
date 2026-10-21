/**
 * Write observers (`okmodel/observe`).
 *
 * Lazy entry. Builds on the executor emission in `observe-emit.ts`. Does not
 * enter the runtime entry. See `docs/observer-events.md`.
 */

import { OkmError } from "../contracts/error.js";
import { observeTagOk } from "./observe-emit.js";
import type {
  ObserveEvent,
  OnQuery,
  OnWrite,
  OutcomeEvent,
  QueryEvent,
  SavepointEvent,
  WriteEvent,
} from "./observe-types.js";

const OTEL_SYSTEM = "postgresql";
const OTEL_NAMESPACE = "public";

export type {
  ObserveDialect,
  ObserveEvent,
  ObserveKey,
  OnQuery,
  OnWrite,
  OutcomeEvent,
  QueryError,
  QueryEvent,
  QueryLimit,
  QueryRoute,
  RowCountMode,
  SavepointEvent,
  WriteEvent,
} from "./observe-types.js";

/** Default pending-event ceiling per client (G-0 delivery rule 9). */
export const OBSERVE_BUFFER_MAX = 10_000;

/** Options for {@link writeObserver}. */
export type WriteObserverOptions = {
  /**
   * Tables whose primary key is returned on each write.
   *
   * Names are schema table names. A table with no primary key is OKM1890.
   * The values land on `WriteEvent.keys`.
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
  /**
   * Copied onto each write event.
   *
   * 1–64 characters from `[A-Za-z0-9_.:/-]`.
   */
  readonly tag?: string;
};

/** What {@link writeObserver} returns: a connect `onWrite` handler with `flush`. */
export type WriteObserver = OnWrite & {
  /** Settles tracked handler promises for this observer. Never rejects on handler errors. */
  flush(): Promise<void>;
  /** @internal Ceiling and error hook the emitter reads from the function object. */
  readonly maxPending: number;
  /** @internal */
  onObserverError?: WriteObserverOptions["onObserverError"];
  /**
   * Copied onto each write when set.
   *
   * 1–64 characters from `[A-Za-z0-9_.:/-]`.
   */
  readonly tag?: string;
  /**
   * Tables copied from {@link WriteObserverOptions.keys}.
   *
   * The connect path and the write planner read this off the handler.
   */
  readonly observeKeys?: readonly string[];
};

/**
 * Buffers low-level events and calls exactly one of `committed` | `rolledBack` |
 * `unknown` per unit. A unit with zero surviving writes calls nothing.
 *
 * @param options - Callbacks and an optional primary-key table list
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
      ...(options.keys !== undefined && options.keys.length > 0
        ? { observeKeys: options.keys.slice() }
        : {}),
      ...(options.tag !== undefined ? { tag: checkedTag(options.tag) } : {}),
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

/** Options for {@link queryObserver}. */
export type QueryObserverOptions = {
  /** Called once per statement, after it settles. */
  readonly query: (event: QueryEvent) => void | Promise<void>;
  /**
   * Include bound parameters on the event.
   *
   * Sensitive columns, hidden columns, and tenant keys are `"[redacted]"`.
   */
  readonly params?: boolean;
  /** Include a stack trace on the event. */
  readonly stack?: boolean;
  /**
   * Copied onto each query event.
   *
   * 1–64 characters from `[A-Za-z0-9_.:/-]`.
   */
  readonly tag?: string;
  /** A throwing or rejecting handler, or a buffer overflow (OKM2200). */
  readonly onObserverError?: (err: unknown, event: QueryEvent) => void;
  /** Pending-promise ceiling. Defaults to {@link OBSERVE_BUFFER_MAX}. */
  readonly maxPending?: number;
};

/** What {@link queryObserver} returns: a connect `onQuery` handler with `flush`. */
export type QueryObserver = OnQuery & {
  /** Settles tracked handler promises for this observer. Never rejects on handler errors. */
  flush(): Promise<void>;
  /** @internal Ceiling the query controller reads from the function object. */
  readonly maxPending: number;
  /** @internal */
  onObserverError?: QueryObserverOptions["onObserverError"];
  /** @internal Set when {@link QueryObserverOptions.params} is true. */
  readonly observeParams?: boolean;
  /** @internal Set when {@link QueryObserverOptions.stack} is true. */
  readonly observeStack?: boolean;
  /** @internal Copied onto each event when it matches the tag grammar. */
  readonly tag?: string;
};

/**
 * One query event, with the same attribute names `okmodel/otel` writes.
 *
 * `db.query.text` is included only when `statement` is true. Parameters,
 * tenant ids, and stacks are never attributes. This does not import
 * OpenTelemetry.
 */
export type OtelQuery = {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
};

/**
 * Buffers one event per statement. A throwing or rejecting `query` is reported
 * to `onObserverError` and cannot change the statement result.
 *
 * @param options - Callback, and optional params, stack, and tag
 * @returns Handler for `connect({ onQuery })`
 */
export function queryObserver(options: QueryObserverOptions): QueryObserver {
  let observer!: QueryObserver;
  observer = Object.assign((event: QueryEvent): void | Promise<void> => options.query(event), {
    maxPending: options.maxPending ?? OBSERVE_BUFFER_MAX,
    ...(options.onObserverError !== undefined ? { onObserverError: options.onObserverError } : {}),
    ...(options.params === true ? { observeParams: true as const } : {}),
    ...(options.stack === true ? { observeStack: true as const } : {}),
    ...(options.tag !== undefined ? { tag: checkedTag(options.tag) } : {}),
    flush(): Promise<void> {
      return import("./observe-query.js").then((mod) => mod.flushQuery(observer));
    },
  });
  return observer;
}

/**
 * Maps one query event to a span name and attributes.
 *
 * The names match `okmodel/otel`: `db.system.name`, `db.namespace`,
 * `db.collection.name`, `db.operation.name`, `db.query.summary`, and
 * `error.type`. A failure also sets `db.response.status_code` to the SQLSTATE.
 * `db.query.summary` is the fingerprint. The span name is the low-cardinality
 * summary (`SELECT tasks`).
 *
 * @param event - One settled statement
 * @param options - `statement: true` copies sanitised statement text
 * @returns The span name and attributes. No OpenTelemetry import
 */
export function toOtel(event: QueryEvent, options?: { readonly statement?: boolean }): OtelQuery {
  const attributes: Record<string, string> = {
    "db.system.name": OTEL_SYSTEM,
    "db.namespace": OTEL_NAMESPACE,
    "db.collection.name": event.table ?? "",
    "db.operation.name": event.op,
    "db.query.summary": event.fingerprint,
  };
  if (options?.statement === true) attributes["db.query.text"] = event.text;
  if (event.error !== undefined) {
    attributes["error.type"] = event.error.kind;
    if (event.error.sqlstate !== undefined) {
      attributes["db.response.status_code"] = event.error.sqlstate;
    }
  }
  return { name: event.summary, attributes };
}

/**
 * Accepts a tag or throws `invalid`.
 *
 * @param value - Caller tag
 * @returns The same string when it matches the grammar
 */
function checkedTag(value: string): string {
  if (!observeTagOk(value)) {
    throw new OkmError("invalid", "tag must be 1–64 characters from [A-Za-z0-9_.:/-].", {
      kind: "invalid",
      fix: { summary: "Use a short tag such as api.request." },
    });
  }
  return value;
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
