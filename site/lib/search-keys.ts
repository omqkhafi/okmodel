/**
 * Keyboard actions for the search dialog. Kept pure so a test can cover
 * arrows, enter, and escape without a browser.
 */

/** What one key press does to the result list. */
export type SearchKeyAction =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "select" }
  | { readonly type: "close" }
  | { readonly type: "none" };

/**
 * Map a key to a search-dialog action.
 *
 * @param key - `KeyboardEvent.key`
 * @param index - Active result, zero-based
 * @param count - How many results are showing
 */
export function searchKeyAction(key: string, index: number, count: number): SearchKeyAction {
  if (key === "Escape") return { type: "close" };
  if (count === 0) return { type: "none" };
  if (key === "ArrowDown") return { type: "move", index: (index + 1) % count };
  if (key === "ArrowUp") return { type: "move", index: (index - 1 + count) % count };
  if (key === "Enter") return { type: "select" };
  return { type: "none" };
}
