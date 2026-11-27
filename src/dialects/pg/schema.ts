/**
 * `schema()` compiles tables into one catalog.
 *
 * Work happens here, not in `table()` and not at import.
 */

import type { DeclaredComputed, KnownTables } from "./computed-types.js";
import { OkmError, catalogError, throwNamed } from "../../contracts/error.js";
import { withLocation } from "../../contracts/location.js";
import { catalog } from "../../contracts/catalog/build.js";
import { enumType, sameEnumLabels } from "../../contracts/catalog/enum.js";
import { staticNamespace } from "../../contracts/catalog/identity.js";
import {
  assertIdentifier,
  assertStoredText,
  identitySequenceName,
  printedIdentifier,
  recoveredNameKey,
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
import { readPolicyCompiler } from "./policy-slot.js";
import {
  ColumnBuilder,
  compositeMark,
  formatType,
  retimed,
  type ColumnState,
  type ForeignKeySpec,
  type ReferenceModifier,
} from "./column.js";
import { clearTypeGrants, rememberTypeGrant } from "./composite-mark.js";
import { holdGenerated } from "./generated-hold.js";
import { rememberGrants } from "./role/grant-slot.js";
import { readSeriesCompiler } from "./series-slot.js";
import {
  formatPostgresFloor,
  isPostgresMajor,
  minPostgresDefinition,
  parsePostgresFloor,
  UUIDV7_POSTGRES,
  uuidv7NeedsPostgres,
  type PostgresMajor,
} from "./floor.js";
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
import { hasTemporal, temporalMissing, timeMode, type Retime, type TimeMode } from "./time.js";
import type {
  FieldsOfList,
  HasArchive,
  HasVersioned,
  PresetsOfList,
  Trait,
  TraitModel,
} from "./trait.js";
import { type Casing, type Names, namesFor } from "./casing.js";
import { type ColumnTenancy, type TenantFields, readTenancy } from "./tenancy.js";
import {
  type AnyTable,
  type ColumnHandle,
  type IndexCall,
  type InsertFrom,
  type RowFrom,
  type SqlText,
  type UpdateFrom,
  bindIndexNames,
  clearIndexNames,
  columnHandle,
  emittedTypeName,
  rejectLater,
} from "./table.js";

/** Codec defaults from spec section 6.6. `timestamps` is the applied `defaults.time`. */
export type SchemaCodecs = {
  readonly bigint: "string" | "number" | "bigint";
  readonly numeric: "string" | "number";
  readonly timestamps: TimeMode;
};

/**
 * Engine requirement recorded for connect.
 *
 * The stored value is `>=` and a major. `minPostgres` and the deprecated
 * string form normalise to the same object.
 */
export type SchemaRequires = {
  /**
   * @deprecated Use `minPostgres`. `">=17"` is the same floor as `minPostgres: 17`.
   */
  readonly postgres?: string;
};

/**
 * Input for {@link schema}.
 *
 * Later keys are part of the type and rejected when present.
 *
 * @typeParam TTables - Tables in declaration order
 * @typeParam TTime - `defaults.time` the input accepts. `"date"` and `"temporal"`
 *   select the `schema()` overloads that swap row types
 */
export type SchemaInput<TTables extends readonly AnyTable[], TTime extends TimeMode = "iso"> = {
  readonly tables: TTables;
  /**
   * Oldest Postgres major this schema runs on.
   *
   * Omitted means 15. A feature that needs a newer major is refused here.
   */
  readonly minPostgres?: PostgresMajor;
  /**
   * @deprecated Use {@link SchemaInput.minPostgres}. `">=17"` is the same floor as `minPostgres: 17`.
   */
  readonly requires?: SchemaRequires;
  /**
   * The SQL spelling of a key you did not name.
   *
   * Omitted keeps every key as written. `"snake"` and `"camel"` rewrite tables
   * and columns, and every name derived from them. `sqlName` always wins.
   */
  readonly casing?: Casing;
  readonly codecs?: {
    readonly bigint?: SchemaCodecs["bigint"];
    readonly numeric?: SchemaCodecs["numeric"];
    /**
     * @deprecated Moved to `defaults.time`. `defaults: { time: "temporal" }` keeps Temporal values.
     */
    readonly timestamps?: never;
  };
  readonly types?: "emitted" | "inferred";
  /**
   * What a bare `t.id()` means.
   *
   * Omitted, the database default is `gen_random_uuid()`. `"uuidv4"` stores
   * the same function. `"uuidv7"` stores `uuidv7()` and needs Postgres 18
   * (`minPostgres: 18`).
   * Pick `uuidv7` for a large write-heavy table: the ids are time-ordered
   * and the index stays local. Random ids are fine elsewhere. A client
   * generator is filled on insert and stays out of the catalog. A column
   * option wins.
   */
  readonly defaults?: SchemaDefaults<TTime>;
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
  /**
   * Sequences declared once and used by columns, or owned by no column.
   *
   * A column-owned series does not need to be listed. Identity sequences are not listed.
   */
  readonly sequences?: readonly {
    contribute(namespace: ReturnType<typeof staticNamespace>, objects: CatalogObject[]): void;
  }[];
  readonly functions?: unknown;
  readonly triggers?: unknown;
  readonly views?: unknown;
};

/**
 * Project defaults for `schema()`. A column option wins over each one.
 */
export type SchemaDefaults<TTime extends TimeMode = TimeMode> = {
  /**
   * What a bare `t.id()` means.
   *
   * Omitted, the database default is `gen_random_uuid()`. `"uuidv4"` stores
   * the same function. `"uuidv7"` stores `uuidv7()` and needs Postgres 18
   * (`minPostgres: 18`).
   * Pick `uuidv7` for a large write-heavy table: the ids are time-ordered
   * and the index stays local. Random ids are fine elsewhere. A client
   * generator is filled on insert and stays out of the catalog.
   */
  readonly id?: "uuidv7" | "uuidv4" | ClientGenerator<string>;
  /**
   * How date and time columns read and write.
   *
   * Omitted is `"iso"`: ISO-8601 strings on every runtime. `"date"` is a JS
   * `Date` for `date`, `timestamp`, and `timestamptz` (milliseconds).
   * `"temporal"` is Temporal values and needs a `Temporal` global: Node 26+,
   * Bun 1.4+, or a polyfill. `{ mode }` on a column wins. The catalog does
   * not change.
   */
  readonly time?: TTime;
};

/**
 * A schema whose date and time columns follow `defaults.time`.
 *
 * `"iso"` and an omitted default keep the schema type. `"date"` and
 * `"temporal"` swap the text of every column that names no mode.
 *
 * @typeParam S - Schema type
 * @typeParam M - `defaults.time`
 */
export type TimedSchema<S, M extends TimeMode> = M extends "iso"
  ? S
  : S extends { readonly "~byName": infer B }
    ? Omit<S, "~byName"> & {
        readonly "~byName": {
          readonly [N in keyof B]: Omit<B[N], "~row" | "~insert" | "~update"> & {
            readonly "~row": RetimeShape<B[N], "~row", M>;
            readonly "~insert": RetimeShape<B[N], "~insert", M>;
            readonly "~update": RetimeShape<B[N], "~update", M>;
          };
        };
      }
    : S;

type RetimeShape<T, K extends string, M extends TimeMode> = T extends {
  readonly [P in K]: infer R;
}
  ? { readonly [F in keyof R]: Retime<R[F], M> }
  : never;

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
  readonly casing: Casing | undefined;
  readonly codecs: SchemaCodecs;
  /**
   * Declared floor, normalised to `>=` and a major.
   *
   * Absent when the schema names no floor. Connect then uses 15.
   */
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
          : T extends { readonly "~path": string }
            ? T
            : T & {
                readonly "~row": RowFrom<TenantFields<TTenancy["key"], TTenancy["type"]>>;
                readonly "~insert": InsertFrom<TenantFields<TTenancy["key"], TTenancy["type"]>>;
                readonly "~update": UpdateFrom<TenantFields<TTenancy["key"], TTenancy["type"]>>;
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
> = [keyof FieldsOfList<TTraits> | keyof PresetsOfList<TTraits>] extends [never]
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
    } & HasArchive<TTraits> &
      HasVersioned<TTraits> &
      PresetsOfList<TTraits>;

const SCHEMA_KNOWN = new Set([
  "casing",
  "codecs",
  "computed",
  "defaults",
  "extensions",
  "functions",
  "minPostgres",
  "requires",
  "sequences",
  "tables",
  "tenancy",
  "traits",
  "triggers",
  "types",
  "validation",
  "views",
]);

/** Later schema options, and the version that adds each one. */
const SCHEMA_LATER: Readonly<Record<string, string>> = {};

const BIGINT_CODECS = new Set(["string", "number", "bigint"]);
const NUMERIC_CODECS = new Set(["string", "number"]);

/** Options `table()` may have stored. Not the generic handles map. */
type StoredOptions = {
  readonly sqlName?: string;
  readonly renamedFrom?: string;
  readonly comment?: string;
  readonly presets?: Readonly<Record<string, unknown>>;
  readonly unique?: Readonly<Record<string, readonly string[]>>;
  readonly primaryKey?: readonly string[];
  readonly indexes?: (columns: Readonly<Record<string, ColumnHandle>>) => readonly IndexCall[];
  readonly checks?: Readonly<
    Record<
      string,
      | ((columns: Readonly<Record<string, ColumnHandle>>) => SqlText)
      | {
          readonly expression: (columns: Readonly<Record<string, ColumnHandle>>) => SqlText;
          readonly enforced?: false;
          readonly comment?: string;
        }
    >
  >;
  readonly foreignKeys?: (
    columns: Readonly<Record<string, ColumnHandle>>,
  ) => Readonly<Record<string, ForeignKeySpec>>;
};

/** Fields `schema()` reads from a column. Avoids instantiating {@link ColumnBuilder}. */
type ColumnView = CompilableColumn & {
  readonly state: ColumnState<unknown>;
};

type PreparedColumn = {
  readonly field: string;
  readonly sqlName: string;
  readonly dataType: string;
  /** What the builder holds. The query model reads its flags and codecs from here. */
  readonly state: ColumnState<unknown>;
  /** Date and time mode after `defaults.time`. Absent on other columns. */
  readonly time: TimeMode | undefined;
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
  /** Own and trait presets, merged. Absent when the table has none. */
  readonly presets?: Readonly<Record<string, unknown>> | undefined;
  readonly foreignKeys?: (
    columns: Readonly<Record<string, ColumnHandle>>,
  ) => Readonly<Record<string, ForeignKeySpec>>;
  readonly handles: Readonly<Record<string, ColumnHandle>>;
};

/**
 * `~views` when `schema({ views })` declared any, so `db.views` is typed.
 * Nothing at runtime carries the key.
 */
type SchemaViews<TViews extends readonly unknown[]> = TViews extends readonly []
  ? unknown
  : { readonly "~views": TViews };

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
  const TViews extends readonly unknown[] = readonly [],
>(
  config: Omit<SchemaInput<TTables>, "traits" | "tenancy" | "validation" | "views"> & {
    readonly traits: TTraits;
    readonly tenancy?: TTenancy;
    readonly validation?: TValidation;
    readonly views?: TViews;
    readonly computed?: undefined;
  },
): ([TValidation] extends [undefined]
  ? TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy>
  : TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy> & {
      readonly "~validation": TValidation;
    }) &
  SchemaViews<TViews>;
export function schema<
  const TTables extends readonly AnyTable[],
  const TTenancy extends ColumnTenancy | undefined = undefined,
  const TValidation = undefined,
  const TViews extends readonly unknown[] = readonly [],
>(
  config: Omit<SchemaInput<TTables>, "tenancy" | "validation" | "views"> & {
    readonly tenancy?: TTenancy;
    readonly validation?: TValidation;
    readonly views?: TViews;
    readonly computed?: undefined;
  },
): ([TValidation] extends [undefined]
  ? TenancySchema<BuiltSchema<TTables>, TTables, TTenancy>
  : TenancySchema<BuiltSchema<TTables>, TTables, TTenancy> & {
      readonly "~validation": TValidation;
    }) &
  SchemaViews<TViews>;
export function schema<
  const TTables extends readonly AnyTable[],
  const TTraits extends readonly { readonly fields: Readonly<Record<string, object>> }[] =
    readonly [],
  const TTenancy extends ColumnTenancy | undefined = undefined,
  const TValidation = undefined,
  const TViews extends readonly unknown[] = readonly [],
  const TTime extends "date" | "temporal" = "date" | "temporal",
>(
  config: Omit<SchemaInput<TTables>, "traits" | "tenancy" | "validation" | "views" | "defaults"> & {
    readonly traits?: TTraits;
    readonly tenancy?: TTenancy;
    readonly validation?: TValidation;
    readonly views?: TViews;
    readonly computed?: undefined;
    readonly defaults: SchemaDefaults<TTime>;
  },
): TimedSchema<
  ([TValidation] extends [undefined]
    ? TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy>
    : TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy> & {
        readonly "~validation": TValidation;
      }) &
    SchemaViews<TViews>,
  TTime
>;
/**
 * Declares values read with the parent rows, as `schema({ computed })`.
 *
 * The callbacks are stored as given and never run here. A read selects one
 * with `computed: { name: true }`.
 *
 * @typeParam TTables - Tables in declaration order
 * @typeParam TComputed - Table name, then value name, to a callback of the row
 * @param config - Tables, `computed`, and the other schema options
 * @returns The schema and its catalog
 */
export function schema<
  const TTables extends readonly AnyTable[],
  const TComputed extends DeclaredComputed<
    TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy>,
    TTables[number]["~name"]
  >,
  const TTraits extends readonly { readonly fields: Readonly<Record<string, object>> }[] =
    readonly [],
  const TTenancy extends ColumnTenancy | undefined = undefined,
  const TValidation = undefined,
  const TViews extends readonly unknown[] = readonly [],
>(
  config: Omit<SchemaInput<TTables>, "traits" | "tenancy" | "validation" | "views"> & {
    readonly traits?: TTraits;
    readonly tenancy?: TTenancy;
    readonly validation?: TValidation;
    readonly views?: TViews;
    readonly computed: TComputed & KnownTables<TComputed, TTables[number]["~name"]>;
  },
): ([TValidation] extends [undefined]
  ? TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy>
  : TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy> & {
      readonly "~validation": TValidation;
    }) &
  SchemaViews<TViews> & { readonly "~computed": TComputed };
export function schema<
  const TTables extends readonly AnyTable[],
  const TComputed extends DeclaredComputed<
    TimedSchema<TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy>, TTime>,
    TTables[number]["~name"]
  >,
  const TTime extends "date" | "temporal",
  const TTraits extends readonly { readonly fields: Readonly<Record<string, object>> }[] =
    readonly [],
  const TTenancy extends ColumnTenancy | undefined = undefined,
  const TValidation = undefined,
  const TViews extends readonly unknown[] = readonly [],
>(
  config: Omit<SchemaInput<TTables>, "traits" | "tenancy" | "validation" | "views" | "defaults"> & {
    readonly traits?: TTraits;
    readonly tenancy?: TTenancy;
    readonly validation?: TValidation;
    readonly views?: TViews;
    readonly defaults: SchemaDefaults<TTime>;
    readonly computed: TComputed & KnownTables<TComputed, TTables[number]["~name"]>;
  },
): TimedSchema<
  ([TValidation] extends [undefined]
    ? TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy>
    : TenancySchema<SchemaWithTraits<TTables, TTraits>, TTables, TTenancy> & {
        readonly "~validation": TValidation;
      }) &
    SchemaViews<TViews> & { readonly "~computed": TComputed },
  TTime
>;
export function schema<const TTables extends readonly AnyTable[]>(
  config: SchemaInput<TTables, TimeMode> & { readonly computed?: unknown },
): BuiltSchema<TTables> {
  rejectLater(config, SCHEMA_KNOWN, SCHEMA_LATER, "schema()");
  const schemaTraits = openSchemaTraits(config.traits);
  const tenancy = readTenancy(config.tenancy);
  if (!Array.isArray(config.tables)) {
    definition("schema() needs a tables array.");
  }
  const casing = readCasing(config.casing);
  const names = namesFor(casing);
  const tables = rewritePass(config.tables, tenancy, schemaTraits, names);
  const hooks = collectHooks(tenancy, schemaTraits, config.tables, config.views);
  const types = readTypes(config.types);
  const idDefault = readIdDefault(config.defaults);
  const codecs = readCodecs(config.codecs, readTimeDefault(config.defaults));
  const requires = readFloor(config.minPostgres, config.requires);
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
      names,
      codecs,
      requires,
      idDefault,
      jobs,
      enums,
      schemaTraits,
      tenancy === undefined,
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
    compileNamedForeignKeys(item, byName, jobs);
  }
  const model = {} as Record<string, TableModel>;
  const scopeFields =
    tenancy === undefined ? undefined : tenancy.keys !== undefined ? tenancy.keys : [tenancy.key];
  let temporal = false;
  for (const item of prepared) {
    model[item.tsName] = tableModel(item, edges, byName, accepted, scopeFields);
    temporal ||= item.columns.some((column) => column.time === "temporal");
  }
  // A temporal column with no Temporal global fails in connect(), before a query.
  const clientHooks: readonly SchemaHook[] | undefined = temporal
    ? [requireTemporalHook, ...(hooks ?? [])]
    : hooks;
  bindViews(config.views, model, tenancy, tables, names);

  // Catalog objects, enum types, and the cycle check run on first read.
  // Import pays for the query model only (D138).
  let document: Catalog | undefined;
  return {
    get catalog(): Catalog {
      if (document === undefined) {
        clearTypeGrants();
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
              ...(note.comment !== undefined ? { comment: note.comment } : {}),
            }),
          );
          const schemaName = namespace.form === "static" ? namespace.name : "public";
          rememberTypeGrant(schemaName, name, note.grants);
        }
        contributeListed(config.extensions, objects, names);
        contributeListed(config.functions, objects, names, tables);
        contributeListed(schemaTraits, objects, names);
        for (const item of config.tables) {
          contributeListed(
            (item.options as { readonly traits?: unknown } | undefined)?.traits,
            objects,
            names,
          );
        }
        contributeListed(config.triggers, objects, names);
        contributeListed(config.views, objects, names);
        if (Array.isArray(config.sequences)) {
          for (const item of config.sequences) item.contribute(namespace, objects);
        }
        rememberSequenceGrants(prepared);
        if (tablesWantPolicies(config.tables)) {
          const compile = readPolicyCompiler();
          if (compile === undefined) {
            throw new OkmError(
              "OKM1924",
              "Import okmodel/policy before schema() when a table sets policies or rls.",
              {
                fix: {
                  summary: "Import okmodel/policy in the file that calls schema().",
                },
              },
            );
          }
          compile(
            config.tables,
            (tsName) => {
              const item = byName.get(tsName);
              if (item === undefined) return undefined;
              return {
                sqlName: item.sqlName,
                parent: item.parent,
                provenance: item.provenance,
                column: (field) => {
                  const column = item.byField.get(field);
                  return column === undefined
                    ? undefined
                    : { sql: column.sqlName, dataType: column.dataType };
                },
              };
            },
            objects,
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
    computed: config.computed,
    ...(schemaTraits !== undefined && schemaTraits.length > 0 ? { traits: schemaTraits } : {}),
    ...(tenancy !== undefined ? { tenancy } : {}),
    ...(clientHooks !== undefined ? { hooks: clientHooks } : {}),
    ...(config.validation !== undefined ? { validation: config.validation } : {}),
  } as unknown as BuiltSchema<TTables>;
}

