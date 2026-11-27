/**
 * Placeholder for a generated expression held until the catalog is sealed.
 *
 * The token is `#` plus U+E000 plus the decimal index. An author expression
 * does not contain that character, so a written `#0` is not a held slot.
 */

const PREFIX = "#\uE000";

/**
 * The token stored in place of a held expression.
 *
 * @param index - Slot in the hold list
 * @returns The placeholder
 */
export function heldToken(index: number): string {
  return `${PREFIX}${index}`;
}

/**
 * The slot a held token names.
 *
 * @param text - Expression text
 * @returns The slot index, or `undefined` when the text is not a held token
 */
export function heldIndex(text: string): number | undefined {
  if (!text.startsWith(PREFIX)) return undefined;
  const rest = text.slice(PREFIX.length);
  if (rest.length === 0 || !/^\d+$/.test(rest)) return undefined;
  const index = Number(rest);
  return Number.isSafeInteger(index) ? index : undefined;
}
