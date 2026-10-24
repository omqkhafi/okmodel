/**
 * Authored schema AST for the migration lifecycle property.
 *
 * The generator builds values of these types; the renderer writes public-API
 * TypeScript; the runner evolves them and checks CLI invariants.
 */

import { caseName } from "../../src/dialects/pg/casing.ts";

/** Referential action the public API accepts, including explicit no action. */
export type FkAction = "cascade" | "restrict" | "set null" | "set default" | "no action";

/** Column type the grammar draws from. */
export type ColumnTypeKind =
  | "integer"
  | "smallint"
  | "bigint"
  | "text"
  | "varchar"
  | "boolean"
  | "uuid"
  | "timestamptz"
  | "numeric"
  | "jsonb"
  | "identity"
  | "enum"
  | "domain";

/** One column in the authored schema. */
export type ColumnModel = {
  readonly key: string;
  readonly name: string;
  readonly type: ColumnTypeKind;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly defaultKind: "none" | "constant" | "expression";
  readonly defaultValue?: string;
  readonly generated?: string;
  readonly picklist?: readonly string[];
  readonly check?: string;
  readonly renamedFrom?: string;
  readonly enumName?: string;
  readonly enumLabels?: readonly string[];
  readonly domainName?: string;
  readonly domainCheck?: string;
  readonly references?: {
    readonly table: string;
    readonly onDelete?: FkAction;
    readonly onUpdate?: FkAction;
  };
};

/** One index declaration. */
export type IndexModel = {
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly partial?: string;
  /** Extension using: gin via pg_trgm when true. */
  readonly usingTrgm: boolean;
};

/** One table declaration. */
export type TableModel = {
  readonly key: string;
  readonly name: string;
  readonly renamedFrom?: string;
  readonly columns: readonly ColumnModel[];
  readonly indexes: readonly IndexModel[];
  readonly checks: readonly { readonly name: string; readonly expression: string }[];
  readonly archive: boolean;
  readonly versioned: boolean;
};

/** Trigger WHEN + timing. */
export type TriggerModel = {
  readonly name: string;
  readonly tableKey: string;
  readonly when?: string;
};

/** Simple projection view. */
export type ViewModel = {
  readonly name: string;
  readonly tableKey: string;
  readonly columns: readonly string[];
};

/**
 * SQL spelling of an authored name under the schema's casing.
 *
 * Omitted casing keeps the name. `snake` uses the same fold as `schema()`.
 *
 * @param casing - Schema casing
 * @param name - Name passed to `table()` or a column field
 * @returns The name stored in the catalog
 */
export function sqlName(casing: "omit" | "snake", name: string): string {
  return casing === "snake" ? caseName("snake", name) : name;
}

/** Full authored schema at one step. */
export type SchemaModel = {
  readonly casing: "omit" | "snake";
  readonly namespace?: string;
  readonly tenancy: boolean;
  readonly trgm: boolean;
  readonly tables: readonly TableModel[];
  readonly triggers: readonly TriggerModel[];
  readonly views: readonly ViewModel[];
};

/** One evolution applied after the initial schema. */
export type Evolution =
  | { readonly kind: "addColumn"; readonly tableKey: string; readonly column: ColumnModel }
  | { readonly kind: "dropColumn"; readonly tableKey: string; readonly columnKey: string }
  | {
      readonly kind: "renameColumn";
      readonly tableKey: string;
      readonly columnKey: string;
      readonly nextName: string;
    }
  | {
      readonly kind: "retypeColumn";
      readonly tableKey: string;
      readonly columnKey: string;
      readonly nextType: "text" | "varchar";
    }
  | { readonly kind: "addTable"; readonly table: TableModel }
  | { readonly kind: "dropTable"; readonly tableKey: string }
  | { readonly kind: "renameTable"; readonly tableKey: string; readonly nextName: string }
  | {
      readonly kind: "addEnumValue";
      readonly tableKey: string;
      readonly columnKey: string;
      readonly value: string;
    }
  | { readonly kind: "addIndex"; readonly tableKey: string; readonly index: IndexModel }
  | { readonly kind: "dropIndex"; readonly tableKey: string; readonly indexIndex: number }
  | {
      readonly kind: "addCheck";
      readonly tableKey: string;
      readonly name: string;
      readonly expression: string;
    }
  | {
      readonly kind: "addPicklist";
      readonly tableKey: string;
      readonly columnKey: string;
      readonly values: readonly string[];
    }
  | { readonly kind: "addTrigger"; readonly trigger: TriggerModel }
  | { readonly kind: "addView"; readonly view: ViewModel }
  | {
      readonly kind: "addFk";
      readonly tableKey: string;
      readonly columnKey: string;
      readonly target: string;
      readonly onDelete: FkAction;
      readonly onUpdate: FkAction;
    };