function tablesWantPolicies(tables: readonly AnyTable[]): boolean {
  for (const item of tables) {
    const options = item.options as
      | { readonly policies?: unknown; readonly rls?: unknown }
      | undefined;
    if (options?.policies !== undefined || options?.rls !== undefined) return true;
  }
  return false;
}

function acceptTables(tables: readonly AnyTable[]): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const emitted = new Map<string, string>();
  for (const item of tables) {
    if (typeof item.name !== "string" || item.name.length === 0) {
      definition("schema() tables need a name.");
    }
    if (item.name === "capabilities") {
      catalogError(
        "OKM1023",
        withLocation("Table capabilities uses the client name capabilities.", item.source),
        { fix: { summary: "Rename the table." } },
      );
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
  readonly comment?: string;
  readonly grants?: unknown;
};

function noteEnum(
  notes: Map<string, EnumNote>,
  labels: readonly string[],
  name: string,
  table: string,
  provenance: Provenance,
  comment?: string,
  grants?: unknown,
): void {
  const previous = notes.get(name);
  if (previous !== undefined && !sameEnumLabels(previous.labels, labels)) {
    catalogError(
      "OKM1020",
      `Enum ${name} lists ${previous.labels.join(", ")} on ${previous.table} and ${labels.join(", ")} on ${table}. One enum has one label list.`,
    );
  }
  if (previous === undefined || compareText(table, previous.table) < 0) {
    const kept = comment ?? previous?.comment;
    const keptGrants = grants ?? previous?.grants;
    notes.set(name, {
      labels,
      table,
      provenance,
      ...(kept !== undefined ? { comment: kept } : {}),
      ...(keptGrants !== undefined ? { grants: keptGrants } : {}),
    });
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
 * @param names - Name lookups for the schema's casing
 * @returns Tables ready to compile
 */
function rewritePass(
  tables: readonly AnyTable[],
  tenancy: ColumnTenancy | undefined,
  schemaTraits: readonly Trait[] | undefined,
  names: Names,
): readonly AnyTable[] {
  let next = tenancy === undefined ? bareTables(tables) : tenancy.rewrite(tables, names);
  for (const trait of carriers("rewrite", [], schemaTraits, tables)) {
    const rewrite = (
      trait as {
        rewrite: (
          this: object,
          tables: readonly AnyTable[],
          names: Names,
          schemaTraits: readonly Trait[] | undefined,
        ) => readonly AnyTable[];
      }
    ).rewrite;
    next = rewrite.call(trait, next, names, schemaTraits);
  }
  return next;
}

/**
 * Distinct objects that carry a function under `key`, in rewrite or hook order.
 *
 * @param key - The method to look for
 * @param first - Values checked before the traits (views, tenancy)
 * @param schemaTraits - Schema traits, when any were passed
 * @param tables - Tables passed to `schema()`
 * @returns Each carrier once
 */
function carriers(
  key: "rewrite" | "hook",
  first: readonly unknown[],
  schemaTraits: readonly Trait[] | undefined,
  tables: readonly AnyTable[],
): readonly object[] {
  const found = new Set<object>();
  const add = (value: unknown): void => {
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>)[key] === "function"
    ) {
      found.add(value);
    }
  };
  first.forEach(add);
  schemaTraits?.forEach(add);
  for (const item of tables) {
    const own = (item.options as { readonly traits?: unknown } | undefined)?.traits;
    if (Array.isArray(own)) own.forEach(add);
  }
  return [...found];
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
  views: unknown,
): readonly SchemaHook[] | undefined {
  const found: SchemaHook[] = [];
  for (const value of carriers(
    "hook",
    [...(Array.isArray(views) ? views : []), tenancy],
    schemaTraits,
    tables,
  )) {
    found.push((value as { readonly hook: SchemaHook }).hook.bind(value));
  }
  for (const hook of registeredHooks) found.push(hook);
  return found.length === 0 ? undefined : found;
}

/**
 * Asks each view to publish a read model.
 *
 * The function that does it lives on the view object, so this file does not
 * import `okmodel/view`.
 *
 * @param views - `schema({ views })`
 * @param model - Query model, mutated with one entry per view
 * @param tenancy - Column tenancy, when the schema set it
 * @param tables - Tables after the tenancy rewrite
 * @param names - Name lookups for the schema's casing
 */
function bindViews(
  views: unknown,
  model: { [name: string]: TableModel },
  tenancy: ColumnTenancy | undefined,
  tables: readonly AnyTable[],
  names: Names,
): void {
  if (!Array.isArray(views)) return;
  const scoped = new Set<string>();
  for (const item of views) {
    if (typeof item !== "object" || item === null) continue;
    const install = (item as { readonly install?: ViewBind }).install;
    install?.call(item, model, tenancy, tables, names, scoped);
  }
}

/** The `install` method a view declaration may carry. */
type ViewBind = (
  model: { [name: string]: TableModel },
  tenancy: ColumnTenancy | undefined,
  tables: readonly AnyTable[],
  names: Names,
  scoped: Set<string>,
) => void;

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
    const options = item.options as
      | { readonly tenancy?: unknown; readonly tenantIndexes?: unknown }
      | undefined;
    if (options?.tenancy !== undefined) {
      definition(`Table ${item.name} sets tenancy, and the schema does not.`);
    }
    if (options?.tenantIndexes !== undefined) {
      definition(`Table ${item.name} sets tenantIndexes, and the schema has no tenancy.`);
    }
  }
  return tables;
}

