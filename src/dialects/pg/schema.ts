/**
 * `schema()` compiles tables into one catalog.
 *
 * Work happens here, not in `table()` and not at import.
 */

import { catalogError, throwNamed } from "../../contracts/error.js";
import { catalog } from "../../contracts/catalog/build.js";
import { staticNamespace } from "../../contracts/catalog/identity.js";
import {
  assertIdentifier,
  assertStoredText,
  fitIdentifier,
} from "../../contracts/catalog/identifier.js";
import {
  constraint,
  index as catalogIndex,
  sequence,
  table as catalogTable,
} from "../../contracts/catalog/object.js";
import type {
  Catalog,
  CatalogObject,
  ObjectIdentity,
  ObjectRef,
  Provenance,
} from "../../contracts/catalog/types.js";
import { compileColumn, type CompilableColumn } from "./compile.js";
import { ColumnBuilder, type ReferenceModifier } from "./column.js";
import { definition } from "./misuse.js";
import {
  type AnyTable,
  type ColumnHandle,
  type IndexCall,
  type SqlText,
  emittedTypeName,
  rejectLater,
  snakeCase,
} from "./table.js";

/** Codec defaults from spec section 6.6. */
export type SchemaCodecs = {
  readonly bigint: "string" | "number" | "bigint";
  readonly numeric: "string" | "number";
  readonly timestamps: "temporal";
};

/** Engine requirement recorded for connect. */
export type SchemaRequires = {
  readonly postgres?: string;
};

/**
 * Input for {@link schema}.
 *
 * Later keys are part of the type and rejected when present.
 *
 * @typeParam TTables - Tables in declaration order
 */
export type SchemaInput<TTables extends readonly AnyTable[]> = {
  readonly tables: TTables;
  readonly requires?: SchemaRequires;
  readonly casing?: "snake";
  readonly codecs?: {
    readonly bigint?: SchemaCodecs["bigint"];
    readonly numeric?: SchemaCodecs["numeric"];
    readonly timestamps?: SchemaCodecs["timestamps"];
  };
  readonly types?: "emitted" | "inferred";
  readonly traits?: unknown;
  readonly tenancy?: unknown;
  readonly validation?: unknown;
  readonly extensions?: unknown;
  readonly functions?: unknown;
  readonly triggers?: unknown;
  readonly views?: unknown;
};

/**
 * A compiled schema.
 *
 * `~byName` is what `Row`, `Insert`, and `Update` index. `catalog` is the
 * document `catalogHash` and `serializeCatalog` accept.
 *
 * @typeParam TTables - Tables in declaration order
 */
export type BuiltSchema<TTables extends readonly AnyTable[]> = {
  readonly "~byName": {
    readonly [T in TTables[number] as T["~name"]]: T;
  };
  readonly catalog: Catalog;
  readonly types: "emitted" | "inferred";
  readonly casing: "snake" | undefined;
  readonly codecs: SchemaCodecs;
  readonly requires: SchemaRequires | undefined;
  readonly tables: TTables;
};

const SCHEMA_KNOWN = new Set(["casing", "codecs", "requires", "tables", "types"]);

/** Later schema options, and the prompt that adds each one. */
const SCHEMA_LATER: Readonly<Record<string, string>> = {
  extensions: "P40",
  functions: "P41",
  tenancy: "P24",
  traits: "P23",
  triggers: "P41",
  validation: "P26",
  views: "P42",
};

const BIGINT_CODECS = new Set(["string", "number", "bigint"]);
const NUMERIC_CODECS = new Set(["string", "number"]);

/** Options `table()` may have stored. Not the generic handles map. */
type StoredOptions = {
  readonly sqlName?: string;
  readonly renamedFrom?: string;
  readonly comment?: string;
  readonly unique?: Readonly<Record<string, readonly string[]>>;
  readonly indexes?: (columns: Readonly<Record<string, ColumnHandle>>) => readonly IndexCall[];
  readonly checks?: Readonly<
    Record<string, (columns: Readonly<Record<string, ColumnHandle>>) => SqlText>
  >;
};

/** Fields `schema()` reads from a column. Avoids instantiating {@link ColumnBuilder}. */
type ColumnView = CompilableColumn & {
  readonly state: CompilableColumn["state"] & {
    readonly primaryKey: boolean;
    readonly typeLabel: string | undefined;
    readonly references: ReferenceModifier | undefined;
  };
};

