/**
 * Composite field changes: add, drop, rename, retype, and the column swap.
 *
 * Field order is not a change. A non-null field added to a type that tables
 * already use needs a fill. A field type change on a plain column is a
 * rewrite behind `confirmTypeChanges`. An array, a nested composite, or a
 * function refuses that change.
 */

import { isComposite } from "../../contracts/catalog/composite.js";
import { identityKey } from "../../contracts/catalog/identity.js";
import type { CatalogObject, CompositeFieldDefinition } from "../../contracts/catalog/types.js";
import type { LogicalChange } from "../../dialects/ddl.js";
import { OkmError } from "../../contracts/error.js";
import { canonicalTypeName } from "./type-name.js";

/** SQL that fills one new non-null attribute before its check. */
export type AttributeFill = {
  readonly type: string;
  readonly field: string;
  readonly expression: string;
};

/** Options the composite diff reads off a plan request. */
export type CompositePlanOptions = {
  readonly attributeFills?: readonly AttributeFill[];
  readonly confirmTypeChanges?: boolean;
};

type ColumnUse = {
  readonly table: string;
  readonly column: string;
  readonly array: boolean;
  readonly defaultExpression?: string;
  readonly existed: boolean;
};

/**
 * Logical changes for composite types that already exist on both sides.
 *
 * @param beforeBy - Previous catalog, keyed
 * @param afterBy - Next catalog, keyed
 * @param schema - Schema written into the SQL
 * @param options - Fills and the column-swap confirmation
 * @returns Changes in apply order: drops, retypes, adds, fills, comments
 */
export function compositeChanges(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  schema: string,
  options: CompositePlanOptions,
): LogicalChange[] {
  const changes: LogicalChange[] = [];
  for (const [key, next] of afterBy) {
    if (next.kind !== "type" || !isComposite(next.definition)) continue;
    const previous = beforeBy.get(key);
    if (previous === undefined || previous.kind !== "type" || !isComposite(previous.definition)) {
      continue;
    }
    changes.push(
      ...diffType(
        schema,
        next.identity.name,
        previous.definition.fields,
        next.definition.fields,
        beforeBy,
        afterBy,
        options,
      ),
    );
  }
  return changes;
}

