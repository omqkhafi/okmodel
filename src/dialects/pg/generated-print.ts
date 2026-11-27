/**
 * Prints held generated expressions and rewrites indexes on virtual columns.
 *
 * Imported by the planner and by drift, not by `schema()`. The app startup
 * graph does not load this file.
 */

import { OkmError } from "../../contracts/error.js";
import type { Catalog, ColumnObject, IndexObject } from "../../contracts/catalog/types.js";
import { heldGenerated, isHeldExpression } from "./generated-hold.js";
import { printIndexText } from "./index-print.js";
import { quoteIdent } from "./ddl.js";

type GeneratedColumn = {
  readonly table: string;
  readonly name: string;
  readonly stored: boolean;
  expression: string;
};

/**
 * Replaces placeholders with SQL and turns an index on a virtual column
 * into an expression index on that column's expression.
 *
 * @param catalog - Catalog `schema()` built, mutated in place
 */
export function sealGenerated(catalog: Catalog): void {
  const columns: GeneratedColumn[] = [];
  for (const object of catalog.objects) {
    if (object.kind !== "column" || object.definition.generated === undefined) continue;
    const generated = object.definition.generated;
    const expression = expand(generated.expression);
    (generated as { expression: string }).expression = expression;
    columns.push({
      table: object.identity.parent.name,
      name: object.identity.name,
      stored: generated.stored,
      expression,
    });
  }
  refuseGeneratedShape(catalog, columns);
  rewriteVirtualIndexes(catalog, columns);
}

function expand(expression: string): string {
  if (!isHeldExpression(expression)) return expression;
  const item = heldGenerated[Number(expression.slice(1))];
  if (item === undefined) {
    throw new OkmError("OKM1920", "A generated expression was not held.", {
      fix: { summary: "Call schema() again in this process, then plan." },
    });
  }
  if (item.value === undefined) {
    throw new OkmError(
      "OKM1920",
      "A generated expression names a column that is not on the table.",
      {
        fix: { summary: "Pass a column handle from the generated() callback." },
      },
    );
  }
  return printIndexText(item.value, item.names);
}

function refuseGeneratedShape(catalog: Catalog, columns: readonly GeneratedColumn[]): void {
  const virtual = columns.filter((column) => !column.stored);
  for (const column of columns) {
    for (const other of columns) {
      if (other.table !== column.table || other.name === column.name) continue;
      if (mentions(column.expression, other.name)) {
        throw new OkmError(
          "OKM1920",
          `Generated ${column.table}.${column.name} references generated column ${other.name}. PostgreSQL refuses a generated column in a generated expression.`,
          { fix: { summary: "Repeat that column's expression, or use the base columns." } },
        );
      }
    }
  }
  for (const object of catalog.objects) {
    if (object.kind === "table" && object.definition.partition !== undefined) {
      for (const name of object.definition.partition.columns) {
        if (
          columns.some((column) => column.table === object.identity.name && column.name === name)
        ) {
          throw new OkmError(
            "OKM1920",
            `Partition key ${object.identity.name}.${name} is generated. PostgreSQL refuses a generated partition key.`,
            { fix: { summary: "Partition by a base column." } },
          );
        }
      }
    }
    if (virtual.length === 0) continue;
    if (object.kind === "constraint") {
      const hit = virtual.find(
        (column) =>
          column.table === object.identity.parent.name &&
          object.definition.columns.includes(column.name),
      );
      if (hit === undefined) continue;
      if (
        object.definition.constraintKind === "primaryKey" ||
        object.definition.constraintKind === "unique"
      ) {
        throw new OkmError(
          "OKM1920",
          `${object.definition.constraintKind} ${object.identity.name} uses virtual column ${hit.name}. A virtual column cannot be a key.`,
          { fix: { summary: "Use a stored generated column, or index its expression." } },
        );
      }
      if (object.definition.constraintKind === "foreignKey") {
        throw new OkmError(
          "OKM1920",
          `Foreign key ${object.identity.name} uses virtual column ${hit.name}. A virtual column cannot be referenced from.`,
          { fix: { summary: "Use a stored generated column." } },
        );
      }
    }
    if (object.kind === "index") {
      const hit = virtual.find((column) => column.table === object.identity.parent.name);
      if (hit === undefined) continue;
      const predicate = object.definition.predicate;
      const expression = object.definition.expression;
      if (predicate !== undefined && mentions(predicate, hit.name)) {
        throw new OkmError(
          "OKM1920",
          `Index ${object.identity.name} predicates virtual column ${hit.name}. PostgreSQL refuses that.`,
          { fix: { summary: "Repeat the column's expression in the predicate." } },
        );
      }
      if (
        expression !== undefined &&
        mentions(expression, hit.name) &&
        expression !== hit.expression
      ) {
        throw new OkmError(
          "OKM1920",
          `Index ${object.identity.name} references virtual column ${hit.name}. PostgreSQL refuses an expression index on the column.`,
          {
            fix: {
              summary: "Index the column itself. OKM compiles that to the column's expression.",
            },
          },
        );
      }
    }
  }
}

function rewriteVirtualIndexes(catalog: Catalog, columns: readonly GeneratedColumn[]): void {
  for (const object of catalog.objects) {
    if (object.kind !== "index") continue;
    const virtual = columns.filter(
      (column) => !column.stored && column.table === object.identity.parent.name,
    );
    if (virtual.length === 0) continue;
    const used = virtual.filter((column) => object.definition.columns.includes(column.name));
    if (used.length !== 1 || object.definition.columns.length !== 1) continue;
    const column = used[0];
    if (column === undefined) continue;
    const definition = object.definition as unknown as {
      columns: string[];
      expression?: string;
    };
    definition.columns = [];
    definition.expression = column.expression;
  }
}

function mentions(expression: string, column: string): boolean {
  return expression.includes(quoteIdent(column));
}

/** A column object, when the caller already narrowed it. */
export type { ColumnObject, IndexObject };