type PreparedColumn = {
  readonly field: string;
  readonly sqlName: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly references: ReferenceModifier | undefined;
};

type Prepared = {
  readonly tsName: string;
  readonly sqlName: string;
  readonly parent: ObjectRef;
  readonly provenance: Provenance;
  readonly columns: readonly PreparedColumn[];
  readonly primary: readonly string[];
  readonly byField: ReadonlyMap<string, PreparedColumn>;
  readonly bySql: ReadonlyMap<string, PreparedColumn>;
};

/**
 * Compiles tables into a catalog.
 *
 * Names, dependencies, and provenance are fixed here. Calling it twice on
 * the same tables returns equal catalog bytes.
 *
 * @typeParam TTables - Tables in declaration order
 * @param config - Tables, casing, codecs, and the row-type mode
 * @returns The schema and its catalog
 */
export function schema<const TTables extends readonly AnyTable[]>(
  config: SchemaInput<TTables>,
): BuiltSchema<TTables> {
  rejectLater(config, SCHEMA_KNOWN, SCHEMA_LATER, "schema()");
  if (!Array.isArray(config.tables)) {
    definition("schema() needs a tables array.");
  }
  const types = readTypes(config.types);
  const casing = readCasing(config.casing);
  const codecs = readCodecs(config.codecs);
  const requires = readRequires(config.requires);
  const namespace = staticNamespace("public");
  const accepted = acceptTables(config.tables);
  const objects: CatalogObject[] = [];
  const prepared: Prepared[] = [];
  const sqlNames = new Set<string>();

  for (const item of config.tables) {
    const built = compileTable(item, namespace, casing, codecs, objects);
    if (sqlNames.has(built.sqlName)) {
      catalogError(
        "OKM1023",
        `Table ${built.tsName} uses SQL name ${built.sqlName}, which another table already uses. Accepted names: ${list(accepted)}.`,
      );
    }
    sqlNames.add(built.sqlName);
    prepared.push(built);
  }
  const byName = new Map<string, Prepared>();
  for (const item of prepared) {
    byName.set(item.tsName, item);
  }
  for (const item of prepared) {
    compileForeignKeys(item, byName, accepted, objects);
  }

  return {
    catalog: catalog(objects),
    types,
    casing,
    codecs,
    requires,
    tables: config.tables,
  } as unknown as BuiltSchema<TTables>;
}

function acceptTables(tables: readonly AnyTable[]): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const emitted = new Map<string, string>();
  for (const item of tables) {
    if (typeof item.name !== "string" || item.name.length === 0) {
      definition("schema() tables need a name.");
    }
    if (seen.has(item.name)) {
      catalogError(
        "OKM1023",
        `Table ${item.name} is declared more than once. Accepted names: ${list([...names].sort())}.`,
      );
    }
    seen.add(item.name);
    names.push(item.name);
    const typeName = emittedTypeName(item.name);
    const previous = emitted.get(typeName);
    if (previous !== undefined) {
      catalogError(
        "OKM1023",
        `Table ${item.name} and ${previous} both emit ${typeName}. Accepted names: ${list([...names].sort())}.`,
      );
    }
    emitted.set(typeName, item.name);
  }
  names.sort();
  return names;
}

