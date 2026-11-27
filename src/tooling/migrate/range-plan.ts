/**
 * Range type changes: a subtype, diff, or collation change swaps columns.
 *
 * An array or a function refuses the swap. A plain column rewrites behind
 * `confirmTypeChanges`, with `USING column::text::new` after `DROP DEFAULT`.
 */

import { isRange } from "../../contracts/catalog/range.js";
import type { CatalogObject } from "../../contracts/catalog/types.js";
import type { LogicalChange } from "../../dialects/ddl.js";
import { OkmError } from "../../contracts/error.js";
import { canonicalTypeName } from "./type-name.js";

type ColumnUse = {
  readonly table: string;
  readonly column: string;
  readonly array: boolean;
  readonly defaultExpression?: string;
};

/**
 * Logical changes for range types that already exist on both sides.
 *
 * @param beforeBy - Previous catalog, keyed
 * @param afterBy - Next catalog, keyed
 * @param schema - Schema written into the SQL
 * @param confirm - Whether a column swap was confirmed
 * @returns Swap changes
 */
export function rangeChanges(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  schema: string,
  confirm: boolean,
): LogicalChange[] {
  const changes: LogicalChange[] = [];
  for (const [key, next] of afterBy) {
    if (next.kind !== "type" || !isRange(next.definition)) continue;
    const previous = beforeBy.get(key);
    if (previous === undefined || previous.kind !== "type" || !isRange(previous.definition)) {
      continue;
    }
    const before = previous.definition;
    const after = next.definition;
    if (
      canonicalTypeName(before.subtype) === canonicalTypeName(after.subtype) &&
      before.subtypeDiff === after.subtypeDiff &&
      before.collation === after.collation &&
      before.multirange === after.multirange
    ) {
      continue;
    }
    if (before.multirange !== after.multirange && sameBody(before, after)) {
      changes.push({
        op: "rename-type",
        schema,
        from: before.multirange,
        to: after.multirange,
        multirangeFrom: before.multirange,
        multirangeTo: after.multirange,
      });
      continue;
    }
    const uses = columnUses(next.identity.name, afterBy);
    if (uses.some((column) => column.array) || usedByFunction(next.identity.name, afterBy)) {
      throw new OkmError(
        "OKM1915",
        `Range ${next.identity.name} changes subtype, diff, or collation while an array or a function uses it. PostgreSQL cannot rewrite those with USING.`,
        {
          fix: {
            summary:
              "Add a new range, copy the values in SQL you write, and drop the old type. OKM does not emit that rewrite.",
          },
        },
      );
    }
    if (!confirm) {
      throw new OkmError(
        "OKM1915",
        `Range ${next.identity.name} changes subtype, diff, or collation while columns use it. Pass confirmTypeChanges to swap those columns. The rewrite takes an AccessExclusive lock, about 1.3 s per million rows (an estimate).`,
        {
          fix: {
            summary:
              "Confirm the swap, or change the column by hand: new type, DROP DEFAULT, ALTER COLUMN TYPE ... USING (column::text::new), SET DEFAULT, rename.",
          },
        },
      );
    }
    changes.push({
      op: "swap-range",
      schema,
      name: next.identity.name,
      subtype: after.subtype,
      multirange: after.multirange,
      ...(after.subtypeDiff !== undefined ? { subtypeDiff: after.subtypeDiff } : {}),
      ...(after.collation !== undefined ? { collation: after.collation } : {}),
      columns: uses.map((column) => ({
        table: column.table,
        column: column.column,
        ...(column.defaultExpression !== undefined
          ? { defaultExpression: column.defaultExpression }
          : {}),
      })),
    });
  }
  return changes;
}

function sameBody(
  before: { readonly subtype: string; readonly subtypeDiff?: string; readonly collation?: string },
  after: { readonly subtype: string; readonly subtypeDiff?: string; readonly collation?: string },
): boolean {
  return (
    canonicalTypeName(before.subtype) === canonicalTypeName(after.subtype) &&
    before.subtypeDiff === after.subtypeDiff &&
    before.collation === after.collation
  );
}

function columnUses(typeName: string, afterBy: ReadonlyMap<string, CatalogObject>): ColumnUse[] {
  const uses: ColumnUse[] = [];
  for (const object of afterBy.values()) {
    if (object.kind !== "column") continue;
    const dataType = object.definition.dataType;
    const scalar = dataType.replace(/(?:\[\])+$/, "");
    if (canonicalTypeName(scalar) !== canonicalTypeName(typeName) && scalar !== typeName) continue;
    uses.push({
      table: object.identity.parent.name,
      column: object.identity.name,
      array: dataType.endsWith("[]"),
      ...(object.definition.defaultExpression !== undefined
        ? { defaultExpression: object.definition.defaultExpression }
        : {}),
    });
  }
  uses.sort((left, right) => {
    const table = left.table < right.table ? -1 : left.table > right.table ? 1 : 0;
    return table === 0
      ? left.column < right.column
        ? -1
        : left.column > right.column
          ? 1
          : 0
      : table;
  });
  return uses;
}

function usedByFunction(typeName: string, afterBy: ReadonlyMap<string, CatalogObject>): boolean {
  for (const object of afterBy.values()) {
    if (object.kind !== "function") continue;
    if (
      object.dependencies.some(
        (edge) => edge.target.kind === "type" && edge.target.name === typeName,
      )
    ) {
      return true;
    }
  }
  return false;
}
