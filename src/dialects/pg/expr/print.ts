/**
 * Prints an `okmodel/expr` node as parameter-free SQL.
 *
 * `okmodel/migrate` and the view compiler share this so a node has one
 * spelling. A `where` object inside `and()` is printed by the caller.
 */

import { OkmError } from "../../../contracts/error.js";
import { compositeAccess } from "../path-sql.js";
import { quoteLiteral } from "../quote.js";
import type { Cond, Node, SettingTypes } from "./index.js";

/**
 * Prints one node.
 *
 * @param node - Expression node
 * @param column - SQL text of a `col` key, already quoted
 * @param cond - Prints a where object nested in `and()`
 * @returns SQL text
 */
export function printNode(
  node: Node,
  column: (name: string) => string,
  cond: (part: Cond) => string,
): string {
  switch (node.k) {
    case "col":
      return column(node.name);
    case "field":
      return compositeAccess(printNode(node.e, column, cond), [node.name]);
    case "lit":
      return literalSql(node.v);
    case "op":
      return `(${printNode(node.a, column, cond)} ${node.op} ${printNode(node.b, column, cond)})`;
    case "fn":
      return `${node.name}(${node.args.map((arg) => printNode(arg, column, cond)).join(", ")})`;
    case "range":
      return `${node.ctor}(${printNode(node.a, column, cond)}, ${printNode(node.b, column, cond)}, ${quoteLiteral(node.bounds)})`;
    case "concat":
      return `(${node.args.map((arg) => `coalesce(${printNode(arg, column, cond)}, '')`).join(" || ")})`;
    case "cast":
      return `(${printNode(node.e, column, cond)})::${node.to}`;
    case "json":
      return `(${printNode(node.e, column, cond)} ->> ${quoteLiteral(node.key)})`;
    case "extract":
      return `extract(${node.field} from ${printNode(node.e, column, cond)})`;
    case "tz":
      return `(${printNode(node.e, column, cond)} at time zone ${quoteLiteral(node.zone)})`;
    case "case": {
      const arms = node.branches.map(
        ([when, then]) =>
          `when ${condOf(when, column, cond)} then ${printNode(then, column, cond)}`,
      );
      return `case ${arms.join(" ")} else ${printNode(node.otherwise, column, cond)} end`;
    }
    case "setting":
      return settingSql(node.name, node.type);
    case "user":
      return "(select current_user)";
    case "call":
      return `(select ${node.name}())`;
    case "includes":
      return `${printNode(node.value, column, cond)} = any (${printNode(node.list, column, cond)})`;
    case "and":
      return node.parts
        .map((part) => `(${isNode(part) ? printNode(part, column, cond) : cond(part)})`)
        .join(" and ");
  }
}

function condOf(
  when: Cond | Node,
  column: (name: string) => string,
  cond: (part: Cond) => string,
): string {
  return isNode(when) ? printNode(when, column, cond) : cond(when);
}

function settingSql(name: string, type: keyof SettingTypes): string {
  const read = `current_setting(${quoteLiteral(name)}, true)`;
  if (type.endsWith("[]")) {
    return `((select coalesce(nullif(${read}, ''), '{}'))::${type})`;
  }
  return `(select nullif(${read}, '')::${type})`;
}

function isNode(value: Cond | Node): value is Node {
  return typeof (value as { k?: unknown }).k === "string";
}

function literalSql(value: string | number | bigint | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value.includes("\0")) {
      throw new OkmError("OKM1120", "A value with a NUL character cannot be written into SQL.", {
        fix: { summary: "Postgres text cannot hold NUL. Remove it from the value." },
      });
    }
    return quoteLiteral(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return text.startsWith("-") ? `(${text})` : text;
}
