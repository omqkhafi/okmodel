/**
 * Server-side read cursor.
 *
 * Loaded the first time `.stream()` is iterated. A find that is only awaited
 * does not load it.
 */

import type { DriverPool, WireValue } from "../contracts/driver.js";
import { OkmError, type ErrorStatuses } from "../contracts/error.js";
import { withHttp } from "./client.js";
import { decodeResult, type Plan, type ReadCall } from "./plan.js";

/**
 * Yields decoded rows from the driver's stream.
 *
 * @param session - Connected pool and HTTP statuses
 * @param call - The read being streamed
 * @param prepare - Compiles the statement on first use
 * @param log - Attaches the session logger and returns the error
 * @returns One row at a time
 */
export async function* streamRows(
  session: {
    readonly connected: Promise<void>;
    readonly pool: DriverPool;
    readonly http: ErrorStatuses | undefined;
  },
  call: ReadCall,
  prepare: () => Promise<{ readonly plan: Plan; readonly params: readonly (string | null)[] }>,
  log: (error: OkmError) => OkmError,
): AsyncIterable<unknown> {
  await session.connected;
  if (session.pool.capabilities.stream !== true || session.pool.stream === undefined) {
    throw log(
      new OkmError(
        "OKM1111",
        "stream needs a driver with stream: true. This driver does not have it.",
        withHttp(session.http, {
          fix: { summary: "Use a driver that sets stream, or read with find." },
        }),
      ),
    );
  }
  const { plan, params } = await prepare();
  const decode =
    plan.outputs.includes.length === 0
      ? decodeResult
      : (await import("./include.js")).decodeIncluded;
  for await (const chunk of session.pool.stream(plan.text, params as readonly WireValue[])) {
    const decoded = decode(plan, chunk, call.table);
    if (!Array.isArray(decoded)) continue;
    for (const row of decoded) yield row;
  }
}
