/**
 * Server-side cursor for drivers that stream through a checked-out connection.
 *
 * Loaded with the stream chunk. A read does not import this.
 */

import type { ExecuteResult, WireValue } from "../../contracts/driver.js";

/**
 * Yields cursor chunks from one connection that is already checked out.
 *
 * The cursor is session-local. `ROLLBACK` in the end drops it.
 *
 * @param run - Executes on the checked-out connection
 * @param text - Query to stream
 * @param params - Wire parameters
 * @returns Chunks of wire rows
 */
export async function* cursorStream(
  run: (text: string, params?: readonly WireValue[]) => Promise<ExecuteResult>,
  text: string,
  params: readonly WireValue[] | undefined,
): AsyncIterable<readonly (readonly WireValue[])[]> {
  const name = "okm_stream";
  await run("BEGIN");
  try {
    await run(`DECLARE ${name} NO SCROLL CURSOR FOR ${text}`, params);
    for (;;) {
      const chunk = await run(`FETCH 64 FROM ${name}`);
      if (chunk.rows.length === 0) break;
      yield chunk.rows;
    }
  } finally {
    await run("ROLLBACK").catch(() => undefined);
  }
}
