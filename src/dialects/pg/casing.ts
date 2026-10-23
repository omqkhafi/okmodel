/**
 * The one place a TypeScript key becomes a SQL name.
 *
 * `schema()` builds a {@link Names} once. Every caller that needs a table or
 * column name asks it, so the spelling cannot drift between the compiler, the
 * views, the tenancy predicates, and the planner.
 */

import { ColumnBuilder } from "./column.js";
import type { AnyTable } from "./table.js";

/** What `schema({ casing })` accepts. Omitted keeps every key as written. */
export type Casing = "snake" | "camel";

/**
 * Name lookups for one schema.
 *
 * `sqlName` on a table or a column always wins over the casing.
 */
export type Names = {
  /** The schema's casing, or `undefined` when keys are SQL names. */
  readonly casing: Casing | undefined;
  /** SQL spelling of a TypeScript key. */
  readonly name: (key: string) => string;
  /** SQL name of a table. */
  readonly table: (item: AnyTable) => string;
  /** SQL name of one column of `item`. */
  readonly column: (item: AnyTable, field: string) => string;
};

const isUpper = (code: number): boolean => code >= 65 && code <= 90;
const isLower = (code: number): boolean => code >= 97 && code <= 122;
const lowerAscii = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/**
 * Splits a key into words.
 *
 * A word ends before an uppercase letter that follows a lowercase letter, a
 * digit, or any other character. In a run of capitals the last one starts the
 * next word when a lowercase letter follows: `HTMLParser` is `HTML` and
 * `Parser`. A lone `s` after a run of two or more capitals belongs to the run:
 * `getURLs` is `get` and `URLs`. Digits stay with the word before them, and
 * every other character, ASCII or not, is part of the word it is in.
 * Underscores separate words.
 *
 * @param key - Key without its leading and trailing underscores
 * @returns The words, in their original case
 */
function words(key: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (let at = 0; at <= key.length; at += 1) {
    const code = key.charCodeAt(at);
    if (at === key.length || code === 95) {
      if (at > from) found.push(key.slice(from, at));
      from = at + 1;
      continue;
    }
    if (at === from || !isUpper(code)) continue;
    const next = key.charCodeAt(at + 1);
    let split = !isUpper(key.charCodeAt(at - 1));
    if (!split && isLower(next)) {
      const after = key.charCodeAt(at + 2);
      const closes =
        at + 2 >= key.length || isUpper(after) || after === 95 || (after >= 48 && after <= 57);
      split = !(next === 115 && closes);
    }
    if (split) {
      found.push(key.slice(from, at));
      from = at;
    }
  }
  return found;
}

/**
 * Spells a key in one of the two casings.
 *
 * Leading and trailing underscores are kept. Runs of underscores between words
 * are one separator. Only ASCII letters change case: anything else passes
 * through. `camel` writes the first word in lowercase and capitalises the rest.
 *
 * @param casing - Target casing
 * @param key - TypeScript key
 * @returns The SQL spelling
 */
export function caseName(casing: Casing, key: string): string {
  let end = key.length;
  while (end > 0 && key.charCodeAt(end - 1) === 95) end -= 1;
  let start = 0;
  while (start < end && key.charCodeAt(start) === 95) start += 1;
  const parts = words(key.slice(start, end)).map(lowerAscii);
  const body =
    casing === "snake"
      ? parts.join("_")
      : parts
          .map((part, index) => {
            const first = part.charCodeAt(0);
            return index > 0 && isLower(first)
              ? String.fromCharCode(first - 32) + part.slice(1)
              : part;
          })
          .join("");
  return key.slice(0, start) + body + key.slice(end);
}

/**
 * Builds the name lookups for a schema.
 *
 * Each key is spelled once and remembered.
 *
 * @param casing - `schema({ casing })`
 * @returns The lookups every caller shares
 */
export function namesFor(casing: Casing | undefined): Names {
  const seen = new Map<string, string>();
  const name =
    casing === undefined
      ? (key: string): string => key
      : (key: string): string => {
          let spelled = seen.get(key);
          if (spelled === undefined) {
            spelled = caseName(casing, key);
            seen.set(key, spelled);
          }
          return spelled;
        };
  return {
    casing,
    name,
    table: (item) =>
      (item.options as { readonly sqlName?: string } | undefined)?.sqlName ?? name(item.name),
    column: (item, field) => {
      const builder = item.columns[field];
      return (builder instanceof ColumnBuilder ? builder.state.sqlName : undefined) ?? name(field);
    },
  };
}
