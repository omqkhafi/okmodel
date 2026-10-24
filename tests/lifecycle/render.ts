/**
 * Renders a {@link SchemaModel} as copyable public-API TypeScript.
 */

import { join } from "node:path";

import type {
  ColumnModel,
  FkAction,
  IndexModel,
  SchemaModel,
  TableModel,
  TriggerModel,
  ViewModel,
} from "./model.js";

/**
 * Writes `schema.ts` source for one authored model.
 *
 * @param model - Schema AST
 * @param root - Repository root (for absolute imports in temp projects)
 * @returns File text
 */
export function renderSchema(model: SchemaModel, root: string): string {
  const source = (path: string): string => JSON.stringify(join(root, path));
  const lines: string[] = [
    `import { index, schema, sql, t, table } from ${source("src/dialects/pg/index.ts")};`,
  ];
  if (model.tables.some((table) => table.indexes.some((item) => item.partial !== undefined))) {
    lines.push(`import { buildIndex } from ${source("src/dialects/pg/table.ts")};`);
  }
  if (model.trgm) {
    lines.push(`import { pgTrgm } from ${source("src/dialects/pg/ext/pg-trgm.ts")};`);
  }
  if (model.triggers.length > 0) {
    lines.push(`import { fn, trigger } from ${source("src/dialects/pg/fn/index.ts")};`);
  }
  if (model.views.length > 0) {
    lines.push(`import { view } from ${source("src/dialects/pg/view/index.ts")};`);
  }
  if (model.tenancy) {
    lines.push(`import { columnTenancy } from ${source("src/runtime/tenancy/index.ts")};`);
  }
  if (model.tables.some((table) => table.archive || table.versioned)) {
    lines.push(`import { archivable, versioned } from ${source("src/runtime/traits/index.ts")};`);
  }
  if (model.trgm) lines.push("const trgm = pgTrgm();");

  for (const table of model.tables) {
    lines.push(...renderTable(table));
  }
  if (model.triggers.length > 0) {
    const first = model.tables[0];
    if (first !== undefined) {
      lines.push(
        `const touch = fn("touch", { returns: "trigger", language: "plpgsql", body: "begin return new; end", dependsOn: [${first.key}] });`,
      );
    }
    for (const item of model.triggers) {
      lines.push(renderTrigger(item));
    }
  }
  for (const item of model.views) {
    lines.push(renderView(item));
  }

  const tableKeys = model.tables.map((table) => table.key).join(", ");
  const schemaFields: string[] = [`tables: [${tableKeys}]`];
  if (model.casing === "snake") schemaFields.push('casing: "snake"');
  if (model.tenancy) {
    schemaFields.push('tenancy: columnTenancy({ key: "tenantId", type: "uuid" })');
  }
  if (model.trgm) schemaFields.push("extensions: [trgm]");
  if (model.triggers.length > 0) {
    schemaFields.push("functions: [touch]");
    schemaFields.push(
      `triggers: [${model.triggers.map((item) => triggerKey(item.name)).join(", ")}]`,
    );
  }
  if (model.views.length > 0) {
    schemaFields.push(`views: [${model.views.map((item) => viewKey(item.name)).join(", ")}]`);
  }
  lines.push(`export const app = schema({ ${schemaFields.join(", ")} });`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Formats a case as copyable code for failure reports.
 *
 * @param model - Schema
 * @param root - Repository root
 * @param seed - fast-check seed
 * @returns Text block
 */
export function formatRepro(model: SchemaModel, root: string, seed: number): string {
  return [`// seed ${String(seed)}`, "// schema.ts", renderSchema(model, root).trimEnd()].join(
    "\n",
  );
}

function renderTable(table: TableModel): string[] {
  const columns = table.columns
    .map((column) => `  ${column.key}: ${renderColumn(column)},`)
    .join("\n");
  const options: string[] = [];
  if (table.renamedFrom !== undefined) {
    options.push(`renamedFrom: ${JSON.stringify(table.renamedFrom)}`);
  }
  if (table.indexes.length > 0) {
    options.push(
      `indexes: (columns) => [${table.indexes.map((index) => renderIndex(index)).join(", ")}]`,
    );
  }
  if (table.checks.length > 0) {
    const entries = table.checks
      .map(
        (check) =>
          `${JSON.stringify(check.name)}: () => sql\`${escapeSqlTemplate(check.expression)}\``,
      )
      .join(", ");
    options.push(`checks: { ${entries} }`);
  }
  const traits: string[] = [];
  if (table.archive) traits.push("archivable()");
  if (table.versioned) traits.push("versioned()");
  if (traits.length > 0) options.push(`traits: [${traits.join(", ")}]`);
  const optionBlock = options.length === 0 ? "" : `, { ${options.join(", ")} }`;
  return [
    `const ${table.key} = table(${JSON.stringify(table.name)}, {`,
    columns,
    `}${optionBlock});`,
  ];
}

function renderColumn(column: ColumnModel): string {
  let expr = baseType(column);
  if (column.nullable) expr += ".nullable()";
  if (column.primaryKey) expr += ".primaryKey()";
  if (column.unique) expr += ".unique()";
  if (column.defaultKind === "constant" && column.defaultValue !== undefined) {
    expr += `.default(${literalDefault(column.type, column.defaultValue)})`;
  }
  if (column.defaultKind === "expression" && column.defaultValue !== undefined) {
    expr += `.defaultSql(${JSON.stringify(column.defaultValue)})`;
  }
  if (column.generated !== undefined) {
    expr += `.generated(${JSON.stringify(column.generated)})`;
  }
  if (column.picklist !== undefined) {
    expr += `.picklist(${JSON.stringify(column.picklist)})`;
  }
  if (column.renamedFrom !== undefined) {
    expr += `.renamedFrom(${JSON.stringify(column.renamedFrom)})`;
  }
  if (column.references !== undefined) {
    const opts = fkOptions(column.references.onDelete, column.references.onUpdate);
    expr += `.references(${JSON.stringify(column.references.table)}${opts})`;
  }
  return expr;
}

function baseType(column: ColumnModel): string {
  switch (column.type) {
    case "integer":
      return "t.integer()";
    case "smallint":
      return "t.smallint()";
    case "bigint":
      return "t.bigint()";
    case "text":
      return "t.text()";
    case "varchar":
      return "t.varchar(32)";
    case "boolean":
      return "t.boolean()";
    case "uuid":
      return "t.uuid()";
    case "timestamptz":
      return "t.timestamptz()";
    case "numeric":
      return "t.numeric(10, 2)";
    case "jsonb":
      return "t.jsonb()";
    case "identity":
      return "t.identity()";
    case "enum":
      return `t.enum(${JSON.stringify(column.enumName ?? "status")}, ${JSON.stringify(column.enumLabels ?? ["a", "b"])})`;
    case "domain":
      return `t.domain(${JSON.stringify(column.domainName ?? "pos")}, t.integer(), ${JSON.stringify(column.domainCheck ?? "VALUE > 0")})`;
  }
}

function renderIndex(index: IndexModel): string {
  if (index.usingTrgm) {
    const column = index.columns[0] ?? "title";
    return `trgm.gin(columns.${column}.name)`;
  }
  if (index.partial !== undefined) {
    const cols = JSON.stringify(index.columns);
    const unique = index.unique ? ", isUnique: true" : "";
    return `buildIndex({ columns: ${cols}${unique}, predicate: ${JSON.stringify(index.partial)} })`;
  }
  const cols = index.columns.map((name) => `columns.${name}`).join(", ");
  let expr = `index(${cols})`;
  if (index.unique) expr += ".unique()";
  return expr;
}

function renderTrigger(trigger: TriggerModel): string {
  const when = trigger.when === undefined ? "" : `, when: ${JSON.stringify(trigger.when)}`;
  return `const ${triggerKey(trigger.name)} = trigger(${JSON.stringify(trigger.name)}, { on: ${trigger.tableKey}, timing: "before", events: ["update"], level: "row", calls: touch${when} });`;
}

function renderView(view: ViewModel): string {
  const cols = view.columns.map((name) => JSON.stringify(name)).join(", ");
  return `const ${viewKey(view.name)} = view(${JSON.stringify(view.name)}, (q) => q.from(${view.tableKey}, [${cols}]));`;
}

function triggerKey(name: string): string {
  return `trig_${safeIdent(name)}`;
}

function viewKey(name: string): string {
  return `view_${safeIdent(name)}`;
}

function safeIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^(\d)/, "_$1") || "x";
}

function fkOptions(onDelete?: FkAction, onUpdate?: FkAction): string {
  if (onDelete === undefined && onUpdate === undefined) return "";
  const parts: string[] = [];
  if (onDelete !== undefined) parts.push(`onDelete: ${JSON.stringify(onDelete)}`);
  if (onUpdate !== undefined) parts.push(`onUpdate: ${JSON.stringify(onUpdate)}`);
  return `, { ${parts.join(", ")} }`;
}

function escapeSqlTemplate(expression: string): string {
  return expression.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function literalDefault(type: ColumnModel["type"], value: string): string {
  if (type === "boolean") return value === "true" ? "true" : "false";
  if (
    type === "integer" ||
    type === "smallint" ||
    type === "bigint" ||
    type === "numeric" ||
    type === "domain"
  ) {
    return value;
  }
  return JSON.stringify(value);
}