function compileTable(
  item: AnyTable,
  namespace: ReturnType<typeof staticNamespace>,
  casing: "snake" | undefined,
  codecs: SchemaCodecs,
  objects: CatalogObject[],
): Prepared {
  const options = item.options as StoredOptions | undefined;
  readTableNames(item.name, options);
  const sqlName = options?.sqlName ?? (casing === "snake" ? snakeCase(item.name) : item.name);
  assertIdentifier(sqlName, `table ${item.name}`);
  const provenance: Provenance = { origin: "file", name: item.name };
  const parent: ObjectRef = { namespace, name: sqlName };
  objects.push(catalogTable({ namespace, name: sqlName, provenance }));

  const columns: PreparedColumn[] = [];
  const primary: string[] = [];
  const byField = new Map<string, PreparedColumn>();
  const bySql = new Map<string, PreparedColumn>();
  const handles: Record<string, ColumnHandle> = {};

  for (const [field, builder] of Object.entries(item.columns)) {
    if (!(builder instanceof ColumnBuilder)) {
      definition(`Column ${item.name}.${field} must be a column builder.`);
    }
    const column = builder as unknown as ColumnView;
    const columnSql = column.state.sqlName ?? (casing === "snake" ? snakeCase(field) : field);
    assertCodec(item.name, field, column, codecs);
    const identity = column.state.identity;
    const extra: ObjectIdentity[] = [];
    if (identity !== undefined) {
      const seqName = fitIdentifier(`${sqlName}_${columnSql}_seq`);
      const seq = sequence({
        namespace,
        name: seqName,
        dataType: "bigint",
        provenance,
        dependencies: [{ kind: "table", namespace, name: sqlName }],
      });
      objects.push(seq);
      extra.push(seq.identity);
    }
    const compiled = compileColumn(column, {
      parent,
      name: columnSql,
      provenance,
      ...(extra.length > 0 ? { dependencies: extra } : {}),
    });
    objects.push(compiled.column);
    if (compiled.check !== undefined) {
      objects.push(compiled.check);
    }
    if (compiled.unique !== undefined) {
      objects.push(compiled.unique);
    }
    const prepared: PreparedColumn = {
      field,
      sqlName: compiled.column.identity.name,
      dataType: compiled.column.definition.dataType,
      nullable: compiled.column.definition.nullable,
      references: column.state.references,
    };
    columns.push(prepared);
    byField.set(field, prepared);
    bySql.set(prepared.sqlName, prepared);
    handles[field] = { name: prepared.sqlName };
    if (column.state.primaryKey) {
      primary.push(prepared.sqlName);
    }
  }

  if (primary.length > 1) {
    catalogError(
      "OKM1020",
      `Table ${item.name} has more than one primary key (${primary.join(", ")}). One primary key is accepted.`,
    );
  }
  if (primary.length === 1) {
    objects.push(
      constraint({
        parent,
        constraintKind: "primaryKey",
        columns: primary,
        provenance,
      }),
    );
  }

  if (options?.unique !== undefined) {
    compileUniques(item.name, options, parent, provenance, byField, objects);
  }
  if (options?.indexes !== undefined) {
    compileIndexes(item.name, options, handles, parent, provenance, objects);
  }
  if (options?.checks !== undefined) {
    compileChecks(item.name, options, handles, parent, provenance, byField, objects);
  }

  return {
    tsName: item.name,
    sqlName,
    parent,
    provenance,
    columns,
    primary,
    byField,
    bySql,
  };
}

function compileUniques(
  tableName: string,
  options: StoredOptions | undefined,
  parent: ObjectRef,
  provenance: Provenance,
  byField: ReadonlyMap<string, PreparedColumn>,
  objects: CatalogObject[],
): void {
  const unique = options?.unique;
  if (unique === undefined) {
    return;
  }
  const accepted = [...byField.keys()].sort();
  for (const [name, fields] of Object.entries(unique)) {
    if (fields.length === 0) {
      definition(`Unique ${tableName}.${name} needs a column.`);
    }
    const columns: string[] = [];
    for (const field of fields) {
      const column = byField.get(field);
      if (column === undefined) {
        throwNamed(
          "OKM1020",
          field,
          accepted,
          `Unique ${tableName}.${name} names ${field}, which is not a column of ${tableName}. Accepted names: ${list(accepted)}.`,
        );
      }
      columns.push(column.sqlName);
    }
    objects.push(
      constraint({
        parent,
        constraintKind: "unique",
        columns,
        nameKey: name,
        provenance,
      }),
    );
  }
}

function compileIndexes(
  tableName: string,
  options: StoredOptions | undefined,
  handles: Readonly<Record<string, ColumnHandle>>,
  parent: ObjectRef,
  provenance: Provenance,
  objects: CatalogObject[],
): void {
  const build = options?.indexes;
  if (build === undefined) {
    return;
  }
  const calls = build(handles);
  if (!Array.isArray(calls)) {
    definition(`Table ${tableName} indexes must return an array.`);
  }
  for (const call of calls) {
    const built = readIndex(tableName, call);
    objects.push(
      catalogIndex({
        parent,
        columns: built.columns,
        unique: built.isUnique === true,
        nameKey: built.columns.join("_"),
        provenance,
      }),
    );
  }
}