/**
 * Asks each value that carries `contribute` for its catalog objects.
 *
 * Extensions, functions, triggers, and traits use the same call. An omitted
 * option, or a trait with no catalog records, does nothing.
 *
 * @param value - The option or trait list the caller passed
 * @param objects - Objects the schema is collecting
 */
function contributeListed(
  value: unknown,
  objects: CatalogObject[],
  names: Names,
  sources?: readonly object[],
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const produced = (
      item as {
        contribute(
          peers: unknown,
          built: unknown,
          names: Names,
          sources?: readonly object[],
        ): unknown;
      }
    ).contribute(value, objects, names, sources);
    if (Array.isArray(produced))
      for (const object of produced) objects.push(object as CatalogObject);
  }
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
  options:
    | {
        readonly traits?: unknown;
        readonly omitDefaults?: unknown;
        readonly presets?: Readonly<Record<string, unknown>>;
      }
    | undefined,
):
  | {
      readonly columns: Record<string, object>;
      readonly traits: readonly Trait[];
      readonly presets?: Readonly<Record<string, unknown>> | undefined;
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
  const model: TraitModel = { columns: { ...columns }, presets: options?.presets };
  for (const trait of traits) trait.apply(model, { table });
  return { ...model, traits };
}

function compileTable(
  item: AnyTable,
  namespace: ReturnType<typeof staticNamespace>,
  names: Names,
  codecs: SchemaCodecs,
  requires: SchemaRequires | undefined,
  idDefault: SchemaIdDefault | undefined,
  jobs: CatalogJob[],
  enums: Map<string, EnumNote>,
  schemaTraits: readonly Trait[] | undefined,
  bare: boolean,
): Prepared {
  const options = item.options as StoredOptions | undefined;
  const applied = openTableTraits(
    item.name,
    item.columns,
    schemaTraits,
    item.options as
      | {
          readonly traits?: unknown;
          readonly omitDefaults?: unknown;
          readonly presets?: Readonly<Record<string, unknown>>;
        }
      | undefined,
  );
  readTableNames(item.name, options);
  const sqlName = names.table(item);
  assertIdentifier(sqlName, `table ${item.name}`);
  const provenance: Provenance =
    item.source === undefined
      ? { origin: "file", name: item.name }
      : { origin: "file", name: item.name, source: item.source };
  const parent: ObjectRef = { namespace, name: sqlName };
  const tableDependencies: ObjectIdentity[] = [];
  stage(jobs, () =>
    catalogTable({
      namespace,
      name: sqlName,
      provenance,
      ...(options?.comment !== undefined ? { comment: options.comment } : {}),
      ...(tableDependencies.length > 0 ? { dependencies: tableDependencies } : {}),
    }),
  );

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
    const column = applySchemaTime(
      applySchemaId(builder as unknown as ColumnView, idDefault),
      codecs.timestamps,
    );
    const columnSql = column.state.sqlName ?? names.name(field);
    if (bySql.has(columnSql)) {
      catalogError(
        "OKM1023",
        `Table ${item.name} columns ${bySql.get(columnSql)?.field ?? ""} and ${field} use SQL name ${columnSql}. Name one with sqlName.`,
      );
    }
    if (names.casing !== undefined) assertIdentifier(columnSql, `column ${item.name}.${field}`);
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
    const draft = column.state.seriesDraft;
    if (identity !== undefined) {
      const seqName = identitySequenceName(sqlName, columnSql);
      jobs.push((objects) => {
        bindGenerated(column, handles, byField);
        const seq = sequence({
          namespace,
          name: seqName,
          dataType:
            column.state.baseType === "integer" || column.state.baseType === "smallint"
              ? column.state.baseType
              : "bigint",
          provenance,
          dependencies: [{ kind: "table", namespace, name: sqlName }],
          ...(identity.comment !== undefined ? { comment: identity.comment } : {}),
          ...(identity.start !== undefined ? { start: identity.start } : {}),
          ...(identity.increment !== undefined ? { increment: identity.increment } : {}),
          ...(identity.min !== undefined ? { min: identity.min } : {}),
          ...(identity.max !== undefined ? { max: identity.max } : {}),
          ...(identity.cache !== undefined ? { cache: identity.cache } : {}),
          ...(identity.cycle === true ? { cycle: true } : {}),
        });
        objects.push(seq);
        pushCompiled(objects, column, {
          parent,
          name: columnSql,
          provenance: columnProvenance,
          dependencies: [seq.identity],
        });
      });
    } else if (draft !== undefined) {
      jobs.push((objects) => {
        bindGenerated(column, handles, byField);
        const compile = readSeriesCompiler();
        if (compile === undefined) {
          definition(
            "Import sequence from okmodel/seq before schema() when a column uses sequence().",
          );
        }
        compile({
          tableName: item.name,
          sqlName,
          columnSql,
          column,
          draft,
          options,
          namespace,
          provenance,
          parent,
          columnProvenance,
          columns: byField,
          handles,
          tableDependencies,
          objects,
          finish: (dependencies) =>
            pushCompiled(objects, column, {
              parent,
              name: columnSql,
              provenance: columnProvenance,
              ...(dependencies !== undefined ? { dependencies } : {}),
            }),
        });
      });
    } else {
      jobs.push((objects) => {
        bindGenerated(column, handles, byField);
        pushCompiled(objects, column, {
          parent,
          name: columnSql,
          provenance: columnProvenance,
        });
      });
    }
    const prepared: PreparedColumn = {
      field,
      sqlName: columnSql,
      dataType: formatType(
        column.state.typeDependency === undefined
          ? column.state.baseType
          : printedIdentifier(column.state.typeDependency),
        column.state.dims,
      ),
      state: column.state,
      time: column.state.time && (column.state.time.mode ?? codecs.timestamps),
    };
    columns.push(prepared);
    byField.set(field, prepared);
    bySql.set(prepared.sqlName, prepared);
    handles[field] = columnHandle(prepared.sqlName);
    if (column.state.primaryKey) {
      if (column.state.nullable) {
        catalogError("OKM1020", `Primary key ${item.name}.${field} is nullable.`);
      }
      columnPrimary.push(prepared.sqlName);
    }
    if (column.state.defaultSql === "uuidv7()") {
      refuseUuidV7(requires);
    }
    const labels = column.state.enumLabels;
    if (labels !== undefined) {
      noteEnum(
        enums,
        labels,
        column.state.typeDependency ?? prepared.sqlName,
        sqlName,
        provenance,
        column.state.enumComment,
        column.state.enumGrants,
      );
    }
    const composite = compositeMark(column.state.encode);
    if (composite !== undefined) {
      for (const item of composite.enums) {
        noteEnum(enums, item.labels, item.name, sqlName, provenance, item.comment, item.grants);
      }
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
    compileIndexes(
      item.name,
      options,
      handles,
      parent,
      provenance,
      jobs,
      bare,
      (field) => byField.get(field)?.sqlName ?? field,
    );
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
    presets: applied?.presets ?? options?.presets,
    ...(options?.foreignKeys !== undefined ? { foreignKeys: options.foreignKeys } : {}),
    handles,
    ...archiveModel(item),
  };
}

