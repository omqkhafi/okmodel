/**
 * Deadline and abort signal for one call.
 *
 * Loaded the first time a call passes `signal` or `timeout`. A plain execute
 * does not load it.
 */

import type { ExecuteOptions } from "../../contracts/driver.js";
import type { Watch } from "./call.js";

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
  options.signal?.addEventListener("abort", onAbort, { once: true });
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
      options.signal?.removeEventListener("abort", onAbort);
    },
    reason() {
      return kind;
    },
  };
}