function compileChecks(
  tableName: string,
  options: StoredOptions | undefined,
  handles: Readonly<Record<string, ColumnHandle>>,
  parent: ObjectRef,
  provenance: Provenance,
  byField: ReadonlyMap<string, PreparedColumn>,
  objects: CatalogObject[],
): void {
  const checks = options?.checks;
  if (checks === undefined) {
    return;
  }
  for (const [name, build] of Object.entries(checks)) {
    const used: string[] = [];
    const value = build(track(handles, used));
    const text = readCheck(tableName, name, value);
    const columns: string[] = [];
    for (const field of used) {
      const column = byField.get(field);
      if (column !== undefined) {
        columns.push(column.sqlName);
      }
    }
    objects.push(
      constraint({
        parent,
        constraintKind: "check",
        columns,
        nameKey: name,
        expression: text,
        provenance,
      }),
    );
  }
}

function compileForeignKeys(
  item: Prepared,
  byName: ReadonlyMap<string, Prepared>,
  accepted: readonly string[],
  objects: CatalogObject[],
): void {
  for (const column of item.columns) {
    const reference = column.references;
    if (reference === undefined) {
      continue;
    }
    const target = byName.get(reference.table);
    if (target === undefined) {
      throwNamed(
        "OKM1020",
        reference.table,
        accepted,
        `Table ${reference.table} is not in the schema. Accepted names: ${list(accepted)}.`,
      );
    }
    const targetColumns = resolveTarget(item, column, target, reference);
    if (reference.onDelete === "set null" || reference.onUpdate === "set null") {
      if (!column.nullable) {
        definition(
          `Foreign key ${item.tsName}.${column.field} uses set null. ${item.tsName}.${column.field} must be nullable.`,
        );
      }
    }
    const localType = column.dataType;
    const remote = targetColumns[0];
    if (remote === undefined || targetColumns.length !== 1) {
      const names = [...target.byField.keys()].sort();
      catalogError(
        "OKM1021",
        `Foreign key ${item.tsName}.${column.field} on ${target.tsName} is ambiguous. Accepted columns: ${list(names)}.`,
      );
    }
    if (localType !== remote.dataType) {
      catalogError(
        "OKM1022",
        `Foreign key ${item.tsName}.${column.field} is ${localType} and ${target.tsName}.${remote.field} is ${remote.dataType}. Accepted type: ${remote.dataType}.`,
      );
    }
    objects.push(
      constraint({
        parent: item.parent,
        constraintKind: "foreignKey",
        columns: [column.sqlName],
        nameKey: column.sqlName,
        provenance: item.provenance,
        references: {
          parent: target.parent,
          columns: [remote.sqlName],
          ...(reference.onDelete !== undefined ? { onDelete: reference.onDelete } : {}),
          ...(reference.onUpdate !== undefined ? { onUpdate: reference.onUpdate } : {}),
        },
      }),
    );
  }
}

function resolveTarget(
  item: Prepared,
  column: PreparedColumn,
  target: Prepared,
  reference: ReferenceModifier,
): readonly PreparedColumn[] {
  const accepted = [...target.byField.keys()].sort();
  const named = reference.columns;
  if (named !== undefined) {
    const found: PreparedColumn[] = [];
    for (const name of named) {
      const match = target.byField.get(name) ?? target.bySql.get(name);
      if (match === undefined) {
        throwNamed(
          "OKM1021",
          name,
          accepted,
          `Foreign key ${item.tsName}.${column.field} references ${name} on ${target.tsName}, which is not a column. Accepted columns: ${list(accepted)}.`,
        );
      }
      found.push(match);
    }
    if (found.length !== 1) {
      catalogError(
        "OKM1021",
        `Foreign key ${item.tsName}.${column.field} on ${target.tsName} is ambiguous. Accepted columns: ${list(accepted)}.`,
      );
    }
    return found;
  }
  if (target.primary.length === 0) {
    catalogError(
      "OKM1021",
      `Foreign key ${item.tsName}.${column.field} on ${target.tsName} has no primary key. Accepted columns: ${list(accepted)}.`,
    );
  }
  if (target.primary.length !== 1) {
    catalogError(
      "OKM1021",
      `Foreign key ${item.tsName}.${column.field} on ${target.tsName} is ambiguous. Accepted columns: ${list(target.primary)}.`,
    );
  }
  const sqlName = target.primary[0] ?? "";
  const match = target.bySql.get(sqlName);
  if (match === undefined) {
    catalogError(
      "OKM1021",
      `Foreign key ${item.tsName}.${column.field} on ${target.tsName} is missing its target. Accepted columns: ${list(accepted)}.`,
    );
  }
  return [match];
}