function rememberSequenceGrants(prepared: readonly Prepared[]): void {
  for (const item of prepared) {
    for (const column of item.columns) {
      const grants = column.state.identity?.grants;
      if (grants === undefined) continue;
      rememberGrants(
        "sequence",
        "public",
        identitySequenceName(item.sqlName, column.sqlName),
        grants,
      );
    }
  }
  for (const item of prepared) {
    for (const column of item.columns) {
      const draft = column.state.seriesDraft;
      if (
        draft?.grants === undefined ||
        draft.reset !== undefined ||
        draft.when !== undefined ||
        (draft.scope?.length ?? 0) > 0
      ) {
        continue;
      }
      const name =
        draft.name.length > 0 ? draft.name : identitySequenceName(item.sqlName, column.sqlName);
      rememberGrants("sequence", "public", name, draft.grants);
    }
  }
}

function bindGenerated(
  column: ColumnView,
  handles: Readonly<Record<string, ColumnHandle>>,
  byField: ReadonlyMap<string, PreparedColumn>,
): void {
  const generated = column.state.generated;
  if (
    generated === undefined ||
    generated.build === undefined ||
    generated.expression !== undefined
  ) {
    return;
  }
  (generated as { expression: string }).expression = holdGenerated(
    generated.build,
    handles,
    (field) => byField.get(field)?.sqlName ?? field,
  );
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
    if (column.state.unique !== undefined) uniques.push([column.field]);
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
  column.state.domain?.emit?.(input.parent.namespace, input.provenance, objects);
  const mark = compositeMark(column.state.encode);
  if (mark !== undefined) {
    if (column.state.generated?.stored === false) {
      definition(
        `A virtual generated column cannot use composite type ${mark.type}. PostgreSQL refuses it (0A000). Store the column.`,
      );
    }
    mark.emit(input.parent, input.provenance, objects, input.name, column.state.nullable);
  }
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
  bare: boolean,
  sqlNameOf: (field: string) => string,
): void {
  const build = options?.indexes;
  if (build === undefined) {
    return;
  }
  bindIndexNames(sqlNameOf);
  let calls: readonly IndexCall[];
  try {
    calls = build(handles);
  } finally {
    clearIndexNames();
  }
  if (!Array.isArray(calls)) {
    definition(`Table ${tableName} indexes must return an array.`);
  }
  for (const call of calls) {
    if (bare && call.tenantGlobal !== undefined) {
      definition(`Table ${tableName} index().global() needs tenancy.`);
    }
    if (bare && call.tenantScoped === true) {
      definition(`Table ${tableName} index().scoped() needs tenancy.`);
    }
    const built = readIndex(tableName, call);
    stage(jobs, () =>
      catalogIndex({
        parent,
        columns: built.columns,
        unique: built.isUnique === true,
        nameKey: built.columns.length > 0 ? built.columns.join("_") : "expr",
        name: built.sqlName,
        predicate: built.predicate,
        expression: built.expression,
        method: built.method,
        include: built.included,
        elements: built.elements,
        storage: built.storage,
        nullsNotDistinct: built.nullsNotDistinct,
        ...(built.commentText !== undefined ? { comment: built.commentText } : {}),
        provenance,
      }),
    );
  }
}

