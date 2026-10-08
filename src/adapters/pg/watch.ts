/**
 * Deadline and abort signal for one call.
 *
 * Loaded the first time a call passes `signal` or `timeout`. A plain execute
 * does not load it.
 */

import type { ExecuteOptions } from "../../contracts/driver.js";
import type { Watch } from "./call.js";

/**
 * Abort callbacks for each caller signal (QA-L8).
 *
 * Every call that passes the same signal shares one listener on it. The
 * listener calls each registered callback, so 200 parallel calls add one
 * listener to the signal, not 200.
 */
const callers = new WeakMap<AbortSignal, Set<() => void>>();

/**
 * Registers `onAbort` on the caller's signal through the shared listener.
 *
 * @param signal - The caller's signal
 * @param onAbort - Called once when the signal aborts, if still registered
 * @returns Removes the registration. Call it when the call finishes
 */
function listenOn(signal: AbortSignal, onAbort: () => void): () => void {
  let set = callers.get(signal);
  if (set === undefined) {
    const created = new Set<() => void>();
    callers.set(signal, created);
    signal.addEventListener(
      "abort",
      () => {
        for (const each of created) each();
      },
      { once: true },
    );
    set = created;
  }
  const registered = set;
  registered.add(onAbort);
  return () => {
    registered.delete(onAbort);
  };
}

/**
 * Opens a watch for one call.
 *
 * The caller has already rejected a pre-aborted signal and a non-positive
 * timeout.
 *
 * @param options - Options that include a signal or a timeout
 * @returns The watch. The caller must {@link Watch.finish} it
 */
export function openWatch(options: ExecuteOptions): Watch {
  let kind: "timeout" | "cancelled" | "outcome_unknown" | undefined;
  const controller = new AbortController();
  const onAbort = (): void => {
    if (kind === undefined) kind = "cancelled";
    controller.abort();
  };
  const release = options.signal === undefined ? undefined : listenOn(options.signal, onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout !== undefined) {
    timer = setTimeout(() => {
      if (kind === undefined) kind = "timeout";
      controller.abort();
    }, options.timeout);
  }
  return {
    signal: controller.signal,
    finish() {
      if (timer !== undefined) clearTimeout(timer);
      release?.();
    },
    reason() {
      return kind;
    },
  };
}
