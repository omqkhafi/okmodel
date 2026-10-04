/**
 * `schema()` compiles tables into one catalog.
 *
 * Work happens here, not in `table()` and not at import.
 */

import { OkmError, catalogError, throwNamed } from "../../contracts/error.js";
import { withLocation } from "../../contracts/location.js";
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
import {
  readClientGenerator,
  type ClientFill,
  type ClientGenerator,
} from "../../contracts/generator.js";
import { compileColumn, type CompilableColumn } from "./compile.js";
import { ColumnBuilder, formatType, type ColumnState, type ReferenceModifier } from "./column.js";
import {
  type ArchiveModel,
  type ColumnModel,
  type RelationModel,
  type SchemaHook,
  type TableModel,
} from "./model.js";
import { definition, unavailable } from "./misuse.js";
import { isRelationCall, type ManyThroughRelation, type RelationEdge } from "./relations.js";
import { decodeText, encodeText } from "./text.js";
import type { FieldsOfList, HasArchive, Trait, TraitModel } from "./trait.js";
import { type ColumnTenancy, type TenantFields, readTenancy } from "./tenancy.js";
import {
  type AnyTable,
  type ColumnHandle,
  type IndexCall,
  type InsertFrom,
  type RowFrom,
  type SqlText,
  type UpdateFrom,
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
  /**
   * What a bare `t.id()` means.
   *
   * `"uuidv7"` and `"uuidv4"` are database defaults. A client generator is
   * filled on insert and stays out of the catalog. A column option wins.
   */
  readonly defaults?: {
    readonly id?: "uuidv7" | "uuidv4" | ClientGenerator<string>;
  };
  /**
   * Traits applied to every table.
   *
   * A table opts out with `omitDefaults` and a reason. A table's own `traits`
   * are added as well.
   */
  readonly traits?: readonly Trait[];
  /**
   * Column tenancy.
   *
   * Every table gains the key unless it passes `global("reason")`.
   */
  readonly tenancy?: ColumnTenancy;
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
  /**
   * Schema traits, when the call passed a non-empty list.
   *
   * Omitted otherwise, so a schema that uses no traits does not carry the key.
   */
  readonly traits?: readonly Trait[];
  /**
   * Column tenancy, when the call passed it.
   *
   * Omitted otherwise, so a schema with no tenancy does not carry the key.
   */
  readonly tenancy?: ColumnTenancy;
  /** Query model. Built once, beside the catalog document. */
  readonly model: { readonly [T in TTables[number] as T["~name"]]: TableModel };
};

/**
 * A schema whose tenant tables carry the tenant key on the row.
 *
 * A table marked `~global` keeps its own type. No tenancy leaves the schema
 * type unchanged.
 *
 * @typeParam S - Schema type before tenancy
 * @typeParam TTables - Tables in declaration order
 * @typeParam TTenancy - Column tenancy, or `undefined`
 */
export type TenancySchema<
  S,
  TTables extends readonly AnyTable[],
  TTenancy,
> = TTenancy extends ColumnTenancy
  ? Omit<S, "~byName"> & {
      readonly tenancy: TTenancy;
      readonly "~byName": {
        readonly [T in TTables[number] as T["~name"]]: T extends { readonly "~global": string }
          ? T
          : T & {
              readonly "~row": RowFrom<TenantFields<TTenancy["key"]>>;
              readonly "~insert": InsertFrom<TenantFields<TTenancy["key"]>>;
              readonly "~update": UpdateFrom<TenantFields<TTenancy["key"]>>;
            };
      };
    }
  : S;

/**
 * A schema whose default traits are part of every table's row type.
 *
 * A table with `omitDefaults` keeps its own type. An empty trait list does not
 * change the schema type.
 *
 * @typeParam TTables - Tables in declaration order
 * @typeParam TTraits - Schema default traits
 */
export type SchemaWithTraits<
  TTables extends readonly AnyTable[],
  TTraits extends readonly { readonly fields: Readonly<Record<string, object>> }[],
> = keyof FieldsOfList<TTraits> extends never
  ? BuiltSchema<TTables>
  : Omit<BuiltSchema<TTables>, "~byName"> & {
      readonly "~byName": {
        readonly [T in TTables[number] as T["~name"]]: ApplySchemaTraits<
          T,
          FieldsOfList<TTraits>,
          TTraits
        >;
      };
    };

