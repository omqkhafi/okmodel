/**
 * Turns an allowlisted request object into `where` and `orderBy`.
 *
 * Loaded the first time `parse()` is called. `filters()` validates the spec
 * before this module exists.
 *
 * A request key is equality when the value is a scalar and `eq` is allowed.
 * An object value names operators: `eq`, `in` (`inList`), `notIn`, `lt`,
 * `lte`, `gt`, `gte`, `between`, `startsWith`, `endsWith`, `contains`,
 * `like`, and `ilike`. `sort` is a field name from the sort list.
 */

import { OkmError } from "../../contracts/error.js";
import { tag } from "./operators.js";
import type { ParsedFilters } from "./table.js";

const PARSED_OPS =
  ",eq,in,inList,notIn,lt,lte,gt,gte,between,startsWith,endsWith,contains,like,ilike,";

const PARSED_FIX =
  "Use eq, in, notIn, lt, lte, gt, gte, between, startsWith, endsWith, contains, like, or ilike.";

/**
 * Reads one request object.
 *
 * Lookups use own properties, so `constructor`, `__proto__`, `toString`, and
 * `hasOwnProperty` are ordinary keys. A key that is not in `allow` is OKM1123.
 * `sort` is the exception.
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
  for (const field of Object.keys(allow)) {
    for (const op of allow[field] ?? []) {
      if (PARSED_OPS.includes(`,${op},`)) continue;
      throw new OkmError("OKM1120", `filters() cannot apply ${op} on ${field}.`, {
        fix: { summary: PARSED_FIX },
      });
    }
  }
  const whereParts: Record<string, unknown>[] = [];
  let orderBy: Record<string, "asc" | "desc"> | undefined;
  for (const key of Object.keys(query)) {
    const value = (query as Record<string, unknown>)[key];
    if (key === "sort" && typeof value === "string" && sort.includes(value)) {
      orderBy = { [value]: "asc" };
      continue;
    }
    if (!Object.hasOwn(allow, key)) {
      throw new OkmError("OKM1123", `Field ${key} is not in the allow list.`, {
        fix: { summary: "Remove the field, or add it to filters({ allow })." },
      });
    }
    const ops = allow[key] ?? [];
    whereParts.push(...clauses(key, ops, value));
  }
  const where = combine(whereParts);
  return orderBy === undefined ? { where } : { where, orderBy };
}

function clauses(field: string, ops: readonly string[], value: unknown): Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (!ops.includes("eq")) {
      throw new OkmError("OKM1120", `filters() cannot apply eq on ${field}.`, {
        fix: { summary: "Add eq to that field, or send an object of allowed operators." },
      });
    }
    return [{ [field]: value }];
  }
  const applied: Record<string, unknown>[] = [];
  for (const op of Object.keys(value)) {
    if (!Object.hasOwn(value, op)) continue;
    if (!ops.includes(op) && !(op === "inList" && ops.includes("in"))) {
      throw new OkmError("OKM1120", `filters() cannot apply ${op} on ${field}.`, {
        fix: { summary: "Send an operator that field's allow list names." },
      });
    }
    applied.push(one(field, op, (value as Record<string, unknown>)[op]));
  }
  if (applied.length === 0) {
    throw new OkmError("OKM1120", `filters() cannot apply a value on ${field}.`, {
      fix: { summary: "Send eq as a scalar, or an object of allowed operators." },
    });
  }
  return applied;
}

function one(field: string, op: string, value: unknown): Record<string, unknown> {
  switch (op) {
    case "eq":
      return {
        [field]: value !== null && typeof value === "object" ? tag("eq", value) : value,
      };
    case "in":
    case "inList":
      return { [field]: tag("inList", list(value, op)) };
    case "notIn":
      return { [field]: tag("notIn", list(value, op)) };
    case "lt":
      return { [field]: tag("lt", value) };
    case "lte":
      return { [field]: tag("lte", value) };
    case "gt":
      return { [field]: tag("gt", value) };
    case "gte":
      return { [field]: tag("gte", value) };
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new OkmError("OKM1120", `between on ${field} needs two bounds.`, {
          fix: { summary: "Send between as [from, to]." },
        });
      }
      return { [field]: tag("between", [value[0], value[1]] as const) };
    }
    case "startsWith":
      return { [field]: tag("startsWith", text(value, op)) };
    case "endsWith":
      return { [field]: tag("endsWith", text(value, op)) };
    case "contains":
      return { [field]: tag("contains", value) };
    case "like":
      return { [field]: tag("like", text(value, op)) };
    case "ilike":
      return { [field]: tag("ilike", text(value, op)) };
    default:
      throw new OkmError("OKM1120", `filters() cannot apply ${op} on ${field}.`, {
        fix: { summary: "Use an operator parse applies." },
      });
  }
}

function combine(parts: readonly Record<string, unknown>[]): Record<string, unknown> {
  const first = parts[0];
  if (first === undefined) return {};
  if (parts.length === 1) return first;
  return tag("and", parts) as unknown as Record<string, unknown>;
}

function list(value: unknown, op: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new OkmError("OKM1120", `${op} needs an array.`, {
      fix: { summary: "Send that operator an array of values." },
    });
  }
  return value;
}

function text(value: unknown, op: string): string {
  if (typeof value !== "string") {
    throw new OkmError("OKM1120", `${op} needs a string.`, {
      fix: { summary: "Send that operator a string." },
    });
  }
  return value;
}
