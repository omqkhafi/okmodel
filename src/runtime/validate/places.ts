/**
 * Reads validation rules stored on a schema.
 *
 * `schema()` does not call this. `okm check` does, and the engine does on
 * the first validated call. A field with rules in two places is OKM1030.
 */

import { OkmError } from "../../contracts/error.js";
import { ColumnBuilder } from "../../dialects/pg/column.js";
import type { ValidationModel } from "../../dialects/pg/model.js";
import { definition } from "../../dialects/pg/misuse.js";
import type { AnyTable } from "../../dialects/pg/table.js";

type Setting = {
  readonly enabled: boolean;
  readonly onRead: boolean;
  readonly style: "inline" | "section" | undefined;
};

type Section = {
  readonly fields: Readonly<Record<string, readonly unknown[]>>;
  readonly row: readonly unknown[];
  readonly rowPresent: boolean;
};

/**
 * Reports OKM1030 and a malformed `validate` section.
 *
 * A schema with no tables is left alone. The walk reads stored rules and
 * does not run them.
 *
 * @param schema - A `schema()` result
 */
export function assertValidation(schema: object): void {
  const record = schema as { readonly tables?: readonly AnyTable[]; readonly validation?: unknown };
  const tables = record.tables;
  if (tables === undefined) return;
  for (const item of tables) validationGate(record.validation, item);
}

/**
 * Builds one table's validation model from the rules stored on it.
 *
 * Returns `undefined` when validation is off for the table. Throws OKM1030
 * when a field is validated in two places, whether or not validation is on.
 *
 * @param schemaFlag - The schema's `validation` option, stored as given
 * @param table - The table, with its column rules and `validate` section
 * @returns The model, or `undefined` when this table does not validate
 */
export function validationGate(schemaFlag: unknown, table: AnyTable): ValidationModel | undefined {
  return buildGate(schemaFlag, table);
}

/**
 * Reports whether a write on this table would run validation.
 *
 * True when the effective setting is on, or the table stores a `validate`
 * section or an inline `.validate(...)`. A call that passes `{ validate: false }`
 * would not. This does not run the rules and does not report OKM1030.
 *
 * @param schemaFlag - The schema `validation` option, stored as given
 * @param table - The table, with its column rules and `validate` section
 * @param options - Write options. `{ validate: false }` skips the call
 * @returns Whether the write would validate
 */
export function writeWouldValidate(schemaFlag: unknown, table: AnyTable, options: object): boolean {
  if ((options as { readonly validate?: unknown }).validate === false) return false;
  const setting = tableSetting(readSetting(schemaFlag, "schema()"), table.options);
  if (setting.enabled) return true;
  const section = table.options as { readonly validate?: unknown } | undefined;
  if (section?.validate !== undefined) return true;
  for (const builder of Object.values(table.columns)) {
    if (builder instanceof ColumnBuilder && builder.state.validate !== undefined) return true;
  }
  return false;
}

function buildGate(schemaFlag: unknown, table: AnyTable): ValidationModel | undefined {
  const setting = tableSetting(readSetting(schemaFlag, "schema()"), table.options);
  const section = readSection(table.name, table.options);
  if (setting.style === "inline" && section.rowPresent) conflict(table.name, "$row");
  const fields: Record<string, readonly unknown[]> = {};
  const required: string[] = [];
  const notNull: string[] = [];
  const pick: Record<string, readonly string[]> = {};
  const names = new Set<string>();
  for (const [field, builder] of Object.entries(table.columns)) {
    if (!(builder instanceof ColumnBuilder)) continue;
    names.add(field);
    const inline = builder.state.validate?.rules;
    const named = Object.hasOwn(section.fields, field) ? section.fields[field] : undefined;
    const rules = takeRules(table.name, field, inline, named, setting.style);
    if (rules !== undefined) fields[field] = rules;
    const state = builder.state;
    const writable =
      state.guarded !== true && state.omitWrite !== true && state.generated === undefined;
    if (setting.enabled && writable) {
      if (!state.nullable && state.hasDefault !== true) required.push(field);
      if (!state.nullable) notNull.push(field);
      if (state.picklist !== undefined) pick[field] = state.picklist.values;
    }
  }
  for (const field of Object.keys(section.fields)) {
    if (!names.has(field)) definition(`Table ${table.name} validate.${field} is not a column.`);
  }
  if (!setting.enabled) return undefined;
  return { onRead: setting.onRead, row: section.row, fields, required, notNull, pick };
}

function readSetting(value: unknown, where: string): Setting {
  if (value === undefined || value === false)
    return { enabled: false, onRead: false, style: undefined };
  if (value === true) return { enabled: true, onRead: false, style: undefined };
  if (isPlain(value)) {
    return {
      enabled: value.enabled === undefined ? true : value.enabled === true,
      onRead: value.onRead === true,
      style: readStyle(value.style),
    };
  }
  definition(`${where} validation must be a boolean or { enabled, onRead, style }.`);
}

function tableSetting(schemaSetting: Setting, options: object | undefined): Setting {
  const value =
    options === undefined ? undefined : (options as { readonly validation?: unknown }).validation;
  if (value === undefined) return schemaSetting;
  if (value === true)
    return { enabled: true, onRead: schemaSetting.onRead, style: schemaSetting.style };
  if (value === false)
    return { enabled: false, onRead: schemaSetting.onRead, style: schemaSetting.style };
  if (isPlain(value)) {
    return {
      enabled: value.enabled === undefined ? true : value.enabled === true,
      onRead: value.onRead === undefined ? schemaSetting.onRead : value.onRead === true,
      style: value.style === undefined ? schemaSetting.style : readStyle(value.style),
    };
  }
  definition("table() validation must be a boolean or { enabled, onRead, style }.");
}

function readStyle(value: unknown): "inline" | "section" | undefined {
  if (value === undefined) return undefined;
  if (value === "inline" || value === "section") return value;
  definition("validation.style must be inline or section.");
}

function readSection(table: string, options: object | undefined): Section {
  const validate =
    options === undefined ? undefined : (options as { readonly validate?: unknown }).validate;
  if (validate === undefined) return { fields: {}, row: [], rowPresent: false };
  if (!isPlain(validate)) {
    definition(`Table ${table} option validate must be { field: rules, $row: rules }.`);
  }
  const fields: Record<string, readonly unknown[]> = {};
  let row: readonly unknown[] = [];
  let rowPresent = false;
  for (const key of Object.keys(validate)) {
    const item = validate[key];
    if (!Array.isArray(item)) definition(`Table ${table} validate.${key} must be a list of rules.`);
    if (key === "$row") {
      row = item;
      rowPresent = true;
    } else fields[key] = item;
  }
  return { fields, row, rowPresent };
}

function takeRules(
  table: string,
  field: string,
  inline: readonly unknown[] | undefined,
  section: readonly unknown[] | undefined,
  style: "inline" | "section" | undefined,
): readonly unknown[] | undefined {
  const hasInline = inline !== undefined;
  const hasSection = section !== undefined;
  if (
    (hasInline && hasSection) ||
    (style === "inline" && hasSection) ||
    (style === "section" && hasInline)
  ) {
    conflict(table, field);
  }
  if (hasInline && inline.length > 0) return inline;
  if (hasSection && section.length > 0) return section;
  return undefined;
}

function conflict(table: string, field: string): never {
  throw new OkmError(
    "OKM1030",
    `Field ${table}.${field} is validated in two places. Keep the column rules or the validate section.`,
    {
      ...(field === "$row" ? {} : { columns: [field] }),
      fix: { summary: "Keep one validation for the field." },
    },
  );
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