type ApplySchemaTraits<TTable, TFields, TTraits> = TTable extends {
  readonly "~omitDefaults": true;
}
  ? TTable
  : TTable & {
      readonly "~row": RowFrom<TFields>;
      readonly "~insert": InsertFrom<TFields>;
      readonly "~update": UpdateFrom<TFields>;
    } & HasArchive<TTraits>;

const SCHEMA_KNOWN = new Set([
  "casing",
  "codecs",
  "defaults",
  "requires",
  "tables",
  "tenancy",
  "traits",
  "types",
  "validation",
]);

/** Later schema options, and the version that adds each one. */
const SCHEMA_LATER: Readonly<Record<string, string>> = {
  extensions: "0.3",
  functions: "0.3",
  triggers: "0.3",
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
  readonly primaryKey?: readonly string[];
  readonly indexes?: (columns: Readonly<Record<string, ColumnHandle>>) => readonly IndexCall[];
  readonly checks?: Readonly<
    Record<string, (columns: Readonly<Record<string, ColumnHandle>>) => SqlText>
  >;
};

/** Fields `schema()` reads from a column. Avoids instantiating {@link ColumnBuilder}. */
type ColumnView = CompilableColumn & {
  readonly state: ColumnState<unknown>;
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
  readonly sensitive: boolean;
  readonly guarded: boolean;
  readonly writable: boolean;
  readonly unique: boolean;
  /** Catalog-output label. Set when insert fills the column. Not hashed. */
  readonly clientDefault: "client" | undefined;
  readonly fill: ClientFill | undefined;
  readonly elementEncode: ((value: unknown) => string) | undefined;
  readonly accepts: readonly string[] | undefined;
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

type FkEdge = RelationEdge;

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
  /**
   * Traits that apply to this table.
   *
   * Absent when it has none. The write path reads `touch` and `sealed` from
   * these objects, so that code stays out of startup.
   */
  readonly traits?: readonly Trait[];
  /** Set by `archivable()`. Absent on every other table. */
  readonly archive?: ArchiveModel;
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
export function schema<
  const TTables extends readonly AnyTable[],
  const TTraits extends readonly { readonly fields: Readonly<Record<string, object>> }[],
  const TTenancy extends ColumnTenancy | undefined = undefined,
  const TValidation = undefined,
>(
  config: Omit<SchemaInput<TTables>, "traits" | "tenancy" | "validation"> & {
    readonly traits: TTraits;
    readonly tenancy?: TTenancy;
    readonly validation?: TValidation;
  },
): [TValidation] extends [undefined]
  ? TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy>
  : TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy> & {
      readonly "~validation": TValidation;
    };
export function schema<
  const TTables extends readonly AnyTable[],
  const TTenancy extends ColumnTenancy | undefined = undefined,
  const TValidation = undefined,
>(
  config: Omit<SchemaInput<TTables>, "tenancy" | "validation"> & {
    readonly tenancy?: TTenancy;
    readonly validation?: TValidation;
  },
): [TValidation] extends [undefined]
  ? TenancySchema<BuiltSchema<TTables>, TTables, TTenancy>
  : TenancySchema<BuiltSchema<TTables>, TTables, TTenancy> & {
      readonly "~validation": TValidation;
    };
export function schema<const TTables extends readonly AnyTable[]>(
  config: SchemaInput<TTables>,
): BuiltSchema<TTables> {
  rejectLater(config, SCHEMA_KNOWN, SCHEMA_LATER, "schema()");
  const schemaTraits = openSchemaTraits(config.traits);
  const tenancy = readTenancy(config.tenancy);
  if (!Array.isArray(config.tables)) {
    definition("schema() needs a tables array.");
  }
  const casing = readCasing(config.casing);
  const tables = rewritePass(config.tables, tenancy, schemaTraits, casing);
  const hooks = collectHooks(tenancy, schemaTraits, config.tables);
  const types = readTypes(config.types);
  const codecs = readCodecs(config.codecs);
  const requires = readRequires(config.requires);
  const idDefault = readIdDefault(config.defaults);
  const namespace = staticNamespace("public");
  const accepted = acceptTables(config.tables);
  const jobs: CatalogJob[] = [];
  const prepared: Prepared[] = [];
  const sqlNames = new Set<string>();
  const enums = new Map<string, EnumNote>();

  for (const item of tables) {
    const built = compileTable(
      item,
      namespace,
      casing,
      codecs,
      requires,
      idDefault,
      jobs,
      enums,
      schemaTraits,
    );
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
    ...(schemaTraits !== undefined && schemaTraits.length > 0 ? { traits: schemaTraits } : {}),
    ...(tenancy !== undefined ? { tenancy } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(config.validation !== undefined ? { validation: config.validation } : {}),
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
        withLocation(
          `Table ${item.name} is declared more than once. Accepted names: ${list([...names].sort())}.`,
          item.source,
        ),
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

/**
 * Reads `schema({ traits })`.
 *
 * An omitted or empty list stays `undefined`, so the table loop does nothing.
 *
 * @param value - The option the caller passed
 * @returns The list, or `undefined`
 */
/**
 * Runs tenancy's rewrite, then any trait rewrite, once.
 *
 * Tenancy widens uniques first. A trait such as `archivable()` then rewrites
 * those uniques. A schema with neither leaves the tables unchanged.
 *
 * @param tables - Tables passed to `schema()`
 * @param tenancy - Column tenancy, when set
 * @param schemaTraits - Schema traits, when any were passed
 * @param casing - Schema casing
 * @returns Tables ready to compile
 */
function rewritePass(
  tables: readonly AnyTable[],
  tenancy: ColumnTenancy | undefined,
  schemaTraits: readonly Trait[] | undefined,
  casing: "snake" | undefined,
): readonly AnyTable[] {
  let next = tenancy === undefined ? bareTables(tables) : tenancy.rewrite(tables);
  const seen = new Set<object>();
  const pending: object[] = [];
  const add = (value: object): void => {
    if (seen.has(value)) return;
    if (typeof (value as { readonly rewrite?: unknown }).rewrite !== "function") return;
    seen.add(value);
    pending.push(value);
  };
  if (schemaTraits !== undefined) {
    for (const trait of schemaTraits) add(trait);
  }
  for (const item of tables) {
    const own = (item.options as { readonly traits?: unknown } | undefined)?.traits;
    if (!Array.isArray(own)) continue;
    for (const trait of own) {
      if (typeof trait === "object" && trait !== null) add(trait);
    }
  }
  for (const trait of pending) {
    const rewrite = (
      trait as {
        rewrite: (
          this: object,
          tables: readonly AnyTable[],
          casing: "snake" | undefined,
          schemaTraits: readonly Trait[] | undefined,
        ) => readonly AnyTable[];
      }
    ).rewrite;
    next = rewrite.call(trait, next, casing, schemaTraits);
  }
  return next;
}

const registeredHooks: SchemaHook[] = [];

/**
 * Registers a hook from an opt-in module.
 *
 * Core does not import that module. A featureless app never calls this, so
 * the module that loads the validation engine stays out of its graph.
 *
 * @param hook - Called for the client and for each table
 */
export function addSchemaHook(hook: SchemaHook): void {
  registeredHooks.push(hook);
}

/**
 * Collects client and table hooks from tenancy and traits.
 *
 * @param tenancy - Column tenancy, when set
 * @param schemaTraits - Schema traits, when any were passed
 * @param tables - Tables passed to `schema()`
 * @returns The hooks, or `undefined` when nothing opted in
 */
function collectHooks(
  tenancy: ColumnTenancy | undefined,
  schemaTraits: readonly Trait[] | undefined,
  tables: readonly AnyTable[],
): readonly SchemaHook[] | undefined {
  const found: SchemaHook[] = [];
  const seen = new Set<object>();
  const add = (value: object): void => {
    if (seen.has(value)) return;
    const hook = (value as { readonly hook?: unknown }).hook;
    if (typeof hook !== "function") return;
    seen.add(value);
    found.push((hook as SchemaHook).bind(value));
  };
  if (tenancy !== undefined) add(tenancy);
  if (schemaTraits !== undefined) {
    for (const trait of schemaTraits) add(trait);
  }
  for (const item of tables) {
    const own = (item.options as { readonly traits?: unknown } | undefined)?.traits;
    if (!Array.isArray(own)) continue;
    for (const trait of own) {
      if (typeof trait === "object" && trait !== null) add(trait);
    }
  }
  for (const hook of registeredHooks) found.push(hook);
  return found.length === 0 ? undefined : found;
}

/**
 * Reads the archive model a trait rewrite stored on the table.
 *
 * @param item - Table after the rewrite pass
 * @returns The model, omitted when the table is not archivable
 */
function archiveModel(item: AnyTable): { readonly archive: ArchiveModel } | undefined {
  const archive = (item as { readonly archiveModel?: ArchiveModel }).archiveModel;
  return archive === undefined ? undefined : { archive };
}

function bareTables(tables: readonly AnyTable[]): readonly AnyTable[] {
  for (const item of tables) {
    const mark = (item.options as { readonly tenancy?: unknown } | undefined)?.tenancy;
    if (mark !== undefined) {
      definition(`Table ${item.name} sets tenancy, and the schema does not.`);
    }
  }
  return tables;
}

function openSchemaTraits(value: unknown): readonly Trait[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) definition("schema() traits must be a list of traits.");
  return value.length === 0 ? undefined : (value as readonly Trait[]);
}

/**
 * Collects the traits for one table and lets each add its columns.
 *
 * Schema defaults come first. `omitDefaults` drops them and keeps traits
 * declared on the table. No list means the table's own columns, unchanged.
 *
 * @param table - Table name, for errors
 * @param columns - Columns the table declared
 * @param schemaTraits - Traits from `schema()`
 * @param options - This table's options
 * @returns The merged columns and the traits that applied, or `undefined`
 */
function openTableTraits(
  table: string,
  columns: Readonly<Record<string, object>>,
  schemaTraits: readonly Trait[] | undefined,
  options: { readonly traits?: unknown; readonly omitDefaults?: unknown } | undefined,
):
  | {
      readonly columns: Record<string, object>;
      readonly traits: readonly Trait[];
    }
  | undefined {
  let shared = schemaTraits;
  const omit = options?.omitDefaults;
  if (omit !== undefined) {
    if (typeof omit !== "string" || omit.trim().length === 0) {
      definition(`Table ${table} omitDefaults needs a reason.`);
    }
    shared = undefined;
  }
  const own = options?.traits;
  if (own !== undefined && !Array.isArray(own)) {
    definition(`Table ${table} traits must be a list of traits.`);
  }
  const local = Array.isArray(own) && own.length > 0 ? (own as readonly Trait[]) : undefined;
  if ((shared === undefined || shared.length === 0) && local === undefined) return undefined;
  const traits =
    local === undefined
      ? shared
      : shared === undefined || shared.length === 0
        ? local
        : [...shared, ...local];
  if (traits === undefined) return undefined;
  const model: TraitModel = { columns: { ...columns } };
  for (const trait of traits) trait.apply(model, { table });
  return { columns: model.columns, traits };
}

function compileTable(
  item: AnyTable,
  namespace: ReturnType<typeof staticNamespace>,
  casing: "snake" | undefined,
  codecs: SchemaCodecs,
  requires: SchemaRequires | undefined,
  idDefault: SchemaIdDefault | undefined,
  jobs: CatalogJob[],
  enums: Map<string, EnumNote>,
  schemaTraits: readonly Trait[] | undefined,
): Prepared {
  const options = item.options as StoredOptions | undefined;
  const applied = openTableTraits(
    item.name,
    item.columns,
    schemaTraits,
    item.options as { readonly traits?: unknown; readonly omitDefaults?: unknown } | undefined,
  );
  readTableNames(item.name, options);
  const sqlName = options?.sqlName ?? (casing === "snake" ? snakeCase(item.name) : item.name);
  assertIdentifier(sqlName, `table ${item.name}`);
  const provenance: Provenance =
    item.source === undefined
      ? { origin: "file", name: item.name }
      : { origin: "file", name: item.name, source: item.source };
  const parent: ObjectRef = { namespace, name: sqlName };
  stage(jobs, () => catalogTable({ namespace, name: sqlName, provenance }));

  const columns: PreparedColumn[] = [];
  const columnPrimary: string[] = [];
  const byField = new Map<string, PreparedColumn>();
  const bySql = new Map<string, PreparedColumn>();
  const handles: Record<string, ColumnHandle> = {};
  const sourceColumns: Readonly<Record<string, object>> =
    applied === undefined ? item.columns : applied.columns;
  for (const [field, builder] of Object.entries(sourceColumns)) {
    if (!(builder instanceof ColumnBuilder)) {
      definition(`Column ${item.name}.${field} must be a column builder.`);
    }
    const column = applySchemaId(builder as unknown as ColumnView, idDefault);
    const columnSql = column.state.sqlName ?? (casing === "snake" ? snakeCase(field) : field);
    assertCodec(item.name, field, column, codecs);
    const mark =
      applied !== undefined ? (builder as { readonly trait?: unknown }).trait : undefined;
    const traitName = typeof mark === "string" ? mark : undefined;
    const columnProvenance: Provenance =
      traitName === undefined
        ? provenance
        : {
            origin: "trait",
            name: traitName,
            ...(provenance.source !== undefined ? { source: provenance.source } : {}),
          };
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
          provenance: columnProvenance,
          dependencies: [seq.identity],
        });
      });
    } else {
      jobs.push((objects) => {
        pushCompiled(objects, column, {
          parent,
          name: columnSql,
          provenance: columnProvenance,
        });
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
      sensitive: column.state.sensitive,
      guarded: column.state.guarded,
      writable:
        column.state.guarded !== true &&
        column.state.omitWrite !== true &&
        column.state.generated === undefined,
      unique: column.state.unique !== undefined,
      clientDefault: column.state.clientDefault === undefined ? undefined : "client",
      elementEncode:
        column.state.dims > 0
          ? (column.state.elementEncode as (value: unknown) => string)
          : undefined,
      fill: column.state.clientDefault,
      accepts: column.state.accepts,
    };
    columns.push(prepared);
    byField.set(field, prepared);
    bySql.set(prepared.sqlName, prepared);
    handles[field] = { name: prepared.sqlName };
    if (column.state.primaryKey) {
      if (column.state.nullable) {
        catalogError("OKM1020", `Primary key ${item.name}.${field} is nullable.`);
      }
      columnPrimary.push(prepared.sqlName);
    }
    if (column.state.defaultSql === "uuidv7()") {
      refuseUuidV7(item.name, field, requires);
    }
    const labels = column.state.enumLabels;
    if (labels !== undefined) {
      noteEnum(enums, labels, column.state.typeDependency ?? prepared.sqlName, sqlName, provenance);
    }
  }

  const optionPrimary = readPrimaryKey(item.name, options, byField);
  if (columnPrimary.length > 1) {
    catalogError(
      "OKM1020",
      `Table ${item.name} has more than one primary key (${columnPrimary.join(", ")}). One primary key is accepted.`,
    );
  }
  if (columnPrimary.length > 0 && optionPrimary.length > 0) {
    catalogError(
      "OKM1020",
      `Table ${item.name} has two primary keys. One primary key is accepted.`,
    );
  }
  const primary = optionPrimary.length > 0 ? optionPrimary : columnPrimary;
  if (primary.length > 0) {
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
    uniques: uniqueTargets(primary, columns, bySql, options, handles),
    byField,
    bySql,
    relationOptions: relationInput(item.name, options),
    ...(applied !== undefined ? { traits: applied.traits } : {}),
    ...archiveModel(item),
  };
}