function assertCodec(
  tableName: string,
  field: string,
  builder: ColumnView,
  codecs: SchemaCodecs,
): void {
  const base = builder.state.baseType;
  if (base === "bigint" && codecs.bigint !== "string") {
    const label = builder.state.typeLabel ?? "string";
    if (label !== codecs.bigint) {
      definition(
        `Schema codecs.bigint is ${codecs.bigint}, and ${tableName}.${field} was built as ${label}. Set as: "${codecs.bigint}" on that column.`,
      );
    }
  }
  if (base.startsWith("numeric") && codecs.numeric !== "string") {
    const label = builder.state.typeLabel ?? "string";
    if (label !== codecs.numeric) {
      definition(
        `Schema codecs.numeric is ${codecs.numeric}, and ${tableName}.${field} was built as ${label}. Set as: "${codecs.numeric}" on that column.`,
      );
    }
  }
}

function readTableNames(tableName: string, options: StoredOptions | undefined): void {
  if (options?.sqlName !== undefined) {
    if (options.sqlName.length === 0) {
      definition(`Table ${tableName} sqlName must be a non-empty SQL identifier.`);
    }
    assertIdentifier(options.sqlName, `table ${tableName} sqlName`);
  }
  if (options?.renamedFrom !== undefined) {
    if (options.renamedFrom.length === 0) {
      definition(`Table ${tableName} renamedFrom must be a non-empty previous name.`);
    }
    assertIdentifier(options.renamedFrom, `table ${tableName} renamedFrom`);
  }
  if (options?.comment !== undefined) {
    assertStoredText(options.comment, `table ${tableName} comment`);
    if (options.comment.length === 0) {
      definition(`Table ${tableName} comment must be non-empty.`);
    }
  }
}

function readTypes(types: "emitted" | "inferred" | undefined): "emitted" | "inferred" {
  if (types === undefined) {
    return "emitted";
  }
  if (types !== "emitted" && types !== "inferred") {
    definition(`schema() types ${String(types)} must be emitted or inferred.`);
  }
  return types;
}

function readCasing(casing: "snake" | undefined): "snake" | undefined {
  if (casing === undefined) {
    return undefined;
  }
  if (casing !== "snake") {
    definition(`schema() casing ${String(casing)} must be snake.`);
  }
  return casing;
}

function readCodecs(codecs: SchemaInput<readonly AnyTable[]>["codecs"]): SchemaCodecs {
  const bigint = codecs?.bigint ?? "string";
  const numeric = codecs?.numeric ?? "string";
  const timestamps = codecs?.timestamps ?? "temporal";
  if (!BIGINT_CODECS.has(bigint)) {
    definition(`schema() codecs.bigint ${String(bigint)} must be string, number, or bigint.`);
  }
  if (!NUMERIC_CODECS.has(numeric)) {
    definition(`schema() codecs.numeric ${String(numeric)} must be string or number.`);
  }
  if (timestamps !== "temporal") {
    definition(`schema() codecs.timestamps ${String(timestamps)} must be temporal.`);
  }
  return { bigint, numeric, timestamps };
}

function readRequires(requires: SchemaRequires | undefined): SchemaRequires | undefined {
  if (requires === undefined) {
    return undefined;
  }
  const postgres = requires.postgres;
  if (postgres !== undefined && postgres.length === 0) {
    definition("schema() requires.postgres must be a version range such as >=17.");
  }
  return postgres === undefined ? {} : { postgres };
}

function readIndex(tableName: string, call: IndexCall): IndexCall {
  if (call.columns.length === 0) {
    definition(`Index on ${tableName} needs a column.`);
  }
  for (const name of call.columns) {
    if (typeof name !== "string" || name.length === 0) {
      definition(`Index on ${tableName} must be built from column handles.`);
    }
  }
  return call;
}

function readCheck(tableName: string, name: string, value: SqlText): string {
  if (value === undefined || typeof value.text !== "string" || value.text.length === 0) {
    definition(`Check ${tableName}.${name} must return sql text.`);
  }
  assertStoredText(value.text, `check ${tableName}.${name}`);
  return value.text;
}

function track(
  handles: Readonly<Record<string, ColumnHandle>>,
  used: string[],
): Readonly<Record<string, ColumnHandle>> {
  return new Proxy(handles, {
    get(target, key) {
      if (typeof key === "string" && Object.hasOwn(target, key)) {
        used.push(key);
        return target[key];
      }
      return undefined;
    },
  });
}

function list(names: readonly string[]): string {
  return names.length === 0 ? "(none)" : names.join(", ");
}
