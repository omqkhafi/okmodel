/**
 * Prints an index predicate or expression.
 *
 * Imported only by `index()` and `.where()`, so an application that never
 * builds an index does not load it. The catalog stores the SQL text.
 */

import { isExpr, nodeOf, type Node } from "./expr/index.js";
import { printNode as printExprNode } from "./expr/print.js";
import { definition } from "./misuse.js";
import { isOperator, operatorName, operatorValue } from "./operators.js";
import { quoteIdent } from "./ddl.js";
import { quoteLiteral } from "./quote.js";

type NameOf = (field: string) => string;

/**
 * Turns a where object, an expression, `true`, `false`, or `sql` text into SQL.
 *
 * `columnName` qualifies `col()` references. It defaults to `sqlName`, which
 * is the where-key column. A membership subquery passes the outer table here.
 *
 * @param value - Predicate
 * @param sqlName - SQL name of a where key
 * @param columnName - SQL name of a `col()` reference. Defaults to `sqlName`
 * @returns SQL text
 */
export function printIndexText(
  value: unknown,
  sqlName: NameOf,
  columnName: NameOf = sqlName,
): string {
  if (typeof value === "string") return value;
  if (value === true) return "true";
  if (value === false) return "false";
  if (isSqlText(value)) return value.text;
  if (isExpr(value)) return printNode(nodeOf(value), sqlName, columnName);
  if (value !== null && typeof value === "object") {
    return printWhere(value as Readonly<Record<string, unknown>>, sqlName, columnName);
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
  sqlName: NameOf,
  columnName: NameOf,
): string {
  const parts: string[] = [];
  for (const key of Object.keys(where)) {
    parts.push(printClause(sqlName(key), where[key], sqlName, columnName));
  }
  if (parts.length === 0) definition("An index predicate where object is empty.");
  return parts.join(" and ");
}

function printClause(column: string, value: unknown, sqlName: NameOf, columnName: NameOf): string {
  const quoted = quoteIdent(column);
  if (value === null) return `${quoted} is null`;
  if (isExpr(value)) return `${quoted} = ${printNode(nodeOf(value), sqlName, columnName)}`;
  if (!isOperator(value)) return `${quoted} = ${printLiteral(value)}`;
  const name = operatorName(value);
  const operand = operatorValue(value);
  if (name === "eq") return `${quoted} = ${printOperand(operand, sqlName, columnName)}`;
  if (name === "lt") return `${quoted} < ${printOperand(operand, sqlName, columnName)}`;
  if (name === "lte") return `${quoted} <= ${printOperand(operand, sqlName, columnName)}`;
  if (name === "gt") return `${quoted} > ${printOperand(operand, sqlName, columnName)}`;
  if (name === "gte") return `${quoted} >= ${printOperand(operand, sqlName, columnName)}`;
  if (name === "not") {
    if (operand === null) return `${quoted} is not null`;
    return `not (${printClause(column, operand, sqlName, columnName)})`;
  }
  if (name === "inList" && Array.isArray(operand)) {
    return `${quoted} in (${operand.map((item) => printOperand(item, sqlName, columnName)).join(", ")})`;
  }
  if (name === "between" && Array.isArray(operand) && operand.length === 2) {
    return `${quoted} between ${printOperand(operand[0], sqlName, columnName)} and ${printOperand(operand[1], sqlName, columnName)}`;
  }
  if (name === "or" && Array.isArray(operand)) {
    return `(${operand
      .map((item) =>
        item !== null && typeof item === "object"
          ? printWhere(item as Readonly<Record<string, unknown>>, sqlName, columnName)
          : printOperand(item, sqlName, columnName),
      )
      .join(" or ")})`;
  }
  if (name === "and" && Array.isArray(operand)) {
    return `(${operand
      .map((item) =>
        item !== null && typeof item === "object"
          ? printWhere(item as Readonly<Record<string, unknown>>, sqlName, columnName)
          : printOperand(item, sqlName, columnName),
      )
      .join(" and ")})`;
  }
  definition(
    `Index predicate operator ${name} is not printed. Pass sql\`...\` for that predicate.`,
  );
}

function printOperand(value: unknown, sqlName: NameOf, columnName: NameOf): string {
  if (isExpr(value)) return printNode(nodeOf(value), sqlName, columnName);
  return printLiteral(value);
}

function printLiteral(value: unknown): string {
  if (typeof value === "string") return quoteLiteral(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  definition("An index predicate literal must be a string, number, boolean, or null.");
}

function printNode(node: Node, sqlName: NameOf, columnName: NameOf): string {
  switch (node.k) {
    case "col":
      return quoteIdent(columnName(node.name));
    case "field":
      return `(${printNode(node.e, sqlName, columnName)}).${quoteIdent(node.name)}`;
    case "lit":
      return node.v === null ? "null" : printLiteral(node.v);
    case "op":
      return `(${printNode(node.a, sqlName, columnName)} ${node.op} ${printNode(node.b, sqlName, columnName)})`;
    case "fn":
      return `${node.name}(${node.args.map((arg) => printNode(arg, sqlName, columnName)).join(", ")})`;
    case "concat":
      return `concat(${node.args.map((arg) => printNode(arg, sqlName, columnName)).join(", ")})`;
    case "cast":
      return `cast(${printNode(node.e, sqlName, columnName)} as ${node.to})`;
    case "json":
      return `${printNode(node.e, sqlName, columnName)}->>'${node.key.replaceAll("'", "''")}'`;
    case "extract":
      return `extract(${node.field} from ${printNode(node.e, sqlName, columnName)})`;
    case "tz":
      return `${printNode(node.e, sqlName, columnName)} at time zone ${quoteLiteral(node.zone)}`;
    case "case":
      return `case ${node.branches
        .map(
          ([when, then]) =>
            `when ${printWhere(when, sqlName, columnName)} then ${printNode(then, sqlName, columnName)}`,
        )
        .join(" ")} else ${printNode(node.otherwise, sqlName, columnName)} end`;
    case "setting":
    case "user":
    case "call":
    case "includes":
      return printExprNode(
        node,
        (name) => quoteIdent(columnName(name)),
        (part) => printWhere(part, sqlName, columnName),
      );
    case "and":
      return `(${node.parts
        .map((part) =>
          isNode(part)
            ? printNode(part, sqlName, columnName)
            : printWhere(part, sqlName, columnName),
        )
        .join(" and ")})`;
    default:
      definition("This expression cannot be printed as an index.");
  }
}

function isNode(value: Node | Readonly<Record<string, unknown>>): value is Node {
  return value !== null && typeof value === "object" && "k" in value;
}