function uniqueTargets(
  primary: readonly string[],
  columns: readonly PreparedColumn[],
  bySql: ReadonlyMap<string, PreparedColumn>,
  options: StoredOptions | undefined,
  handles: Readonly<Record<string, ColumnHandle>>,
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
  const build = options?.indexes;
  if (build !== undefined) {
    const calls = build(handles);
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (call.isUnique !== true || call.predicate === undefined) continue;
        const fields: string[] = [];
        let whole = true;
        for (const sqlName of call.columns) {
          const column = bySql.get(sqlName);
          if (column === undefined) {
            whole = false;
            break;
          }
          fields.push(column.field);
        }
        if (whole && fields.length > 0) uniques.push(fields);
      }
    }
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
        ...(built.predicate !== undefined ? { predicate: built.predicate } : {}),
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
    const localColumns = localKey(item, column, reference);
    const targetColumns = resolveTarget(item, column, target, reference);
    if (localColumns.length !== targetColumns.length) {
      catalogError(
        "OKM1021",
        `Foreign key ${item.tsName}.${column.field} on ${target.tsName} has ${localColumns.length} local columns and ${targetColumns.length} target columns.`,
      );
    }
    if (reference.onDelete === "set null" || reference.onUpdate === "set null") {
      for (const local of localColumns) {
        if (!local.nullable) {
          definition(
            `Foreign key ${item.tsName}.${column.field} uses set null. ${item.tsName}.${local.field} must be nullable.`,
          );
        }
      }
    }
    const localNames: string[] = [];
    const remoteNames: string[] = [];
    for (let index = 0; index < localColumns.length; index += 1) {
      const local = localColumns[index];
      const remote = targetColumns[index];
      if (local === undefined || remote === undefined) continue;
      if (local.dataType !== remote.dataType) {
        catalogError(
          "OKM1022",
          `Foreign key ${item.tsName}.${local.field} is ${local.dataType} and ${target.tsName}.${remote.field} is ${remote.dataType}. Accepted type: ${remote.dataType}.`,
        );
      }
      localNames.push(local.sqlName);
      remoteNames.push(remote.sqlName);
    }
    stage(jobs, () =>
      constraint({
        parent: item.parent,
        constraintKind: "foreignKey",
        columns: localNames,
        nameKey: column.sqlName,
        provenance: item.provenance,
        references: {
          parent: target.parent,
          columns: remoteNames,
          ...(reference.onDelete !== undefined ? { onDelete: reference.onDelete } : {}),
          ...(reference.onUpdate !== undefined ? { onUpdate: reference.onUpdate } : {}),
        },
      }),
    );
    edges.push({
      fromTable: item.tsName,
      fromField: column.field,
      toTable: target.tsName,
      local: localNames,
      remote: remoteNames,
    });
  }
}

