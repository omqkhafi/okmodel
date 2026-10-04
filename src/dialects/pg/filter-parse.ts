/**
 * Turns an allowlisted request object into `where` and `orderBy`.
 *
 * Loaded the first time `parse()` is called. `filters()` validates the spec
 * before this module exists.
 */

import { OkmError } from "../../contracts/error.js";
import type { ParsedFilters } from "./table.js";

/**
 * Reads one request object.
 *
 * A plain value is equality when `eq` is allowlisted. `sort` is a field name
 * from the sort list. JSON cannot add an operator.
 *
 * @param allow - Fields and the operators each one accepts
 * @param sort - Fields a caller may sort by
 * @param query - One request object
 * @returns Filters a caller can spread into `find`
 */
export function parseQuery(
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
