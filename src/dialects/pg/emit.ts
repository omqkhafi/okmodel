/**
 * Writes `.okm/types.d.ts` text from a schema.
 *
 * The CLI that writes the file arrives later. This function is the text.
 * Field shapes match the inferred `~row`, `~insert`, and `~update` types.
 */

import { ColumnBuilder, type ColumnState } from "./column.js";
import { type BuiltSchema } from "./schema.js";
import { type AnyTable, emittedTypeName } from "./table.js";
import { contributedFields, type Trait } from "./trait.js";

/**
 * Emits row, insert, and update interfaces for every table.
 *
 * Names come from the table name: `tasks` becomes `Tasks`, `TasksInsert`,
 * and `TasksUpdate`.
 *
 * @param source - Schema from {@link schema}
 * @returns Declaration text
 */
export function emitRowTypes(source: BuiltSchema<readonly AnyTable[]>): string {
  const lines: string[] = [
    "/**",
    " * Row types emitted from the schema.",
    ` * Mode: ${source.types}.`,
    " */",
    "",
  ];
  const rows: string[] = [];
  const inserts: string[] = [];
  const updates: string[] = [];
  for (const item of source.tables) {
    const name = emittedTypeName(item.name);
    const key = propertyName(item.name);
    rows.push(`  readonly ${key}: ${name};`);
    inserts.push(`  readonly ${key}: ${name}Insert;`);
    updates.push(`  readonly ${key}: ${name}Update;`);
    lines.push(`export interface ${name} {`);
    lines.push(fields(item, "row", source.traits));
    lines.push("}", "");
    lines.push(`export interface ${name}Insert {`);
    lines.push(fields(item, "insert", source.traits));
    lines.push("}", "");
    lines.push(`export interface ${name}Update {`);
    lines.push(fields(item, "update", source.traits));
    lines.push("}", "");
  }
  lines.push("export interface Rows {");
  lines.push(rows.join("\n"));
  lines.push("}", "");
  lines.push("export interface Inserts {");
  lines.push(inserts.join("\n"));
  lines.push("}", "");
  lines.push("export interface Updates {");
  lines.push(updates.join("\n"));
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function propertyName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
}

function fields(
  item: AnyTable,
  kind: "row" | "insert" | "update",
  schemaTraits: readonly Trait[] | undefined,
): string {
  const printed: string[] = [];
  const options = item.options as
    | { readonly traits?: readonly Trait[]; readonly omitDefaults?: string }
    | undefined;
  const entries = Object.entries(item.columns);
  for (const pair of contributedFields(schemaTraits, options)) {
    if (!Object.hasOwn(item.columns, pair[0])) entries.push([pair[0], pair[1]]);
  }
  for (const [field, builder] of entries) {
    if (!(builder instanceof ColumnBuilder)) {
      continue;
    }
    const state = builder.state;
    if (kind === "row") {
      if (!state.hidden) {
        printed.push(`  readonly ${field}: ${valueType(state, "required")};`);
      }
      continue;
    }
    const written = kind === "update" ? updateMode(state) : insertMode(state);
    if (written === "omit") {
      continue;
    }
    const mode = kind === "update" ? "optional" : written;
    printed.push(`  readonly ${field}: ${valueType(state, mode)};`);
  }
  return printed.join("\n");
}

/**
 * Mirrors `InsertKind` in the column builder.
 *
 * @param state - Column definition
 * @returns Whether insert omits the field, makes it undefined, or requires it
 */
function insertMode(state: ColumnState<unknown>): "omit" | "optional" | "required" {
  if (state.omitWrite || state.generated !== undefined || state.guarded) {
    return "omit";
  }
  if (state.hasDefault || state.nullable) {
    return "optional";
  }
  return "required";
}

function updateMode(state: ColumnState<unknown>): "omit" | "optional" {
  if (state.omitUpdate || insertMode(state) === "omit") return "omit";
  return "optional";
}

function valueType(state: ColumnState<unknown>, mode: "required" | "optional"): string {
  let label = scalarLabel(state);
  if (state.dims > 0) {
    for (let rank = 0; rank < state.dims; rank += 1) {
      label = `readonly (${label})[]`;
    }
  }
  if (state.nullable) {
    label += " | null";
  }
  if (mode === "optional") {
    label += " | undefined";
  }
  return label;
}

function scalarLabel(state: ColumnState<unknown>): string {
  if (state.picklist !== undefined) {
    return state.picklist.values.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (state.typeLabel !== undefined) {
    return state.typeLabel;
  }
  const base = baseName(state.baseType);
  switch (base) {
    case "smallint":
    case "integer":
    case "real":
    case "double precision":
      return "number";
    case "bigint":
    case "numeric":
    case "text":
    case "varchar":
    case "char":
    case "citext":
    case "uuid":
    case "inet":
    case "cidr":
    case "macaddr":
    case "macaddr8":
    case "tsvector":
    case "ltree":
      return "string";
    case "boolean":
      return "boolean";
    case "bytea":
      return "Uint8Array";
    case "json":
    case "jsonb":
      return "unknown";
    case "timestamptz":
      return "Temporal.Instant";
    case "timestamp":
      return "Temporal.PlainDateTime";
    case "date":
      return "Temporal.PlainDate";
    case "time":
      return "Temporal.PlainTime";
    case "timetz":
      return "{ readonly time: Temporal.PlainTime; readonly offset: string }";
    case "interval":
      return "Temporal.Duration";
    case "tstzrange":
      return rangeLabel("Temporal.Instant");
    case "daterange":
      return rangeLabel("Temporal.PlainDate");
    case "int4range":
      return rangeLabel("number");
    case "int8range":
    case "numrange":
      return rangeLabel("string");
    case "point":
      return "{ readonly x: number; readonly y: number }";
    case "line":
      return "{ readonly a: number; readonly b: number; readonly c: number }";
    default:
      return "unknown";
  }
}

function rangeLabel(bound: string): string {
  return `{ readonly empty: true } | { readonly empty: false; readonly lower: ${bound} | null; readonly upper: ${bound} | null; readonly lowerInclusive: boolean; readonly upperInclusive: boolean }`;
}

function baseName(dataType: string): string {
  if (dataType.startsWith("double precision")) {
    return "double precision";
  }
  const space = dataType.indexOf(" ");
  const head = space === -1 ? dataType : dataType.slice(0, space);
  const paren = head.indexOf("(");
  return paren === -1 ? head : head.slice(0, paren);
}