function localKey(
  item: Prepared,
  column: PreparedColumn,
  reference: ReferenceModifier,
): readonly PreparedColumn[] {
  const along = reference.along;
  if (along === undefined || along.length === 0) return [column];
  const accepted = [...item.byField.keys()].sort();
  const columns: PreparedColumn[] = [column];
  for (const name of along) {
    const extra = item.byField.get(name) ?? item.bySql.get(name);
    if (extra === undefined) {
      throwNamed(
        "OKM1021",
        name,
        accepted,
        `Foreign key ${item.tsName}.${column.field} includes ${name}, which is not a column. Accepted columns: ${list(accepted)}.`,
      );
    }
    columns.push(extra);
  }
  return columns;
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
    if (found.length !== 1 && reference.along === undefined) {
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
  const primary: string[] = [];
  for (const sqlName of item.primary) {
    const column = item.bySql.get(sqlName);
    if (column !== undefined) primary.push(column.field);
  }
  let conceal = false;
  const columns: ColumnModel[] = item.columns.map((column) => {
    if (column.hidden || column.sensitive) conceal = true;
    return {
      field: column.field,
      sql: column.sqlName,
      dataType: column.dataType,
      encode: column.encode,
      decode: column.decode,
      hidden: column.hidden,
      sensitive: column.sensitive,
      guarded: column.guarded,
      writable: column.writable,
      guardUpdate: column.writable && primary.includes(column.field),
      ...(column.fill !== undefined ? { fill: column.fill, clientDefault: "client" as const } : {}),
      ...(column.elementEncode !== undefined ? { elementEncode: column.elementEncode } : {}),
      accepts: column.accepts,
    };
  });
  return {
    name: item.tsName,
    sql: item.sqlName,
    primary,
    uniques: item.uniques,
    columns,
    relations: resolveRelations(item, edges, byName, accepted),
    ...(conceal ? { conceal: true as const } : {}),
    ...(item.traits !== undefined ? { traits: item.traits } : {}),
    ...(item.provenance.source !== undefined ? { source: item.provenance.source } : {}),
    ...(item.archive !== undefined ? { archive: item.archive } : {}),
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
        `Table ${item.tsName} relation ${name} is not available yet. one(), many(), and manyThrough() are accepted. morph arrives later.`,
      );
    }
    const own = (call as Partial<ManyThroughRelation>).resolve;
    if (own !== undefined) {
      resolved.push(own({ owner: item.tsName, name, edges, tables: accepted }));
      continue;
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
        ? { name, kind: "one", table: call.table, local: edge.local, remote: edge.remote }
        : { name, kind: "many", table: call.table, local: edge.remote, remote: edge.local },
    );
  }
  return resolved;
}

