/**
 * `keep` on `watch.feed`.
 *
 * A number is milliseconds. A string is a count and a unit: `ms`, `s`, `m`, `h`, or `d`.
 */

const KEEP = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/**
 * Parses a feed retention duration.
 *
 * @param value - The `keep` option
 * @returns The canonical text and the length in milliseconds, or `undefined`
 */
export function parseKeep(
  value: unknown,
): { readonly text: string; readonly ms: number } | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return { text: `${String(value)}ms`, ms: value };
  }
  if (typeof value !== "string") return undefined;
  const match = KEEP.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2];
  const ms =
    unit === "ms"
      ? amount
      : unit === "s"
        ? amount * 1_000
        : unit === "m"
          ? amount * 60_000
          : unit === "h"
            ? amount * 3_600_000
            : amount * 86_400_000;
  return { text: `${match[1] ?? ""}${unit ?? ""}`, ms };
}