function diffType(
  schema: string,
  typeName: string,
  before: readonly CompositeFieldDefinition[],
  after: readonly CompositeFieldDefinition[],
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  options: CompositePlanOptions,
): LogicalChange[] {
  const changes: LogicalChange[] = [];
  const beforeByName = new Map(before.map((field) => [field.name, field]));
  const afterByName = new Map(after.map((field) => [field.name, field]));
  const uses = columnUses(typeName, beforeBy, afterBy);
  const nested = usedNested(typeName, afterBy);
  const routine = usedByFunction(typeName, afterBy);
  for (const field of before) {
    if (afterByName.has(field.name)) continue;
    changes.push({ op: "drop-attribute", schema, type: typeName, name: field.name });
  }
  let swapped = false;
  for (const field of after) {
    const previous = beforeByName.get(field.name);
    if (previous === undefined) continue;
    if (canonicalTypeName(previous.dataType) === canonicalTypeName(field.dataType)) {
      if ((previous.comment ?? "") !== (field.comment ?? "")) {
        changes.push({
          op: "comment-attribute",
          schema,
          type: typeName,
          field: field.name,
          text: field.comment ?? null,
        });
      }
      continue;
    }
    if (uses.length === 0 && !nested && !routine) {
      changes.push({
        op: "alter-attribute",
        schema,
        type: typeName,
        name: field.name,
        dataType: field.dataType,
      });
      continue;
    }
    if (uses.some((column) => column.array) || nested || routine) {
      refuseRetype(typeName, field.name);
    }
    if (options.confirmTypeChanges !== true) {
      throw new OkmError(
        "OKM1915",
        `Composite ${typeName}.${field.name} changes type while columns use it. Pass confirmTypeChanges to swap those columns. The rewrite takes an AccessExclusive lock, about 1.3 s per million rows (an estimate).`,
        {
          fix: {
            summary:
              "Confirm the swap, or change the column by hand: new type, DROP DEFAULT, ALTER COLUMN TYPE ... USING (column::text::new), SET DEFAULT, rename.",
          },
        },
      );
    }
    if (!swapped) {
      swapped = true;
      changes.push({
        op: "swap-composite",
        schema,
        name: typeName,
        fields: after.map((item) => ({ name: item.name, dataType: item.dataType })),
        columns: uses
          .filter((column) => !column.array)
          .map((column) => ({
            table: column.table,
            column: column.column,
            ...(column.defaultExpression !== undefined
              ? { defaultExpression: column.defaultExpression }
              : {}),
          })),
      });
    }
  }
  for (const field of after) {
    if (beforeByName.has(field.name)) continue;
    const existing = uses.filter((column) => column.existed);
    if (!field.nullable && existing.length > 0) {
      const fill = options.attributeFills?.find(
        (item) => item.type === typeName && item.field === field.name,
      );
      if (fill === undefined) {
        throw new OkmError(
          "OKM1915",
          `Composite ${typeName}.${field.name} is not null, and existing rows have no value for it. Pass an attribute fill. The fill runs as UPDATE ... SET column.${field.name} = <expr> before the check.`,
          {
            fix: {
              summary: `Add attributeFills: [{ type: "${typeName}", field: "${field.name}", expression: "..." }].`,
            },
          },
        );
      }
      changes.push({
        op: "add-attribute",
        schema,
        type: typeName,
        name: field.name,
        dataType: field.dataType,
        ...(field.comment !== undefined ? { comment: field.comment } : {}),
      });
      for (const column of existing) {
        changes.push({
          op: "fill-attribute",
          schema,
          table: column.table,
          column: column.column,
          field: field.name,
          expression: fill.expression,
        });
      }
      continue;
    }
    changes.push({
      op: "add-attribute",
      schema,
      type: typeName,
      name: field.name,
      dataType: field.dataType,
      ...(field.comment !== undefined ? { comment: field.comment } : {}),
    });
  }
  return changes;
}

function refuseRetype(typeName: string, field: string): never {
  throw new OkmError(
    "OKM1915",
    `Composite ${typeName}.${field} changes type while an array, a nested composite, or a function uses ${typeName}. PostgreSQL cannot rewrite those with ALTER ATTRIBUTE.`,
    {
      fix: {
        summary:
          "Add a new composite, copy the values in SQL you write, and drop the old type. OKM does not emit that rewrite.",
      },
    },
  );
}

function columnUses(
  typeName: string,
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
): ColumnUse[] {
  const uses: ColumnUse[] = [];
  for (const object of afterBy.values()) {
    if (object.kind !== "column") continue;
    const dataType = object.definition.dataType;
    const scalar = dataType.replace(/(?:\[\])+$/, "");
    if (canonicalTypeName(scalar) !== canonicalTypeName(typeName) && scalar !== typeName) continue;
    const existed = beforeBy.has(identityKey(object.identity));
    uses.push({
      table: object.identity.parent.name,
      column: object.identity.name,
      array: dataType.endsWith("[]"),
      ...(object.definition.defaultExpression !== undefined
        ? { defaultExpression: object.definition.defaultExpression }
        : {}),
      existed,
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

function usedNested(typeName: string, afterBy: ReadonlyMap<string, CatalogObject>): boolean {
  for (const object of afterBy.values()) {
    if (
      object.kind !== "type" ||
      !isComposite(object.definition) ||
      object.identity.name === typeName
    ) {
      continue;
    }
    for (const field of object.definition.fields) {
      const scalar = field.dataType.replace(/(?:\[\])+$/, "");
      if (scalar === typeName) return true;
    }
  }
  return false;
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
