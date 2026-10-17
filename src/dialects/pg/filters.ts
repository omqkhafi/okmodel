/**
 * Allowlisted filters. The checks run when `filters()` is called.
 *
 * A hidden field in `allow`, `sort`, or `relations` is OKM1123. The parser
 * loads on the first `parse()`.
 */

import { OkmError } from "../../contracts/error.js";
import type { FilterSpec, ParsedFilters } from "./table.js";

/**
 * Checks an allowlist and returns `parse`.
 *
 * @param table - Table the filters belong to
 * @param relations - Relation calls stored on the table, when it has any
 * @param spec - Allow, sort, and relation fields
 * @param isHidden - Whether `table.field` is hidden (own columns or related names)
 * @returns A parser for one request object
 */
export function openFilters(
  table: string,
  relations: unknown,
  spec: FilterSpec,
  isHidden: (table: string, field: string) => boolean,
): { parse(query: unknown): Promise<ParsedFilters> } {
  const allow = spec.allow ?? {};
  const sort = spec.sort ?? [];
  for (const field of Object.keys(allow)) deny(isHidden, table, field);
  for (const field of sort) deny(isHidden, table, field);
  const nested = spec.relations;
  if (nested !== undefined) {
    for (const name of Object.keys(nested)) {
      const target = relationTable(relations, name);
      for (const field of nested[name] ?? []) deny(isHidden, target, field);
    }
  }
  return {
    parse(query: unknown): Promise<ParsedFilters> {
      return import("./filter-parse.js").then((mod) => mod.parseQuery(allow, sort, query, nested));
    },
  };
}

function deny(
  isHidden: (table: string, field: string) => boolean,
  table: string,
  field: string,
): void {
  if (!isHidden(table, field)) return;
  throw new OkmError("OKM1123", `Field ${table}.${field} is hidden.`, {
    fix: {
      // 93 characters. A shorter sentence moves the featureless-app gzip (D233).
      summary:
        "Remove this hidden field from the allowlist. Hidden fields stay out of caller filter or sort.",
    },
  });
}

function relationTable(relations: unknown, name: string): string {
  if (typeof relations !== "object" || relations === null) return name;
  const call = (relations as Record<string, unknown>)[name];
  if (typeof call !== "object" || call === null || !("table" in call)) return name;
  const table = (call as { readonly table?: unknown }).table;
  return typeof table === "string" ? table : name;
}
