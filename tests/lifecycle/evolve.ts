/**
 * Applies one evolution to a schema model.
 */

import type { Evolution, SchemaModel, TableModel } from "./model.js";

/**
 * Returns a new schema after one evolution step.
 *
 * @param model - Current schema
 * @param step - Evolution
 * @returns Next schema
 */
export function applyEvolution(model: SchemaModel, step: Evolution): SchemaModel {
  switch (step.kind) {
    case "addColumn":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        columns: [...table.columns, step.column],
      }));
    case "dropColumn":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        columns: table.columns.filter((column) => column.key !== step.columnKey),
        indexes: table.indexes.filter((index) => !index.columns.includes(step.columnKey)),
      }));
    case "renameColumn":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        columns: table.columns.map((column) =>
          column.key === step.columnKey
            ? { ...column, name: step.nextName, renamedFrom: column.name }
            : column,
        ),
      }));
    case "retypeColumn":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        columns: table.columns.map((column) => {
          if (column.key !== step.columnKey) return column;
          const { picklist: _p, enumName: _e, enumLabels: _l, ...rest } = column;
          return { ...rest, type: step.nextType };
        }),
      }));
    case "addTable":
      return { ...model, tables: [...model.tables, step.table] };
    case "dropTable":
      return {
        ...model,
        tables: model.tables.filter((table) => table.key !== step.tableKey),
        triggers: model.triggers.filter((trigger) => trigger.tableKey !== step.tableKey),
        views: model.views.filter((view) => view.tableKey !== step.tableKey),
      };
    case "renameTable":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        name: step.nextName,
        renamedFrom: table.name,
      }));
    case "addEnumValue":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        columns: table.columns.map((column) =>
          column.key === step.columnKey
            ? {
                ...column,
                enumLabels: [...(column.enumLabels ?? []), step.value],
              }
            : column,
        ),
      }));
    case "addIndex":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        indexes: [...table.indexes, step.index],
      }));
    case "dropIndex":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        indexes: table.indexes.filter((_, index) => index !== step.indexIndex),
      }));
    case "addCheck":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        checks: [...table.checks, { name: step.name, expression: step.expression }],
      }));
    case "addPicklist":
      return mapTable(model, step.tableKey, (table) => ({
        ...table,
        columns: table.columns.map((column) =>
          column.key === step.columnKey ? { ...column, picklist: step.values } : column,
        ),
      }));
    case "addTrigger":
      return { ...model, triggers: [...model.triggers, step.trigger] };
    case "addView":
      return { ...model, views: [...model.views, step.view] };
    case "addFk":
      return mapTable(model, step.tableKey, (table) => {
        const existing = table.columns.find((column) => column.key === step.columnKey);
        if (existing !== undefined) {
          return {
            ...table,
            columns: table.columns.map((column) =>
              column.key === step.columnKey
                ? {
                    ...column,
                    references: {
                      table: step.target,
                      onDelete: step.onDelete,
                      onUpdate: step.onUpdate,
                    },
                  }
                : column,
            ),
          };
        }
        return {
          ...table,
          columns: [
            ...table.columns,
            {
              key: step.columnKey,
              name: step.columnKey,
              type: "integer",
              nullable: true,
              primaryKey: false,
              unique: false,
              defaultKind: "none",
              references: {
                table: step.target,
                onDelete: step.onDelete,
                onUpdate: step.onUpdate,
              },
            },
          ],
        };
      });
  }
}

/**
 * Clears rename markers after a successful apply so the next generate is idle.
 *
 * @param model - Schema that may still carry renamedFrom
 * @returns Settled schema
 */
export function settleRenames(model: SchemaModel): SchemaModel {
  return {
    ...model,
    tables: model.tables.map((table) => ({
      key: table.key,
      name: table.name,
      columns: table.columns.map((column) => omitRename(column)),
      indexes: table.indexes,
      checks: table.checks,
      archive: table.archive,
      versioned: table.versioned,
    })),
  };
}

function omitRename(column: import("./model.js").ColumnModel): import("./model.js").ColumnModel {
  return {
    key: column.key,
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    primaryKey: column.primaryKey,
    unique: column.unique,
    defaultKind: column.defaultKind,
    ...(column.defaultValue === undefined ? {} : { defaultValue: column.defaultValue }),
    ...(column.generated === undefined ? {} : { generated: column.generated }),
    ...(column.picklist === undefined ? {} : { picklist: column.picklist }),
    ...(column.check === undefined ? {} : { check: column.check }),
    ...(column.enumName === undefined ? {} : { enumName: column.enumName }),
    ...(column.enumLabels === undefined ? {} : { enumLabels: column.enumLabels }),
    ...(column.domainName === undefined ? {} : { domainName: column.domainName }),
    ...(column.domainCheck === undefined ? {} : { domainCheck: column.domainCheck }),
    ...(column.references === undefined ? {} : { references: column.references }),
  };
}

function mapTable(
  model: SchemaModel,
  tableKey: string,
  map: (table: TableModel) => TableModel,
): SchemaModel {
  return {
    ...model,
    tables: model.tables.map((table) => (table.key === tableKey ? map(table) : table)),
  };
}
