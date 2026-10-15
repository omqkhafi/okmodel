/**
 * PGlite wire codecs, loaded from {@link import("./pglite.ts").open}.
 *
 * A JS number, bigint, or boolean is sent as wire text. An `08P01` from a
 * bad parameter is a driver error. A lost connection stays `unavailable`.
 */

import { mapFailure } from "../failure.js";

const OIDS = [
  16, 17, 20, 21, 23, 25, 114, 700, 701, 1043, 1082, 1114, 1184, 1700, 2950, 3802, 1000, 1005, 1007,
  1009, 1016, 1115, 1182, 1185, 1231, 199, 3807,
] as const;

/**
 * Leaves a parsed value as wire text.
 *
 * @param value - Wire text
 * @returns The same text. The dialect owns parsing
 */
function identity(value: string): string {
  return value;
}

/**
 * Sends a bound value as wire text.
 *
 * A number or bigint becomes its decimal spelling. A boolean becomes `t` or
 * `f`. Anything else is returned as the driver received it.
 *
 * @param value - Bound parameter
 * @returns Wire text
 */
function serialize(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "t" : "f";
  return value as string;
}

const parsers: Record<number, (value: string) => string> = {};
const serializers: Record<number, (value: unknown) => string> = {};
for (const oid of OIDS) {
  parsers[oid] = identity;
  serializers[oid] = serialize;
}

/** Identity parsers. The dialect owns parsing. */
export { parsers };

/** Wire-text serializers. Number, bigint, and boolean are text. */
export { serializers };

/**
 * Maps a PGlite failure.
 *
 * `08P01` means the parameter did not fit the protocol message. The
 * replacement carries the message and neither a SQLSTATE nor a cause, so the
 * kind is `driver`. Any other failure, including a closed connection, is
 * mapped unchanged.
 *
 * @param error - Caught value
 * @returns A normalised driver error
 */
export function fail(error: unknown): Promise<unknown> {
  return mapFailure(protocol(error));
}

function protocol(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return error;
  if (error.code !== "08P01") return error;
  const message = error instanceof Error ? error.message : "";
  return new Error(message.length > 0 ? message : "protocol error");
}
