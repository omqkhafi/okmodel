/**
 * `schema()` compiles tables into one catalog.
 *
 * Work happens here, not in `table()` and not at import.
 */

import { catalogError, throwNamed } from "../../contracts/error.js";
import { catalog } from "../../contracts/catalog/build.js";
import { enumType, sameEnumLabels } from "../../contracts/catalog/enum.js";
import { staticNamespace } from "../../contracts/catalog/identity.js";
import {
  assertIdentifier,
  assertStoredText,
  fitIdentifier,
} from "../../contracts/catalog/identifier.js";
import {
  compareText,
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
import { ColumnBuilder, formatType, type ReferenceModifier } from "./column.js";
import { type ColumnModel, type RelationModel, type TableModel } from "./model.js";
import { definition, unavailable } from "./misuse.js";
import { isRelationCall } from "./relations.js";
import { decodeText } from "./text.js";
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
  /** Query model. Built once, beside the catalog document. */
  readonly model: { readonly [T in TTables[number] as T["~name"]]: TableModel };
};

const SCHEMA_KNOWN = new Set(["casing", "codecs", "requires", "tables", "types"]);

/** Later schema options, and the version that adds each one. */
const SCHEMA_LATER: Readonly<Record<string, string>> = {
  extensions: "0.3",
  functions: "0.3",
  tenancy: "0.2",
  traits: "0.2",
  triggers: "0.3",
  validation: "0.2",
  views: "0.3",
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
    readonly encode: (value: unknown) => string;
    readonly decode: (wire: string) => unknown;
    readonly omitWrite: boolean;
  };
};

type PreparedColumn = {
  readonly field: string;
  readonly sqlName: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly references: ReferenceModifier | undefined;
  readonly encode: (value: unknown) => string;
  readonly decode: ((wire: string) => unknown) | undefined;
  readonly hidden: boolean;
  readonly guarded: boolean;
  readonly writable: boolean;
  readonly unique: boolean;
};

/** Fills catalog objects on the first `.catalog` read. `schema()` itself does not. */
type CatalogJob = (objects: CatalogObject[]) => void;

/**
 * Runs `build` when `.catalog` is read.
 *
 * @param jobs - Work deferred from `schema()`
 * @param build - One catalog object
 */
function stage(jobs: CatalogJob[], build: () => CatalogObject): void {
  jobs.push((objects) => {
    objects.push(build());
  });
}

type FkEdge = {
  readonly fromTable: string;
  readonly fromField: string;
  readonly fromSql: string;
  readonly toTable: string;
  readonly toSql: string;
};

