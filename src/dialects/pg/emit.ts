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
 * Type arguments read from `t.json<T>()` and `t.jsonb<T>()` in schema source.
 *
 * The key is `table.field`. QA-L3 kept the wrapper for a bare `t.jsonb()`,
 * which has no argument and stays `jsonb<unknown>`. The documented call
 * `t.jsonb<{ published?: boolean }>()` is this map.
 */
export type JsonColumnTypes = ReadonlyMap<string, string>;

/**
 * Emits row, insert, and update interfaces for every table.
 *
 * Names come from the table name: `tasks` becomes `Tasks`, `TasksInsert`,
 * and `TasksUpdate`.
 *
 * @param source - Schema from {@link schema}
 * @param jsonTypes - Type arguments from the schema source. Omitted, json and jsonb stay `unknown`
 * @returns Declaration text
 */
export function emitRowTypes(
  source: BuiltSchema<readonly AnyTable[]>,
  jsonTypes?: JsonColumnTypes,
): string {
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
    lines.push(fields(item, "row", source, jsonTypes));
    lines.push("}", "");
    lines.push(`export interface ${name}Insert {`);
    lines.push(fields(item, "insert", source, jsonTypes));
    lines.push("}", "");
    lines.push(`export interface ${name}Update {`);
    lines.push(fields(item, "update", source, jsonTypes));
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
  const body = `${lines.join("\n")}\n`;
  const aliases: string[] = [];
  if (body.includes("jsonb<")) aliases.push("export type jsonb<T> = T;");
  if (body.includes("json<")) aliases.push("export type json<T> = T;");
  if (aliases.length === 0) return body;
  return `${aliases.join("\n")}\n\n${body}`;
}

function propertyName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Reads `t.json<T>()` and `t.jsonb<T>()` type arguments from schema source.
 *
 * A bare `t.jsonb()` has no argument. The key is the table name and the field.
 *
 * @param source - Schema source, comments removed by the caller or still present
 * @returns `table.field` to the type argument text
 */
export function jsonColumnTypes(source: string): JsonColumnTypes {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const found = new Map<string, string>();
  const pattern = /(?:\bt\s*\.\s*)?(jsonb|json)\s*</g;
  for (const match of text.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const argument = readGeneric(text, open);
    const field = propertyBefore(text, match.index ?? 0);
    const table = tableBefore(text, match.index ?? 0);
    if (argument === undefined || field === undefined || table === undefined) continue;
    found.set(`${table}.${field}`, argument);
  }
  return found;
}

function readGeneric(source: string, open: number): string | undefined {
  if (source[open] !== "<") return undefined;
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) return undefined;
    if (quote !== undefined) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "<") depth += 1;
    else if (char === ">") {
      depth -= 1;
      if (depth === 0)
        return source
          .slice(open + 1, index)
          .trim()
          .replace(/\s+/g, " ");
    }
  }
  return undefined;
}

function propertyBefore(source: string, index: number): string | undefined {
  let cursor = index;
  while (cursor > 0 && /\s/.test(source[cursor - 1] ?? "")) cursor -= 1;
  if (source[cursor - 1] !== ":") return undefined;
  cursor -= 1;
  while (cursor > 0 && /\s/.test(source[cursor - 1] ?? "")) cursor -= 1;
  const end = cursor;
  while (cursor > 0 && /[\w$]/.test(source[cursor - 1] ?? "")) cursor -= 1;
  const name = source.slice(cursor, end);
  return /^[$A-Za-z_][\w$]*$/.test(name) ? name : undefined;
}

function tableBefore(source: string, index: number): string | undefined {
  const head = source.slice(0, index);
  const tables = [...head.matchAll(/table\(\s*["']([^"']+)["']/g)];
  return tables.at(-1)?.[1];
}

function fields(
  item: AnyTable,
  kind: "row" | "insert" | "update",
  source: BuiltSchema<readonly AnyTable[]>,
  jsonTypes: JsonColumnTypes | undefined,
): string {
  const printed: string[] = [];
  const options = item.options as
    | {
        readonly traits?: readonly Trait[];
        readonly omitDefaults?: string;
        readonly tenancy?: { readonly kind?: unknown };
      }
    | undefined;
  const entries = Object.entries(item.columns);
  for (const pair of contributedFields(source.traits, options)) {
    if (!Object.hasOwn(item.columns, pair[0])) entries.push([pair[0], pair[1]]);
  }
  if (
    source.tenancy !== undefined &&
    options?.tenancy?.kind !== "global" &&
    !Object.hasOwn(item.columns, source.tenancy.key)
  ) {
    entries.push([source.tenancy.key, source.tenancy.column()]);
  }
  for (const [field, builder] of entries) {
    if (!(builder instanceof ColumnBuilder)) {
      continue;
    }
    const state = builder.state;
    if (kind === "row") {
      if (!state.hidden) {
        printed.push(
          `  readonly ${field}: ${valueType(state, jsonTypes?.get(`${item.name}.${field}`))};`,
        );
      }
      continue;
    }
    const written = kind === "update" ? updateMode(state) : insertMode(state);
    if (written === "omit") {
      continue;
    }
    const mode = kind === "update" ? "optional" : written;
    const label = valueType(state, jsonTypes?.get(`${item.name}.${field}`));
    printed.push(
      mode === "optional" ? `  readonly ${field}?: ${label};` : `  readonly ${field}: ${label};`,
    );
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

function valueType(state: ColumnState<unknown>, jsonArg: string | undefined): string {
  let label = scalarLabel(state, jsonArg);
  if (state.dims > 0) {
    for (let rank = 0; rank < state.dims; rank += 1) {
      label = `readonly (${label})[]`;
    }
  }
  if (state.nullable) {
    label += " | null";
  }
  return label;
}

function scalarLabel(state: ColumnState<unknown>, jsonArg: string | undefined): string {
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
      return `json<${jsonArg ?? "unknown"}>`;
    case "jsonb":
      return `jsonb<${jsonArg ?? "unknown"}>`;
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