function readPrimaryKey(
  tableName: string,
  options: StoredOptions | undefined,
  byField: ReadonlyMap<string, PreparedColumn>,
): readonly string[] {
  const listed = options?.primaryKey;
  if (listed === undefined) return [];
  if (!Array.isArray(listed) || listed.length === 0) {
    definition(`Table ${tableName} primaryKey needs a column.`);
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const field of listed) {
    if (typeof field !== "string" || field.length === 0 || seen.has(field)) {
      definition(`Table ${tableName} primaryKey repeats a column.`);
    }
    seen.add(field);
    const column = byField.get(field);
    if (column === undefined || column.nullable) {
      catalogError("OKM1020", `Primary key ${tableName}.${field} is missing or nullable.`);
    }
    columns.push(column.sqlName);
  }
  return columns;
}

/** Database default or client generator that replaces a bare `t.id()`. */
type SchemaIdDefault =
  | { readonly kind: "database"; readonly sql: "uuidv7()" | "gen_random_uuid()" }
  | { readonly kind: "client"; readonly fill: ClientFill };

/**
 * Applies `defaults.id` to a bare `t.id()`. A column choice is left alone.
 *
 * @param column - Column as declared
 * @param idDefault - Schema id default, when set
 * @returns The column insert and the catalog should see
 */
