/**
 * Recording observers for the conformance tests (G-8). Loads `okmodel/observe`,
 * so a process that must not load it imports only the rig.
 */

import {
  queryObserver,
  writeObserver,
  type QueryObserver,
  type WriteObserver,
} from "../src/runtime/observe.js";
import type { ObserveEvent, QueryEvent, WriteEvent } from "../src/runtime/observe-types.js";

/** What one observer pair saw. */
export type Watch = {
  readonly onWrite: WriteObserver;
  readonly onQuery: QueryObserver;
  /** Every write observer event, in delivery order. */
  readonly events: ObserveEvent[];
  readonly queries: QueryEvent[];
  readonly committed: { readonly unit: string; readonly writes: readonly WriteEvent[] }[];
  readonly rolledBack: { readonly unit: string }[];
  readonly unknown: { readonly unit: string; readonly writes: readonly WriteEvent[] }[];
  /** What `onObserverError` received, from both observers. */
  readonly errors: unknown[];
  /** Settles both observers. */
  flush(): Promise<void>;
};

/**
 * One write observer and one query observer that record everything.
 *
 * @param options - Primary-key tables, parameter capture, and the pending ceiling
 * @returns The observers and what they recorded
 */
export function watch(
  options: {
    readonly keys?: readonly string[];
    readonly params?: boolean;
    readonly maxPending?: number;
  } = {},
): Watch {
  const events: ObserveEvent[] = [];
  const queries: QueryEvent[] = [];
  const committed: Watch["committed"][number][] = [];
  const rolledBack: Watch["rolledBack"][number][] = [];
  const unknown: Watch["unknown"][number][] = [];
  const errors: unknown[] = [];
  const onWrite = writeObserver({
    ...(options.keys !== undefined ? { keys: options.keys } : {}),
    ...(options.maxPending !== undefined ? { maxPending: options.maxPending } : {}),
    onEvent: (event) => void events.push(event),
    committed: (unit) => void committed.push(unit),
    rolledBack: (unit) => void rolledBack.push(unit),
    unknown: (unit) => void unknown.push(unit),
    onObserverError: (error) => void errors.push(error),
  });
  const onQuery = queryObserver({
    query: (event) => void queries.push(event),
    ...(options.params === true ? { params: true } : {}),
    onObserverError: (error) => void errors.push(error),
  });
  return {
    onWrite,
    onQuery,
    events,
    queries,
    committed,
    rolledBack,
    unknown,
    errors,
    async flush() {
      await onWrite.flush();
      await onQuery.flush();
    },
  };
}
