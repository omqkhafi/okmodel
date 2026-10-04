/**
 * Allowlisted filters. Loaded the first time `filters()` is called.
 *
 * A hidden field in `allow`, `sort`, or `relations` is OKM1123.
 */

import { OkmError } from "../../contracts/error.js";
import type { FilterSpec, ParsedFilters } from "./table.js";

/**
 * Checks an allowlist and returns `parse`.
 *
 * @param table - Table the filters belong to
 * @param relations - Relation calls stored on the table, when it has any
 * @param spec - Allow, sort, and relation fields
 * @param hiddenFields - `table.field` keys recorded while tables were defined
 * @returns A parser for one request object
 */
export function openFilters(
  table: string,
  relations: unknown,
  spec: FilterSpec,
  hiddenFields: ReadonlySet<string>,
): { parse(query: unknown): ParsedFilters } {
  const allow = spec.allow ?? {};
  const sort = spec.sort ?? [];
  for (const field of Object.keys(allow)) deny(hiddenFields, table, field);
  for (const field of sort) deny(hiddenFields, table, field);
  const nested = spec.relations;
  if (nested !== undefined) {
    for (const name of Object.keys(nested)) {
      const target = relationTable(relations, name);
      for (const field of nested[name] ?? []) deny(hiddenFields, target, field);
    }
  }
  return {
    parse(query: unknown): ParsedFilters {
      return parseEq(allow, sort, query);
    },
  };
}

function deny(hiddenFields: ReadonlySet<string>, table: string, field: string): void {
  if (!hiddenFields.has(`${table}.${field}`)) return;
  throw new OkmError("OKM1123", `Field ${table}.${field} is hidden.`, {
    fix: {
      summary:
        "Remove the hidden field from the allowlist. Hidden fields stay out of caller filters and sorts.",
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

function parseEq(
  allow: Readonly<Record<string, readonly string[]>>,
  sort: readonly string[],
  query: unknown,
): ParsedFilters {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw new OkmError("OKM1121", "filters parse expects an object of fields.");
  }
  const where: Record<string, unknown> = {};
  let orderBy: Record<string, "asc" | "desc"> | undefined;
  for (const key of Object.keys(query)) {
    const value = (query as Record<string, unknown>)[key];
    if (key === "sort" && typeof value === "string" && sort.includes(value)) {
      orderBy = { [value]: "asc" };
      continue;
    }
    if (allow[key]?.includes("eq") === true && (value === null || typeof value !== "object")) {
      where[key] = value;
    }
  }
  return orderBy === undefined ? { where } : { where, orderBy };
}