/** One property case: initial schema, evolutions, and run mode. */
export type LifecycleCase = {
  readonly initial: SchemaModel;
  readonly evolutions: readonly Evolution[];
  /** Insert a row into each table after the first apply. */
  readonly withRows: boolean;
  /** Feature tags used for known-bug matching and coverage. */
  readonly tags: readonly string[];
};

/**
 * Collects feature tags from a schema and its evolutions.
 *
 * @param initial - Starting schema
 * @param evolutions - Later steps
 * @param withRows - Whether the case seeds rows
 * @returns Deduplicated tags
 */
export function tagsFor(
  initial: SchemaModel,
  evolutions: readonly Evolution[],
  withRows: boolean,
): readonly string[] {
  const tags = new Set<string>();
  if (withRows) tags.add("with-rows");
  if (initial.casing === "snake") tags.add("casing-snake");
  else tags.add("casing-omit");
  if (initial.namespace !== undefined) tags.add("namespace");
  if (initial.tenancy) tags.add("tenancy");
  if (initial.trgm) tags.add("index-using");
  for (const table of initial.tables) {
    tagName(table.name, tags);
    if (table.archive) tags.add("archive");
    if (table.versioned) tags.add("versioned");
    if (table.checks.length > 0) tags.add("checks");
    for (const column of table.columns) {
      tagName(column.name, tags);
      tags.add("column-types");
      if (column.nullable) tags.add("nullable");
      if (column.defaultKind === "constant") tags.add("default-constant");
      if (column.defaultKind === "expression") tags.add("default-expression");
      if (column.generated !== undefined) tags.add("generated");
      if (column.unique) tags.add("unique");
      if (column.picklist !== undefined) tags.add("picklist");
      if (column.check !== undefined) tags.add("checks");
      if (column.type === "enum") tags.add("enum");
      if (column.type === "domain") tags.add("domain");
      if (column.type === "identity") tags.add("identity");
      if (column.references !== undefined) {
        tags.add("fk");
        if (
          column.references.onDelete === "no action" ||
          column.references.onUpdate === "no action"
        ) {
          tags.add("fk-no-action");
        }
      }
    }
    for (const index of table.indexes) {
      if (index.columns.length === 1) tags.add("index-single");
      if (index.columns.length > 1) tags.add("index-multi");
      if (index.partial !== undefined) tags.add("index-partial");
      if (index.unique) tags.add("index-unique");
      if (index.usingTrgm) tags.add("index-using");
    }
  }
  for (const trigger of initial.triggers) {
    tags.add("trigger");
    if (trigger.when !== undefined) tags.add("trigger-when");
  }
  if (initial.views.length > 0) tags.add("view");
  for (const step of evolutions) {
    tags.add("add");
    switch (step.kind) {
      case "dropColumn":
      case "dropTable":
      case "dropIndex":
        tags.add("drop");
        break;
      case "renameColumn":
      case "renameTable":
        tags.add(step.kind === "renameTable" ? "rename-table" : "rename-column");
        break;
      case "retypeColumn":
        tags.add("retype");
        break;
      case "addEnumValue":
        tags.add("enum-add-value");
        break;
      case "addFk":
        tags.add("fk");
        if (step.onDelete === "no action" || step.onUpdate === "no action")
          tags.add("fk-no-action");
        break;
      case "addTrigger":
        tags.add("trigger");
        if (step.trigger.when !== undefined) tags.add("trigger-when");
        break;
      case "addView":
        tags.add("view");
        break;
      default:
        break;
    }
  }
  if (
    evolutions.some((step) => step.kind === "dropColumn") &&
    evolutions.some((step) => step.kind === "addIndex")
  ) {
    tags.add("index-drop-while-create");
  }
  if (
    evolutions.some((step) => step.kind === "renameTable") &&
    initial.tables.some((table) => table.columns.some((column) => column.type === "identity"))
  ) {
    tags.add("identity-rename");
  }
  return [...tags].sort();
}

function tagName(name: string, tags: Set<string>): void {
  if (/[A-Z]/.test(name) && /[a-z]/.test(name)) tags.add("mixed-case-name");
  if (/\d/.test(name)) tags.add("digit-name");
  if (/\s/.test(name)) tags.add("space-name");
  if (name.includes('"') || name.includes("'")) tags.add("quote-name");
}
