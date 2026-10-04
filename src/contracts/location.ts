/**
 * Authoring location for provenance.
 *
 * `source` is recorded when a table or a rule is defined. The catalog hash
 * does not include it.
 */

/**
 * File and line of the caller `skip` frames above this function.
 *
 * Frames in this file are ignored. `skip` 1 is the direct caller, so a
 * `table()` call records the schema line, not `table` itself.
 *
 * @param skip - Callers to pass before the frame that is recorded
 * @returns `file.ts:line`, or `undefined` when the runtime has no stack
 */
export function callerLocation(skip: number): string | undefined {
  const lines = new Error().stack?.split("\n");
  if (lines === undefined) return undefined;
  let left = skip;
  for (const line of lines) {
    const slash = line.lastIndexOf("/");
    if (slash < 0) continue;
    const tail = line.slice(slash + 1);
    const colon = tail.indexOf(":");
    if (colon < 1 || tail.startsWith("location.")) continue;
    if (left > 0) {
      left -= 1;
      continue;
    }
    const end = tail.indexOf(":", colon + 1);
    if (end < 0) return undefined;
    return `${tail.slice(0, colon)}:${tail.slice(colon + 1, end)}`;
  }
  return undefined;
}

/**
 * Appends a source location to an error message.
 *
 * @param message - What failed
 * @param source - `file.ts:line`, when one was recorded
 * @returns The message `okm` prints
 */
export function withLocation(message: string, source: string | undefined): string {
  return source === undefined ? message : `${message} (${source})`;
}
