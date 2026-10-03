/**
 * Which operators a column type accepts (spec §10.1).
 *
 * The read and write paths share this check. A mismatch is OKM1124 and names
 * the column type and the operators it accepts. Values stay parameters.
 * A path, key, or regconfig that would be interpolated is checked here first.
 */

import { OkmError } from "../../contracts/error.js";
import { writeArray } from "./array-literal.js";

/** Column family the operator table uses. */
export type OperatorFamily = "text" | "array" | "json" | "jsonb" | "range" | "tsvector" | "scalar";

const FAMILIES: Readonly<Record<string, readonly OperatorFamily[]>> = {
  startsWith: ["text"],
  endsWith: ["text"],
  like: ["text"],
  ilike: ["text"],
  contains: ["text", "array", "jsonb", "range"],
  containedBy: ["array", "jsonb", "range"],
  overlaps: ["array", "range"],
  hasKey: ["jsonb"],
  hasAnyKey: ["jsonb"],
  path: ["json", "jsonb"],
  matches: ["tsvector"],
  "json.set": ["json", "jsonb"],
  "arr.append": ["array"],
  "arr.remove": ["array"],
};

const ACCEPTED: Readonly<Record<OperatorFamily, readonly string[]>> = {
  text: [
    "eq",
    "not",
    "lt",
    "lte",
    "gt",
    "gte",
    "between",
    "startsWith",
    "contains",
    "endsWith",
    "like",
    "ilike",
    "inList",
    "notIn",
  ],
  array: [
    "eq",
    "not",
    "contains",
    "containedBy",
    "overlaps",
    "inList",
    "notIn",
    "arr.append",
    "arr.remove",
  ],
  jsonb: ["eq", "not", "contains", "containedBy", "hasKey", "hasAnyKey", "path", "json.set"],
  json: ["eq", "not", "path", "json.set"],
  range: ["eq", "not", "lt", "lte", "gt", "gte", "contains", "containedBy", "overlaps"],
  tsvector: ["eq", "not", "matches"],
  scalar: ["eq", "not", "lt", "lte", "gt", "gte", "between", "inList", "notIn", "inc"],
};

/** A catalog type we are willing to splice into SQL. It is not user input. */
const SAFE_TYPE = /^[A-Za-z_][A-Za-z0-9_]*(\(\d+\))?(\[\])*$/;

const REGCONFIG = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Classifies a catalog type.
 *
 * @param dataType - Column `dataType`
 * @returns The operator family
 */
export function columnFamily(dataType: string): OperatorFamily {
  if (dataType.endsWith("[]")) return "array";
  if (dataType === "jsonb") return "jsonb";
  if (dataType === "json") return "json";
  if (dataType === "tsvector") return "tsvector";
  if (dataType.endsWith("range")) return "range";
  if (
    dataType === "text" ||
    dataType === "citext" ||
    dataType.startsWith("varchar(") ||
    dataType.startsWith("char(") ||
    dataType.startsWith("character")
  ) {
    return "text";
  }
  return "scalar";
}

/**
 * Rejects an operator the column type does not accept.
 *
 * Operators with no entry in the fit table (equality, comparisons on a scalar)
 * are left to the caller.
 *
 * @param column - Field name and catalog type
 * @param name - Operator name
 */
export function assertOperatorFits(
  column: { readonly field: string; readonly dataType: string },
  name: string,
): void {
  const families = FAMILIES[name];
  if (families === undefined) return;
  if (families.includes(columnFamily(column.dataType))) return;
  const accepted = ACCEPTED[columnFamily(column.dataType)];
  const search =
    name === "matches" && columnFamily(column.dataType) === "text"
      ? " Text search needs a tsvector column."
      : "";
  throw new OkmError(
    "OKM1124",
    `Operator ${name} does not apply to ${column.dataType} column ${column.field}. Accepted operators: ${accepted.join(", ")}.${search}`,
    { fix: { summary: `Use one of: ${accepted.join(", ")}.` } },
  );
}

/**
 * Returns a catalog type that is safe to place in SQL, or throws.
 *
 * @param dataType - Column type from the catalog
 * @param column - Field name, for the error
 * @returns `dataType` when it matches the type pattern
 */
export function sqlType(
  dataType: string,
  column: { readonly field: string; readonly dataType: string },
): string {
  if (SAFE_TYPE.test(dataType)) return dataType;
  assertOperatorFits(column, "contains");
  throw new OkmError(
    "OKM1124",
    `Operator contains does not apply to ${column.dataType} column ${column.field}. Accepted operators: ${ACCEPTED[columnFamily(column.dataType)].join(", ")}.`,
    { fix: { summary: "Use a column type this operator accepts." } },
  );
}

/**
 * Rejects NUL and other control characters.
 *
 * An empty string is allowed. {@link assertBoundText} rejects that too.
 *
 * @param value - Text that will be bound
 * @param role - What the string is, used in the error
 */
export function assertNoControl(value: string, role: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new OkmError("OKM1122", `${role} contains a control character.`, {
        fix: { summary: "Remove NUL and other control characters. The value is not sent." },
      });
    }
  }
}

/**
 * Rejects an empty string, NUL, and other control characters in a key or path segment.
 *
 * These strings are bound, and a control character still fails before the
 * statement is sent.
 *
 * @param value - Key or segment
 * @param role - What the string is, used in the error
 */
export function assertBoundText(value: string, role: string): void {
  if (value.length === 0) {
    throw new OkmError("OKM1122", `${role} is empty.`, {
      fix: { summary: "Pass a non-empty key or path segment." },
    });
  }
  assertNoControl(value, role);
}

/**
 * Rejects a regconfig name that is not an identifier.
 *
 * @param config - Text search configuration
 */
export function assertRegconfig(config: string): void {
  if (!REGCONFIG.test(config)) {
    throw new OkmError(
      "OKM1122",
      `Text search config ${config} must be a regconfig name such as english or pg_catalog.simple.`,
      { fix: { summary: "Pass a regconfig name. Quotes and extra clauses are not accepted." } },
    );
  }
}

/**
 * Encodes path segments or keys as a Postgres text-array literal.
 *
 * The literal is a parameter, not SQL text.
 *
 * @param values - Segments or keys
 * @param role - What each string is
 * @returns A `{...}` literal
 */
export function textArray(values: readonly string[], role: string): string {
  for (const value of values) assertBoundText(value, role);
  return writeArray(values, 1, (value) => String(value), false);
}

/**
 * Element type of an array catalog type, safe to splice into SQL.
 *
 * @param dataType - Array type such as `text[]`
 * @param column - Field name, for the error
 * @returns The type with one `[]` removed
 */
export function arrayElementType(
  dataType: string,
  column: { readonly field: string; readonly dataType: string },
): string {
  if (!dataType.endsWith("[]")) {
    assertOperatorFits(column, "arr.append");
  }
  const element = dataType.slice(0, -2);
  if (!SAFE_TYPE.test(element)) {
    throw new OkmError(
      "OKM1124",
      `Operator arr.append does not apply to ${column.dataType} column ${column.field}. Accepted operators: ${ACCEPTED.array.join(", ")}.`,
      { fix: { summary: "Use arr.append on an array column." } },
    );
  }
  return element;
}
