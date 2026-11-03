/**
 * Date and time codecs a client loads when it connects (D321).
 *
 * ISO decode, `Date`, and Temporal. `time.ts` keeps only the ISO encode a
 * literal default needs, so a graph that never queries does not carry these.
 */

import { rejected } from "./misuse.js";
import { decodeTemporal, encodeTemporal } from "./temporal.js";
import type { TimeKind, TimeMode, TimePrecision } from "./time.js";

/**
 * Encodes a `Date` or a Temporal value.
 *
 * A `Date` is written as UTC. `timestamp` drops the `Z` and `date` keeps the
 * UTC day. A value of another type is refused, not converted.
 *
 * @param kind - Column type
 * @param mode - `date` or `temporal`
 * @param value - Application value
 * @param digits - Fractional digits for Temporal, or full precision
 * @returns Wire text
 */
export function encodeTime(
  kind: TimeKind,
  mode: TimeMode,
  value: unknown,
  digits: TimePrecision | undefined,
): string {
  if (mode === "temporal") return encodeTemporal(kind, value, digits);
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    rejected(`${kind} ${String(value)} must be a valid Date.`);
  }
  const text = value.toISOString();
  return kind === "date" ? text.slice(0, 10) : kind === "timestamp" ? text.slice(0, -1) : text;
}

/**
 * Decodes wire text in one mode.
 *
 * @param kind - Column type
 * @param mode - Column mode
 * @param wire - Text from Postgres or from `to_char`
 * @returns ISO text, a `Date`, or a Temporal value
 */
export function decodeTime(kind: TimeKind, mode: TimeMode, wire: string): unknown {
  if (mode === "temporal") return decodeTemporal(kind, wire);
  if (kind === "timestamptz") {
    const text = instantText(wire);
    return mode === "date" ? new Date(text) : text;
  }
  if (kind === "date") return mode === "date" ? new Date(wire) : wire;
  const text = localText(wire);
  return mode === "date" ? new Date(`${text}Z`) : text;
}

/**
 * ISO text of a timestamp or a time of day: `T` between date and time, and
 * six fractional digits. Text it does not recognise is returned as sent.
 *
 * @param wire - Text from Postgres or from `to_char`
 * @returns `2026-11-03T09:00:53.582634` or `09:00:53.582634`
 */
export function localText(wire: string): string {
  const match = /^(.*\d:\d\d)(?:\.(\d+))?$/.exec(wire.replace(" ", "T"));
  return match === null ? wire : `${match[1] ?? ""}.${(match[2] ?? "").padEnd(6, "0")}`;
}

/**
 * ISO text of an instant in UTC: `2026-11-03T09:00:53.582634Z`.
 *
 * Postgres sends `2026-11-03 09:00:53.582634+00`. Another offset is moved to
 * UTC and the microseconds are kept. `infinity` and BC dates come back as sent.
 *
 * @param wire - Text from Postgres or from `to_char`
 * @returns ISO-8601 instant text
 */
export function instantText(wire: string): string {
  const match = /^(.+?)(Z|[+-][\d:]+)$/.exec(wire);
  if (match === null) return wire;
  const local = localText(match[1] ?? "");
  const zone = match[2] ?? "";
  if (/^(Z|[+-]00(:00)*)$/.test(zone)) return `${local}Z`;
  const at = Date.parse(`${local.slice(0, 19)}${zone.length === 3 ? `${zone}:00` : zone}`);
  return Number.isNaN(at) ? wire : `${new Date(at).toISOString().slice(0, 19)}${local.slice(19)}Z`;
}
