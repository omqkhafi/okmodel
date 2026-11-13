/**
 * Failure and timeout settlement for the shared wire session.
 *
 * Loaded when a call throws, or when the caller passed `signal` or `timeout`.
 * A plain successful statement does not load it. The abort listener stays on
 * the session so it is registered in the same turn the call starts.
 */

import type { ExecuteResult } from "../../contracts/driver.js";
import { driverErrors } from "../failure.js";
import type { Watch } from "./call.js";
import { resultFrom } from "./result.js";
import type { NoticeBuffer } from "./session.js";

/** What {@link settleWatched} needs from the session that sent the statement. */
type WatchedQuery = {
  leave(): void;
  untrack(): void;
  note(): void;
  readonly notices: NoticeBuffer;
  readonly start: number;
  readonly text: string;
};

/**
 * Settles a statement after its abort listener is already attached.
 *
 * A timeout or cancel wins over a result that arrives later.
 *
 * @param pending - The driver query
 * @param watch - Abort signal and the reason it fired
 * @param onAbort - Listener the session attached
 * @param ctx - Notice slice and the session counters the plain path also uses
 * @returns The wire result, or a rejected driver error
 */
export function settleWatched(
  pending: Promise<unknown>,
  watch: Watch,
  onAbort: () => void,
  ctx: WatchedQuery,
): Promise<ExecuteResult> {
  const finish = (): void => {
    ctx.leave();
    ctx.untrack();
    watch.signal.removeEventListener("abort", onAbort);
  };
  return pending.then(
    (result) => {
      finish();
      const why = watch.reason();
      if (why === "timeout" || why === "cancelled") return classify(why, watch);
      ctx.note();
      return resultFrom(result, ctx.notices.since(ctx.start));
    },
    (error: unknown) => {
      finish();
      return classify(stampQuery(error, ctx.text), watch);
    },
  );
}

/**
 * Maps a driver rejection from a call that had no signal and no timeout.
 *
 * Bun.sql closed-socket text is stamped here. That text loads with this
 * module, so a connect entry does not carry it.
 *
 * @param error - Caught value
 * @param text - Statement text, recorded on the error when it has no query
 * @returns A rejected driver error
 */
export function rejectMapped(error: unknown, text: string): Promise<never> {
  return driverErrors().then(async (errors) => {
    const { closedSocketError } = await import("./bun-closed.js");
    throw errors.mapDriverError(stampQuery(closedSocketError(error), text));
  });
}

function stampQuery(error: unknown, text: string): unknown {
  if (typeof error === "object" && error !== null && !("query" in error))
    Reflect.set(error, "query", text);
  return error;
}

async function classify(error: unknown, watch: Watch): Promise<never> {
  const errors = await driverErrors();
  if (typeof error === "string") {
    if (error === "timeout") throw errors.timedOut();
    throw errors.cancelled();
  }
  const { closedSocketError } = await import("./bun-closed.js");
  const stamped = closedSocketError(error);
  if (stamped instanceof errors.DriverError) throw stamped;
  const why = watch.reason();
  if (why === "timeout") throw errors.timedOut(error);
  const code = errors.errorField(stamped, "code") ?? errors.errorField(stamped, "errno");
  if (why === "cancelled" || code === "57014") throw errors.cancelled(error);
  throw errors.mapDriverError(stamped);
}