type CheckBuild = (columns: Readonly<Record<string, ColumnHandle>>) => SqlText;

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
    const fn: CheckBuild =
      (build as { readonly expression?: CheckBuild }).expression ?? (build as CheckBuild);
    const used: string[] = [];
    let made: CatalogObject | undefined;
    const value = fn(track(handles, used));
    const text = readCheck(tableName, name, value);
    const columns: string[] = [];
    for (const field of used) {
      const column = byField.get(field);
      if (column !== undefined) {
        columns.push(column.sqlName);
      }
    }
    stage(
      jobs,
      () => (
        (made = constraint({
          parent,
          constraintKind: "check",
          columns,
          nameKey: name,
          expression: text,
          provenance,
          ...(typeof (build as { readonly comment?: unknown }).comment === "string"
            ? { comment: (build as { readonly comment: string }).comment }
            : {}),
        })),
        fn !== build &&
          (build as { readonly enforced?: false }).enforced === false &&
          ((made as { enforced?: false }).enforced = false),
        made
      ),
    );
  }
}

type NormalizedReference = Omit<ReferenceModifier, "onDelete"> & {
  readonly onDelete?: "cascade" | "restrict" | "no action" | "set null" | "set default";
};

function normalizedReference(
  reference: ReferenceModifier | undefined,
): NormalizedReference | undefined {
  if (reference === undefined) return undefined;
  const onDelete = reference.onDelete;
  if (onDelete === undefined || typeof onDelete === "string") {
    return reference as NormalizedReference;
  }
  return {
    ...reference,
    onDelete: "setNull" in onDelete ? "set null" : "set default",
    onDeleteColumns: "setNull" in onDelete ? onDelete.setNull : onDelete.setDefault,
  };
}

