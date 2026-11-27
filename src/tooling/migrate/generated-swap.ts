/**
 * Stored and virtual generated columns that cannot change in place.
 *
 * A stored/virtual flag change drops the column and adds it again. An index
 * or a constraint that still depends on it is OKM1927. The swap itself needs
 * `confirmTypeChanges`, the same confirmation a composite column swap uses.
 * Dropping generation from a virtual column needs an explicit fill. A stored
 * column keeps its values with `DROP EXPRESSION`.
 */

import { OkmError } from "../../contracts/error.js";
import type { CatalogObject, ColumnObject } from "../../contracts/catalog/types.js";
import { ddlStep } from "../../dialects/ddl-step.js";
import type { LoweredStep } from "../../dialects/ddl.js";
import { qualify, quoteIdent } from "../../dialects/pg/ddl.js";

/** A fill for one column, from `--fill` or the plan request. */
export type ColumnFill = {
  readonly table: string;
  readonly column: string;
  readonly expression: string;
};

const ACCESS = "ACCESS EXCLUSIVE";
const ROW = "ROW EXCLUSIVE";

/**
 * How a generated column changed, when it cannot be altered in place.
 *
 * @param before - Column in the previous catalog
 * @param after - Column in the next catalog
 * @returns `swap` for a stored/virtual change, `ungenerate` when generation is removed and the rest matches, or `undefined`
 */
export function generatedColumnChange(
  before: ColumnObject,
  after: ColumnObject,
): "swap" | "ungenerate" | undefined {
  const left = before.definition.generated;
  const right = after.definition.generated;
  if (left !== undefined && right !== undefined && left.stored !== right.stored) return "swap";
  if (left !== undefined && right === undefined) return "ungenerate";
  return undefined;
}

/**
 * Refuses a stored/virtual swap that would drop a dependent or was not confirmed.
 *
 * @param before - Column being replaced
 * @param after - Column taking its place
 * @param objects - Objects that remain in the next catalog
 * @param confirmed - `confirmTypeChanges` from the plan request
 */
export function assertGeneratedSwap(
  before: ColumnObject,
  after: ColumnObject,
  objects: readonly CatalogObject[],
  confirmed: boolean,
): void {
  const table = before.identity.parent.name;
  const column = before.identity.name;
  const expression =
    after.definition.generated?.expression ?? before.definition.generated?.expression;
  const dependent = dependentName(objects, table, column, expression);
  if (dependent !== undefined) {
    throw new OkmError(
      "OKM1927",
      `Changing ${table}.${column} between stored and virtual drops and re-adds the column. ${dependent} depends on it and would be lost.`,
      {
        fix: {
          summary: `Drop ${dependent} in this change, or keep the column ${before.definition.generated?.stored === false ? "virtual" : "stored"}.`,
        },
      },
    );
  }
  if (!confirmed) {
    throw new OkmError(
      "OKM1915",
      `Changing ${table}.${column} between stored and virtual drops and re-adds the column. Pass confirmTypeChanges.`,
      { fix: { summary: "Pass confirmTypeChanges to accept the swap." } },
    );
  }
}

/**
 * Steps that turn a generated column into a plain column without dropping it.
 *
 * A virtual column needs `fill`. A stored column drops the expression and
 * keeps the stored values.
 *
 * @param before - Generated column
 * @param after - Plain column
 * @param schema - Schema name
 * @param fills - Explicit fills
 * @returns Drop-expression, then the fill when the column was virtual
 */
export function ungenerateSteps(
  before: ColumnObject,
  after: ColumnObject,
  schema: string,
  fills: readonly ColumnFill[],
): LoweredStep[] {
  const tableName = before.identity.parent.name;
  const column = before.identity.name;
  const table = qualify(schema, tableName);
  const name = quoteIdent(column);
  const virtual = before.definition.generated?.stored === false;
  const steps: LoweredStep[] = [];
  if (virtual && !before.definition.nullable) {
    steps.push(
      ddlStep(
        `alter table ${table} alter column ${name} drop not null`,
        "drop-not-null",
        "ddl",
        ACCESS,
      ),
    );
  }
  steps.push(
    ddlStep(
      `alter table ${table} alter column ${name} drop expression`,
      "drop-expression",
      "ddl",
      ACCESS,
    ),
  );
  if (virtual) {
    const fill = fills.find((item) => item.table === tableName && item.column === column);
    if (fill === undefined) {
      throw new OkmError(
        "OKM1928",
        `${tableName}.${column} is virtual. Making it a plain column needs a fill because the values were never stored.`,
        { fix: { summary: "Pass --fill table.column=expression for the column." } },
      );
    }
    steps.push(
      ddlStep(
        `update ${table} set ${name} = ${fill.expression} where ${name} is null`,
        "backfill-expand",
        "ddl",
        ROW,
      ),
    );
  }
  if (before.definition.dataType !== after.definition.dataType) {
    steps.push(
      ddlStep(
        `alter table ${table} alter column ${name} set data type ${after.definition.dataType}`,
        "set-column-type",
        "ddl",
        ACCESS,
      ),
    );
  }
  if (virtual && !after.definition.nullable) {
    steps.push(
      ddlStep(
        `alter table ${table} alter column ${name} set not null`,
        "set-not-null",
        "ddl",
        ACCESS,
      ),
    );
  } else if (!virtual && before.definition.nullable !== after.definition.nullable) {
    steps.push(
      ddlStep(
        `alter table ${table} alter column ${name} ${after.definition.nullable ? "drop not null" : "set not null"}`,
        after.definition.nullable ? "drop-not-null" : "set-not-null",
        "ddl",
        ACCESS,
      ),
    );
  }
  return steps;
}

function dependentName(
  objects: readonly CatalogObject[],
  table: string,
  column: string,
  expression: string | undefined,
): string | undefined {
  const quoted = quoteIdent(column);
  for (const object of objects) {
    if (object.kind === "index" && object.identity.parent.name === table) {
      const definition = object.definition;
      const text = `${definition.predicate ?? ""} ${definition.expression ?? ""}`;
      if (
        definition.columns.includes(column) ||
        text.includes(quoted) ||
        (expression !== undefined && definition.expression === expression)
      ) {
        return `index ${object.identity.name}`;
      }
    }
    if (object.kind === "constraint" && object.identity.parent.name === table) {
      const definition = object.definition;
      const text = definition.expression ?? "";
      if ((definition.columns?.includes(column) ?? false) || text.includes(quoted)) {
        return `constraint ${object.identity.name}`;
      }
    }
  }
  return undefined;
}
