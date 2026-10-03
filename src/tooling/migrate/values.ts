/**
 * `--replace` flags for a removed picklist or enum value (D131).
 *
 * The schema never stores the replacement. The flag is the only place it
 * exists, and a chain (a value replaced by another removed value) is rejected.
 */

import { OkmError } from "../../contracts/error.js";

/** One replacement. `to` is `null` when the flag says `=null`. */
export type Replacement = {
  readonly table: string;
  readonly column: string;
  readonly from: string;
  readonly to: string | null;
};

/**
 * Parses `table.column.old=new`.
 *
 * The split is the first `=` and the first two dots, so the old value may
 * contain dots. `=null` is the null replacement.
 *
 * @param flag - One `--replace` value
 * @returns The replacement
 */
export function parseReplace(flag: string): Replacement {
  const eq = flag.indexOf("=");
  if (eq <= 0) {
    throw new OkmError("OKM1541", `--replace ${flag} must be table.column.old=new.`, {
      fix: {
        summary: "Pass --replace <table>.<column>.<old>=<new>, or =null on a nullable column.",
      },
    });
  }
  const left = flag.slice(0, eq);
  const raw = flag.slice(eq + 1);
  const first = left.indexOf(".");
  const second = first < 0 ? -1 : left.indexOf(".", first + 1);
  if (first <= 0 || second <= first + 1 || second === left.length - 1) {
    throw new OkmError("OKM1541", `--replace ${flag} must be table.column.old=new.`, {
      fix: {
        summary: "Pass --replace <table>.<column>.<old>=<new>, or =null on a nullable column.",
      },
    });
  }
  const table = left.slice(0, first);
  const column = left.slice(first + 1, second);
  const from = left.slice(second + 1);
  return { table, column, from, to: raw === "null" ? null : raw };
}

/**
 * Rejects a chain: a replacement whose new value is itself removed.
 *
 * @param replacements - Flags for one generate
 */
export function assertNoChains(replacements: readonly Replacement[]): void {
  const removed = new Set(replacements.map((item) => pair(item.table, item.column, item.from)));
  for (const item of replacements) {
    if (item.to !== null && removed.has(pair(item.table, item.column, item.to))) {
      const flag = `--replace ${item.table}.${item.column}.${item.from}=${item.to}`;
      throw new OkmError("OKM1541", `${flag} chains through another removed value.`, {
        fix: { summary: "The replacement must be in the new list. No chains." },
      });
    }
  }
}

function pair(table: string, column: string, value: string): string {
  return `${table}\u0000${column}\u0000${value}`;
}