function compileForeignKeys(
  item: Prepared,
  byName: ReadonlyMap<string, Prepared>,
  accepted: readonly string[],
  jobs: CatalogJob[],
  edges: FkEdge[],
): void {
  for (const column of item.columns) {
    const reference = normalizedReference(column.state.references);
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
    if (
      (reference.onDelete === "set null" || reference.onUpdate === "set null") &&
      reference.onDeleteColumns === undefined
    ) {
      for (const local of localColumns) {
        if (!local.state.nullable) {
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
          ...(reference.match === "full" ? { match: "full" as const } : {}),
          ...(reference.onDeleteColumns !== undefined
            ? { onDeleteColumns: reference.onDeleteColumns }
            : {}),
        },
        ...(reference.deferrable === "deferred"
          ? { deferrable: true, initially: "deferred" as const }
          : reference.deferrable === "immediate"
            ? { deferrable: true, initially: "immediate" as const }
            : {}),
        ...(reference.comment !== undefined ? { comment: reference.comment } : {}),
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

function compileNamedForeignKeys(
  item: Prepared,
  byName: ReadonlyMap<string, Prepared>,
  jobs: CatalogJob[],
): void {
  const keys = item.foreignKeys?.(item.handles);
  if (keys === undefined) return;
  for (const name of Object.keys(keys)) {
    const spec = keys[name];
    if (spec === undefined) continue;
    const reference = normalizedReference({
      table: spec.references.table,
      columns: spec.references.columns,
      ...(spec.onDelete !== undefined ? { onDelete: spec.onDelete } : {}),
      ...(spec.onUpdate !== undefined ? { onUpdate: spec.onUpdate } : {}),
      ...(spec.match !== undefined ? { match: spec.match } : {}),
      ...(spec.deferrable !== undefined ? { deferrable: spec.deferrable } : {}),
    });
    const target = reference === undefined ? undefined : byName.get(reference.table);
    if (reference === undefined || target === undefined) continue;
    const sqlOf = (found: Prepared, column: string): string =>
      (found.byField.get(column) ?? found.bySql.get(column))?.sqlName ?? column;
    const columns = spec.columns.map((column) => sqlOf(item, column));
    stage(jobs, () =>
      constraint({
        parent: item.parent,
        constraintKind: "foreignKey",
        name,
        columns,
        nameKey: recoveredNameKey("foreignKey", item.parent.name, name, columns),
        provenance: item.provenance,
        ...(spec.comment !== undefined ? { comment: spec.comment } : {}),
        references: {
          parent: target.parent,
          columns: spec.references.columns.map((column) => sqlOf(target, column)),
          ...(reference.onDelete !== undefined ? { onDelete: reference.onDelete } : {}),
          ...(reference.onUpdate !== undefined ? { onUpdate: reference.onUpdate } : {}),
          ...(reference.match === "full" ? { match: "full" as const } : {}),
          ...(reference.onDeleteColumns !== undefined
            ? { onDeleteColumns: reference.onDeleteColumns }
            : {}),
        },
        ...(reference.deferrable === "deferred"
          ? { deferrable: true, initially: "deferred" as const }
          : reference.deferrable === "immediate"
            ? { deferrable: true, initially: "immediate" as const }
            : {}),
      }),
    );
  }
}

function keyFail(
  item: Prepared,
  column: PreparedColumn,
  problem: string,
  accepted: readonly string[],
  input?: string,
): never {
  const message = `Foreign key ${item.tsName}.${column.field} ${problem} Accepted columns: ${list(accepted)}.`;
  if (input === undefined) catalogError("OKM1021", message);
  throwNamed("OKM1021", input, accepted, message);
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
      keyFail(item, column, `includes ${name}, which is not a column.`, accepted, name);
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
        keyFail(
          item,
          column,
          `references ${name} on ${target.tsName}, which is not a column.`,
          accepted,
          name,
        );
      }
      found.push(match);
    }
    if (found.length !== 1 && reference.along === undefined) {
      keyFail(item, column, `on ${target.tsName} is ambiguous. Use foreignKeys.`, accepted);
    }
    return found;
  }
  if (target.primary.length === 0) {
    keyFail(item, column, `on ${target.tsName} has no primary key.`, accepted);
  }
  if (target.primary.length !== 1) {
    keyFail(item, column, `on ${target.tsName} is ambiguous.`, target.primary);
  }
  const sqlName = target.primary[0] ?? "";
  const match = target.bySql.get(sqlName);
  if (match === undefined) {
    keyFail(item, column, `on ${target.tsName} is missing its target.`, accepted);
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

function readCasing(casing: Casing | undefined): Casing | undefined {
  if (casing !== undefined && casing !== "snake" && casing !== "camel") {
    definition(`schema() casing ${String(casing)} must be snake or camel.`);
  }
  return casing;
}

function readCodecs(
  codecs: SchemaInput<readonly AnyTable[]>["codecs"],
  timestamps: TimeMode,
): SchemaCodecs {
  const bigint = codecs?.bigint ?? "string";
  const numeric = codecs?.numeric ?? "string";
  if (!BIGINT_CODECS.has(bigint)) {
    definition(`schema() codecs.bigint ${String(bigint)} must be string, number, or bigint.`);
  }
  if (!NUMERIC_CODECS.has(numeric)) {
    definition(`schema() codecs.numeric ${String(numeric)} must be string or number.`);
  }
  if (codecs?.timestamps !== undefined) {
    definition(
      'schema() codecs.timestamps moved to defaults.time, for example defaults: { time: "temporal" }.',
    );
  }
  return { bigint, numeric, timestamps };
}

function tableModel(
  item: Prepared,
  edges: readonly FkEdge[],
  byName: ReadonlyMap<string, Prepared>,
  accepted: readonly string[],
  scopeFields: readonly string[] | undefined,
): TableModel {
  const primary: string[] = [];
  for (const sqlName of item.primary) {
    const column = item.bySql.get(sqlName);
    if (column !== undefined) primary.push(column.field);
  }
  let conceal = false;
  const columns: ColumnModel[] = item.columns.map((column) => {
    const state = column.state;
    const hidden = state.filterable === true ? "filter" : state.hidden;
    if (hidden || state.sensitive) conceal = true;
    const writable =
      state.guarded !== true && state.omitWrite !== true && state.generated === undefined;
    const fill = state.clientDefault;
    return {
      field: column.field,
      sql: column.sqlName,
      dataType: column.dataType,
      encode: state.encode as (value: unknown) => string,
      decode: state.decode === decodeText ? undefined : state.decode,
      hidden,
      sensitive: state.sensitive,
      guarded: state.guarded,
      writable,
      guardUpdate: writable && primary.includes(column.field),
      ...(fill !== undefined ? { fill, clientDefault: "client" as const } : {}),
      ...(state.dims > 0 ? { elementEncode: state.elementEncode } : {}),
      accepts: state.accepts,
      ...(column.time !== undefined ? { time: column.time } : {}),
      nullable: state.nullable,
    };
  });
  return {
    name: item.tsName,
    sql: item.sqlName,
    primary,
    uniques: item.uniques,
    columns,
    relations: resolveRelations(item, edges, byName, accepted, scopeFields),
    ...(conceal ? { conceal: true as const } : {}),
    ...(item.traits !== undefined ? { traits: item.traits } : {}),
    ...(item.provenance.source !== undefined ? { source: item.provenance.source } : {}),
    ...(item.archive !== undefined ? { archive: item.archive } : {}),
    ...(item.presets !== undefined ? { presets: item.presets } : {}),
  };
}

function resolveRelations(
  item: Prepared,
  edges: readonly FkEdge[],
  byName: ReadonlyMap<string, Prepared>,
  accepted: readonly string[],
  scopeFields: readonly string[] | undefined,
): readonly RelationModel[] {
  const raw = item.relationOptions;
  if (raw === undefined) return [];
  const describe = (table: string) => byName.get(table);
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
        `Table ${item.tsName} relation ${name} is not a relation. one(), many(), manyThrough(), morph(), and morphMany() are accepted.`,
      );
    }
    const own = (call as Partial<ManyThroughRelation>).resolve;
    if (own !== undefined) {
      resolved.push(
        own({
          owner: item.tsName,
          name,
          edges,
          tables: accepted,
          describe,
          ...(scopeFields === undefined ? {} : { scopeFields }),
        }),
      );
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
    const one = call.kind === "one";
    const matches = edges.filter(
      (edge) =>
        (one ? edge.fromTable : edge.toTable) === item.tsName &&
        (one ? edge.toTable : edge.fromTable) === call.table &&
        (field === undefined || edge.fromField === field),
    );
    const edge = matches[0];
    if (matches.length !== 1 || edge === undefined) {
      const hint = matches.map((found) => found.fromField).sort();
      catalogError(
        "OKM1021",
        `Relation ${item.tsName}.${name} on ${call.table} is ambiguous. Accepted columns: ${hint.length === 0 ? "none" : hint.join(", ")}.`,
      );
    }
    resolved.push(
      one
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
    if (column === undefined || column.state.nullable) {
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
 * Applies `defaults.time` to a date or time column that names no mode.
 *
 * @param column - Column as declared
 * @param mode - Schema time default
 * @returns The column with that mode's codec, and its mode recorded
 */
function applySchemaTime(column: ColumnView, mode: TimeMode): ColumnView {
  const time = column.state.time;
  if (time === undefined || time.mode !== undefined || mode === "iso") return column;
  return retimed(column.state, mode, time.codec(mode)) as unknown as ColumnView;
}

/**
 * Reads `defaults.time`. Called after {@link readIdDefault} checked the object.
 *
 * @param defaults - Schema option
 * @returns The mode, `"iso"` when omitted
 */
function readTimeDefault(defaults: SchemaDefaults | undefined): TimeMode {
  return timeMode(defaults?.time ?? "iso", "schema() defaults.time");
}

function requireTemporalHook(): void {
  if (!hasTemporal()) temporalMissing();
}

/**
 * Reads `defaults.id`.
 *
 * @param defaults - Schema option
 * @returns The id default, or `undefined` when the option is omitted
 */
function readIdDefault(defaults: SchemaDefaults | undefined): SchemaIdDefault | undefined {
  if (defaults === undefined) return undefined;
  if (typeof defaults !== "object" || defaults === null) {
    definition("schema() defaults must be an object.");
  }
  for (const key of Object.keys(defaults)) {
    if (key !== "id" && key !== "time") {
      definition(`schema() defaults.${key} is not a schema default. Accepted names: id, time.`);
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
 * Rejects `uuidv7()` when the schema declares a Postgres older than the feature.
 *
 * A bare `t.id()` stores `gen_random_uuid()` and is not this expression.
 * An omitted floor does not name a version, so an explicit `uuidv7()` stays until apply.
 *
 * @param requires - Declared engine range
 */
function refuseUuidV7(requires: SchemaRequires | undefined): void {
  const declared = parsePostgresFloor(requires?.postgres);
  if (!(declared > 0) || declared >= UUIDV7_POSTGRES) return;
  const sentence = uuidv7NeedsPostgres();
  throw new OkmError("OKM1812", sentence, { fix: { summary: sentence } });
}

/**
 * Normalises `minPostgres` and the deprecated string form to one floor.
 *
 * Passing both is an error. Any other value is an error. Omitted is `undefined`.
 * An empty `requires` object stores `{}`.
 *
 * @param minPostgres - Numeric floor
 * @param requires - Deprecated `{ postgres }` range
 * @returns The stored floor, or `undefined` when neither key was passed
 */
function readFloor(minPostgres: unknown, requires: unknown): SchemaRequires | undefined {
  if (minPostgres !== undefined && requires !== undefined) {
    definition("minPostgres or requires.postgres, not both.");
  }
  if (minPostgres === undefined && requires === undefined) return undefined;
  let major = minPostgres;
  if (minPostgres === undefined) {
    if (typeof requires !== "object" || requires === null || Array.isArray(requires)) {
      definition(minPostgresDefinition());
    }
    const postgres = (requires as { readonly postgres?: unknown }).postgres;
    if (postgres === undefined) return {};
    major = typeof postgres === "string" ? parsePostgresFloor(postgres) : NaN;
  }
  if (!isPostgresMajor(major)) definition(minPostgresDefinition());
  return { postgres: formatPostgresFloor(major) };
}

function readIndex(tableName: string, call: IndexCall): IndexCall {
  if (call.sqlName !== undefined && call.sqlName.length === 0) {
    definition(`Index on ${tableName} name must be a non-empty SQL identifier.`);
  }
  if (call.columns.length === 0 && call.expression === undefined) {
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