type Prepared = {
  readonly tsName: string;
  readonly sqlName: string;
  readonly parent: ObjectRef;
  readonly provenance: Provenance;
  readonly columns: readonly PreparedColumn[];
  readonly primary: readonly string[];
  readonly uniques: readonly (readonly string[])[];
  readonly byField: ReadonlyMap<string, PreparedColumn>;
  readonly bySql: ReadonlyMap<string, PreparedColumn>;
  readonly relationOptions: unknown;
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
  const jobs: CatalogJob[] = [];
  const prepared: Prepared[] = [];
  const sqlNames = new Set<string>();
  const enums = new Map<string, EnumNote>();

  for (const item of config.tables) {
    const built = compileTable(item, namespace, casing, codecs, jobs, enums);
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
  const edges: FkEdge[] = [];
  for (const item of prepared) {
    compileForeignKeys(item, byName, accepted, jobs, edges);
  }
  const model = {} as Record<string, TableModel>;
  for (const item of prepared) {
    model[item.tsName] = tableModel(item, edges, byName, accepted);
  }

  // Catalog objects, enum types, and the cycle check run on first read.
  // Import pays for the query model only (D138).
  let document: Catalog | undefined;
  return {
    get catalog(): Catalog {
      if (document === undefined) {
        const objects: CatalogObject[] = [];
        for (const job of jobs) job(objects);
        for (const [name, note] of [...enums.entries()].sort((left, right) =>
          compareText(left[0], right[0]),
        )) {
          objects.push(
            enumType({
              namespace,
              name,
              labels: note.labels,
              provenance: note.provenance,
            }),
          );
        }
        document = catalog(objects);
      }
      return document;
    },
    types,
    casing,
    codecs,
    requires,
    tables: config.tables,
    model,
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

type EnumNote = {
  readonly labels: readonly string[];
  readonly table: string;
  readonly provenance: Provenance;
};

function noteEnum(
  notes: Map<string, EnumNote>,
  labels: readonly string[],
  name: string,
  table: string,
  provenance: Provenance,
): void {
  const previous = notes.get(name);
  if (previous !== undefined && !sameEnumLabels(previous.labels, labels)) {
    catalogError(
      "OKM1020",
      `Enum ${name} lists ${previous.labels.join(", ")} on ${previous.table} and ${labels.join(", ")} on ${table}. One enum has one label list.`,
    );
  }
  if (previous === undefined || compareText(table, previous.table) < 0) {
    notes.set(name, { labels, table, provenance });
  }
}

function compileTable(
  item: AnyTable,
  namespace: ReturnType<typeof staticNamespace>,
  casing: "snake" | undefined,
  codecs: SchemaCodecs,
  jobs: CatalogJob[],
  enums: Map<string, EnumNote>,
): Prepared {
  const options = item.options as StoredOptions | undefined;
  readTableNames(item.name, options);
  const sqlName = options?.sqlName ?? (casing === "snake" ? snakeCase(item.name) : item.name);
  assertIdentifier(sqlName, `table ${item.name}`);
  const provenance: Provenance = { origin: "file", name: item.name };
  const parent: ObjectRef = { namespace, name: sqlName };
  stage(jobs, () => catalogTable({ namespace, name: sqlName, provenance }));

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
    if (identity !== undefined) {
      const seqName = fitIdentifier(`${sqlName}_${columnSql}_seq`);
      jobs.push((objects) => {
        const seq = sequence({
          namespace,
          name: seqName,
          dataType: "bigint",
          provenance,
          dependencies: [{ kind: "table", namespace, name: sqlName }],
        });
        objects.push(seq);
        pushCompiled(objects, column, {
          parent,
          name: columnSql,
          provenance,
          dependencies: [seq.identity],
        });
      });
    } else {
      jobs.push((objects) => {
        pushCompiled(objects, column, { parent, name: columnSql, provenance });
      });
    }
    const decode = column.state.decode;
    const prepared: PreparedColumn = {
      field,
      sqlName: columnSql,
      dataType: formatType(column.state.baseType, column.state.dims),
      nullable: column.state.nullable,
      references: column.state.references,
      encode: column.state.encode as (value: unknown) => string,
      decode: decode === decodeText ? undefined : (decode as (wire: string) => unknown),
      hidden: column.state.hidden,
      guarded: column.state.guarded,
      writable:
        column.state.guarded !== true &&
        column.state.omitWrite !== true &&
        column.state.generated === undefined,
      unique: column.state.unique !== undefined,
    };
    columns.push(prepared);
    byField.set(field, prepared);
    bySql.set(prepared.sqlName, prepared);
    handles[field] = { name: prepared.sqlName };
    if (column.state.primaryKey) {
      primary.push(prepared.sqlName);
    }
    const labels = column.state.enumLabels;
    if (labels !== undefined) {
      noteEnum(enums, labels, column.state.typeDependency ?? prepared.sqlName, sqlName, provenance);
    }
  }

  if (primary.length > 1) {
    catalogError(
      "OKM1020",
      `Table ${item.name} has more than one primary key (${primary.join(", ")}). One primary key is accepted.`,
    );
  }
  if (primary.length === 1) {
    stage(jobs, () =>
      constraint({
        parent,
        constraintKind: "primaryKey",
        columns: primary,
        provenance,
      }),
    );
  }

  if (options?.unique !== undefined) {
    compileUniques(item.name, options, parent, provenance, byField, jobs);
  }
  if (options?.indexes !== undefined) {
    compileIndexes(item.name, options, handles, parent, provenance, jobs);
  }
  if (options?.checks !== undefined) {
    compileChecks(item.name, options, handles, parent, provenance, byField, jobs);
  }

  return {
    tsName: item.name,
    sqlName,
    parent,
    provenance,
    columns,
    primary,
    uniques: uniqueTargets(primary, columns, bySql, options),
    byField,
    bySql,
    relationOptions: relationInput(item.name, options),
  };
}

function uniqueTargets(
  primary: readonly string[],
  columns: readonly PreparedColumn[],
  bySql: ReadonlyMap<string, PreparedColumn>,
  options: StoredOptions | undefined,
): readonly (readonly string[])[] {
  const uniques: string[][] = [];
  if (primary.length > 0) {
    const fields: string[] = [];
    for (const sqlName of primary) {
      const column = bySql.get(sqlName);
      if (column !== undefined) fields.push(column.field);
    }
    if (fields.length > 0) uniques.push(fields);
  }
  for (const column of columns) {
    if (column.unique) uniques.push([column.field]);
  }
  const named = options?.unique;
  if (named !== undefined) {
    for (const fields of Object.values(named)) uniques.push([...fields]);
  }
  return uniques;
}

function relationInput(tableName: string, options: StoredOptions | undefined): unknown {
  const relations = (options as { readonly relations?: unknown } | undefined)?.relations;
  if (relations === undefined) return undefined;
  if (typeof relations !== "object" || relations === null || Array.isArray(relations)) {
    definition(`Table ${tableName} relations must be an object of one() and many() calls.`);
  }
  return relations;
}

function pushCompiled(
  objects: CatalogObject[],
  column: ColumnView,
  input: {
    readonly parent: ObjectRef;
    readonly name: string;
    readonly provenance: Provenance;
    readonly dependencies?: readonly ObjectIdentity[];
  },
): void {
  const compiled = compileColumn(column, input);
  objects.push(compiled.column);
  if (compiled.check !== undefined) objects.push(compiled.check);
  if (compiled.unique !== undefined) objects.push(compiled.unique);
}

function compileUniques(
  tableName: string,
  options: StoredOptions | undefined,
  parent: ObjectRef,
  provenance: Provenance,
  byField: ReadonlyMap<string, PreparedColumn>,
  jobs: CatalogJob[],
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
    stage(jobs, () =>
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
  jobs: CatalogJob[],
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
    stage(jobs, () =>
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
  jobs: CatalogJob[],
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
    stage(jobs, () =>
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
  jobs: CatalogJob[],
  edges: FkEdge[],
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
    stage(jobs, () =>
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
    edges.push({
      fromTable: item.tsName,
      fromField: column.field,
      fromSql: column.sqlName,
      toTable: target.tsName,
      toSql: remote.sqlName,
    });
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

function tableModel(
  item: Prepared,
  edges: readonly FkEdge[],
  byName: ReadonlyMap<string, Prepared>,
  accepted: readonly string[],
): TableModel {
  const columns: ColumnModel[] = item.columns.map((column) => ({
    field: column.field,
    sql: column.sqlName,
    dataType: column.dataType,
    encode: column.encode,
    decode: column.decode,
    hidden: column.hidden,
    guarded: column.guarded,
    writable: column.writable,
  }));
  const primary: string[] = [];
  for (const sqlName of item.primary) {
    const column = item.bySql.get(sqlName);
    if (column !== undefined) primary.push(column.field);
  }
  return {
    name: item.tsName,
    sql: item.sqlName,
    primary,
    uniques: item.uniques,
    columns,
    relations: resolveRelations(item, edges, byName, accepted),
  };
}

function resolveRelations(
  item: Prepared,
  edges: readonly FkEdge[],
  byName: ReadonlyMap<string, Prepared>,
  accepted: readonly string[],
): readonly RelationModel[] {
  const raw = item.relationOptions;
  if (raw === undefined) return [];
  const record = raw as Record<string, unknown>;
  const names = Object.keys(record);
  const resolved: RelationModel[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const call = record[name];
    if (!isRelationCall(call)) {
      unavailable(
        `Table ${item.tsName} relation ${name} is not available yet. one() and many() are accepted. manyThrough and morph arrive later.`,
      );
    }
    if (!byName.has(call.table)) {
      throwNamed(
        "OKM1020",
        call.table,
        accepted,
        `Relation ${item.tsName}.${name} names ${call.table}, which is not in the schema. Accepted names: ${list(accepted)}.`,
      );
    }
    const field = call.field;
    const matches =
      call.kind === "one"
        ? edges.filter(
            (edge) =>
              edge.fromTable === item.tsName &&
              edge.toTable === call.table &&
              (field === undefined || edge.fromField === field),
          )
        : edges.filter(
            (edge) =>
              edge.toTable === item.tsName &&
              edge.fromTable === call.table &&
              (field === undefined || edge.fromField === field),
          );
    if (matches.length !== 1) {
      const hint = matches.map((edge) => edge.fromField).sort();
      const which = hint.length === 0 ? "none" : hint.join(", ");
      catalogError(
        "OKM1021",
        `Relation ${item.tsName}.${name} on ${call.table} is ambiguous. Accepted columns: ${which}.`,
      );
    }
    const edge = matches[0];
    if (edge === undefined) {
      catalogError(
        "OKM1021",
        `Relation ${item.tsName}.${name} on ${call.table} is ambiguous. Accepted columns: (none).`,
      );
    }
    resolved.push(
      call.kind === "one"
        ? { name, kind: "one", table: call.table, local: [edge.fromSql], remote: [edge.toSql] }
        : { name, kind: "many", table: call.table, local: [edge.toSql], remote: [edge.fromSql] },
    );
  }
  return resolved;
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
