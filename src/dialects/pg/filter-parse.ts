/**
 * Turns an allowlisted request object into `where` and `orderBy`.
 *
 * Loaded the first time `parse()` is called. `filters()` validates the spec
 * before this module exists.
 *
 * A request key is equality when the value is a scalar and `eq` is allowed.
 * An object value names operators `parse` applies. `sort` is a field name
 * from the sort list. A relation key becomes `has` over the allowlisted fields.
 * A column key wins when the same name is in `allow` and `relations`.
 */

import { OkmError } from "../../contracts/error.js";
import { tag } from "./operators.js";
import type { ParsedFilters } from "./table.js";

const PARSED = [
  "eq",
  "in",
  "inList",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "startsWith",
  "endsWith",
  "contains",
  "like",
  "ilike",
  "not",
  "containedBy",
  "overlaps",
  "hasKey",
  "hasAnyKey",
] as const;

const PARSED_OPS = `,${PARSED.join(",")},`;

const PARSED_FIX =
  "Use eq, in, notIn, lt, lte, gt, gte, between, startsWith, endsWith, contains, like, ilike, not, containedBy, overlaps, hasKey, or hasAnyKey.";

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
 * @param relations - Relation name to fields, when `filters` passed any
 * @returns Filters a caller can spread into `find`
 */
export function parseQuery(
  allow: Readonly<Record<string, readonly string[]>>,
  sort: readonly string[],
  query: unknown,
  relations?: Readonly<Record<string, readonly string[]>>,
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
  const nested = relations ?? {};
  const whereParts: Record<string, unknown>[] = [];
  let orderBy: Record<string, "asc" | "desc"> | undefined;
  for (const key of Object.keys(query)) {
    const value = (query as Record<string, unknown>)[key];
    if (key === "sort" && typeof value === "string" && sort.includes(value)) {
      orderBy = { [value]: "asc" };
      continue;
    }
    if (Object.hasOwn(allow, key)) {
      whereParts.push(...clauses(key, allow[key] ?? [], value));
      continue;
    }
    if (Object.hasOwn(nested, key)) {
      whereParts.push(relationClause(key, nested[key] ?? [], value));
      continue;
    }
    throw new OkmError("OKM1123", `Field ${key} is not in the allow list.`, {
      fix: { summary: "Remove the field, or add it to filters({ allow }) or relations." },
    });
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
    case "not":
      if (value !== null && typeof value === "object") {
        throw new OkmError("OKM1120", `not on ${field} takes a scalar.`, {
          fix: { summary: "Send not a scalar or null. Nested operators are not accepted." },
        });
      }
      return { [field]: tag("not", value) };
    case "containedBy":
      return { [field]: tag("containedBy", value) };
    case "overlaps":
      return { [field]: tag("overlaps", value) };
    case "hasKey":
      return { [field]: tag("hasKey", text(value, "hasKey")) };
    case "hasAnyKey":
      return { [field]: tag("hasAnyKey", strings(value, field)) };
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

function relationClause(
  name: string,
  fields: readonly string[],
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OkmError("OKM1120", `filters() cannot apply a value on ${name}.`, {
      fix: { summary: "Send the relation an object of allowlisted fields." },
    });
  }
  const parts: Record<string, unknown>[] = [];
  for (const field of Object.keys(value)) {
    if (!Object.hasOwn(value, field)) continue;
    if (!fields.includes(field)) {
      throw new OkmError("OKM1123", `Field ${field} is not in the allow list.`, {
        fix: { summary: "Remove the field, or add it to filters({ relations })." },
      });
    }
    parts.push(...clauses(field, PARSED, (value as Record<string, unknown>)[field]));
  }
  if (parts.length === 0) {
    throw new OkmError("OKM1120", `filters() cannot apply a value on ${name}.`, {
      fix: { summary: "Send the relation an object of allowlisted fields." },
    });
  }
  return { [name]: tag("has", combine(parts)) };
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

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new OkmError("OKM1120", `hasAnyKey on ${field} needs an array of strings.`, {
      fix: { summary: "Send hasAnyKey an array of strings." },
    });
  }
  return value as readonly string[];
}

function text(value: unknown, op: string): string {
  if (typeof value !== "string") {
    throw new OkmError("OKM1120", `${op} needs a string.`, {
      fix: { summary: "Send that operator a string." },
    });
  }
  return value;
}
