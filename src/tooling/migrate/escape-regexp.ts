/**
 * Escapes a string for use inside a RegExp character class or pattern.
 *
 * @param value - Literal text
 * @returns Escaped text
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