function applySchemaId(column: ColumnView, idDefault: SchemaIdDefault | undefined): ColumnView {
  if (idDefault === undefined || column.state.idSource !== "implicit") return column;
  const fill = idDefault.kind === "client" ? idDefault.fill : undefined;
  const okid = fill?.name === "okid";
  return new ColumnBuilder({
    ...column.state,
    defaultSql: idDefault.kind === "database" ? idDefault.sql : undefined,
    clientDefault: fill,
    idSource: "column",
    ...(okid
      ? {
          baseType: "text",
          collation: "C",
          encode: encodeText,
          decode: decodeText,
          sqlForm: "quote" as const,
        }
      : {}),
  } as ColumnState<unknown>) as unknown as ColumnView;
}

/**
 * Reads `defaults.id`.
 *
 * @param defaults - Schema option
 * @returns The id default, or `undefined` when the option is omitted
 */
function readIdDefault(
  defaults: SchemaInput<readonly AnyTable[]>["defaults"],
): SchemaIdDefault | undefined {
  if (defaults === undefined) return undefined;
  if (typeof defaults !== "object" || defaults === null) {
    definition("schema() defaults must be an object.");
  }
  for (const key of Object.keys(defaults)) {
    if (key !== "id") {
      definition(`schema() defaults.${key} is not a schema default. Accepted names: id.`);
    }
  }
  const id = defaults.id;
  if (id === undefined) return undefined;
  if (id === "uuidv7") return { kind: "database", sql: "uuidv7()" };
  if (id === "uuidv4") return { kind: "database", sql: "gen_random_uuid()" };
  const fill = readClientGenerator(id);
  if (fill !== undefined) return { kind: "client", fill };
  definition('schema() defaults.id must be "uuidv7", "uuidv4", or a client generator.');
}

/**
 * Rejects `uuidv7()` when the schema declares a Postgres older than 18.
 *
 * An undeclared `requires` does not name a version, so the default stays.
 *
 * @param tableName - Table that owns the column
 * @param field - Column field name
 * @param requires - Declared engine range
 */
function refuseUuidV7(
  tableName: string,
  field: string,
  requires: SchemaRequires | undefined,
): void {
  const declared = Number(/^>=(\d+)$/.exec(requires?.postgres ?? "")?.[1]);
  if (!(declared > 0) || declared >= 18) return;
  throw new OkmError(
    "OKM1812",
    `Column ${tableName}.${field} uses uuidv7(). Set defaults.id to "uuidv4" or a client generator.`,
    { fix: { summary: "Set defaults.id." } },
  );
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
