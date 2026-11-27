/**
 * Prints an index predicate or expression.
 *
 * Imported only by `index()` and `.where()`, so an application that never
 * builds an index does not load it. The catalog stores the SQL text.
 */

import { isExpr, nodeOf, type Node } from "./expr/index.js";
import { definition } from "./misuse.js";
import { isOperator, operatorName, operatorValue } from "./operators.js";
import { quoteIdent } from "./ddl.js";
import { quoteLiteral } from "./quote.js";

/** Turns a where object, an expression, or `sql` text into index SQL. */
export function printIndexText(value: unknown, sqlName: (field: string) => string): string {
  if (typeof value === "string") return value;
  if (isSqlText(value)) return value.text;
  if (isExpr(value)) return printNode(nodeOf(value), sqlName);
  if (value !== null && typeof value === "object") {
    return printWhere(value as Readonly<Record<string, unknown>>, sqlName);
  }
  definition("An index predicate must be a where object, an expression, or sql.");
}

function isSqlText(value: unknown): value is { readonly text: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string" &&
    !("name" in value)
  );
}

function printWhere(
  where: Readonly<Record<string, unknown>>,
  sqlName: (field: string) => string,
): string {
  const parts: string[] = [];
  for (const key of Object.keys(where)) {
    parts.push(printClause(sqlName(key), where[key], sqlName));
  }
  if (parts.length === 0) definition("An index predicate where object is empty.");
  return parts.join(" and ");
}

function printClause(column: string, value: unknown, sqlName: (field: string) => string): string {
  const quoted = quoteIdent(column);
  if (value === null) return `${quoted} is null`;
  if (isExpr(value)) return `${quoted} = ${printNode(nodeOf(value), sqlName)}`;
  if (!isOperator(value)) return `${quoted} = ${printLiteral(value)}`;
  const name = operatorName(value);
  const operand = operatorValue(value);
  if (name === "eq") return `${quoted} = ${printOperand(operand, sqlName)}`;
  if (name === "lt") return `${quoted} < ${printOperand(operand, sqlName)}`;
  if (name === "lte") return `${quoted} <= ${printOperand(operand, sqlName)}`;
  if (name === "gt") return `${quoted} > ${printOperand(operand, sqlName)}`;
  if (name === "gte") return `${quoted} >= ${printOperand(operand, sqlName)}`;
  if (name === "not") {
    if (operand === null) return `${quoted} is not null`;
    return `not (${printClause(column, operand, sqlName)})`;
  }
  if (name === "inList" && Array.isArray(operand)) {
    return `${quoted} in (${operand.map((item) => printOperand(item, sqlName)).join(", ")})`;
  }
  if (name === "between" && Array.isArray(operand) && operand.length === 2) {
    return `${quoted} between ${printOperand(operand[0], sqlName)} and ${printOperand(operand[1], sqlName)}`;
  }
  if (name === "or" && Array.isArray(operand)) {
    return `(${operand
      .map((item) =>
        item !== null && typeof item === "object"
          ? printWhere(item as Readonly<Record<string, unknown>>, sqlName)
          : printOperand(item, sqlName),
      )
      .join(" or ")})`;
  }
  if (name === "and" && Array.isArray(operand)) {
    return `(${operand
      .map((item) =>
        item !== null && typeof item === "object"
          ? printWhere(item as Readonly<Record<string, unknown>>, sqlName)
          : printOperand(item, sqlName),
      )
      .join(" and ")})`;
  }
  definition(
    `Index predicate operator ${name} is not printed. Pass sql\`...\` for that predicate.`,
  );
}

function printOperand(value: unknown, sqlName: (field: string) => string): string {
  if (isExpr(value)) return printNode(nodeOf(value), sqlName);
  return printLiteral(value);
}

function printLiteral(value: unknown): string {
  if (typeof value === "string") return quoteLiteral(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  definition("An index predicate literal must be a string, number, boolean, or null.");
}

function printNode(node: Node, sqlName: (field: string) => string): string {
  switch (node.k) {
    case "col":
      return quoteIdent(sqlName(node.name));
    case "field":
      return `(${printNode(node.e, sqlName)}).${quoteIdent(node.name)}`;
    case "lit":
      return node.v === null ? "null" : printLiteral(node.v);
    case "op":
      return `(${printNode(node.a, sqlName)} ${node.op} ${printNode(node.b, sqlName)})`;
    case "fn":
      return `${node.name}(${node.args.map((arg) => printNode(arg, sqlName)).join(", ")})`;
    case "concat":
      return `concat(${node.args.map((arg) => printNode(arg, sqlName)).join(", ")})`;
    case "cast":
      return `cast(${printNode(node.e, sqlName)} as ${node.to})`;
    case "json":
      return `${printNode(node.e, sqlName)}->>'${node.key.replaceAll("'", "''")}'`;
    case "extract":
      return `extract(${node.field} from ${printNode(node.e, sqlName)})`;
    case "tz":
      return `${printNode(node.e, sqlName)} at time zone ${quoteLiteral(node.zone)}`;
    case "case":
      return `case ${node.branches
        .map(([when, then]) => `when ${printWhere(when, sqlName)} then ${printNode(then, sqlName)}`)
        .join(" ")} else ${printNode(node.otherwise, sqlName)} end`;
    case "setting":
      return `current_setting(${quoteLiteral(node.name)})`;
    case "and":
      return `(${node.parts
        .map((part) => (isNode(part) ? printNode(part, sqlName) : printWhere(part, sqlName)))
        .join(" and ")})`;
    default:
      definition("This expression cannot be printed as an index.");
  }
}

function isNode(value: Node | Readonly<Record<string, unknown>>): value is Node {
  return value !== null && typeof value === "object" && "k" in value;
}
