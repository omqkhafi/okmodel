/**
 * Runtime table model the read path compiles against.
 *
 * `schema()` fills it once. Query planning does not walk column builders again.
 */

import type { ClientFill } from "../../contracts/generator.js";

/** One column the planner can filter, select, decode, and write. */
export type ColumnModel = {
  /** Field name. */
  readonly field: string;
  /** SQL name, already checked as an identifier. */
  readonly sql: string;
  /** Catalog type, used when a value is projected through JSON. */
  readonly dataType: string;
  /** Codec encode. Identity text still returns the same string. */
  readonly encode: (value: unknown) => string;
  /**
   * Codec decode.
   *
   * Omitted when the wire text is the TypeScript value, so a row does not
   * call a codec it does not need.
   */
  readonly decode: ((wire: string) => unknown) | undefined;
  /** Excluded from a default select. Named selects still return it. Includes never return it. */
  readonly hidden: boolean;
  /**
   * Redacted in logs, errors, and `inspect()`.
   *
   * A selected read still returns the value.
   */
  readonly sensitive: boolean;
  /** Refused when present in insert or update input, unless `{ allow }` names it. */
  readonly guarded: boolean;
  /** Included in insert and update. Guarded, generated, and omitted columns are not. */
  readonly writable: boolean;
  /** Refused on update. Insert may still set it. A caller-supplied primary key. */
  readonly guardUpdate: boolean;
  /**
   * Catalog-output label for a client default.
   *
   * The hashed catalog does not store it. Changing the generator does not
   * change the catalog hash.
   */
  readonly clientDefault?: "client";
  /** Called once per inserted row when the field is omitted. */
  readonly fill?: ClientFill;
  /**
   * Encodes one array element.
   *
   * Present on array columns. `arr.append` and `arr.remove` use it.
   */
  readonly elementEncode?: (value: unknown) => string;
  /**
   * Object kinds the codec takes as input, named by `Object.prototype.toString`.
   *
   * Absent when the codec takes only scalars; the planner then rejects every
   * object for the column (OKM1121).
   */
  readonly accepts?: readonly string[] | undefined;
};

/**
 * A resolved relation.
 *
 * The join is always `related.{remote} = this.{local}`.
 */
export type RelationModel = {
  readonly name: string;
  readonly kind: "one" | "many";
  /** Related table's TypeScript name. */
  readonly table: string;
  /** SQL names on this table. */
  readonly local: readonly string[];
  /** SQL names on the related table. */
  readonly remote: readonly string[];
  /**
   * Set on a `manyThrough` relation.
   *
   * `local` and `remote` then join the join table to this table: `remote` names
   * columns of the join table. The pairs below join the join table to `table`.
   */
  readonly through?: {
    /** Join table, by its TypeScript name. */
    readonly table: string;
    /** SQL names on the join table. */
    readonly local: readonly string[];
    /** SQL names on the related table. */
    readonly remote: readonly string[];
    /**
     * Writes the join-table source and its link to the parent.
     *
     * The relation carries its own emitter, so a schema without `manyThrough`
     * does not ship it. The planner passes its helpers in.
     */
    readonly emit: ThroughEmit;
  };
};

/** Where a planner writes SQL text and statement marks. */
export type RelationSink = {
  text(value: string): void;
  param(encoded: string): void;
  mark(token: string): void;
};

/** A table with its columns and relations indexed by name, as the planner holds it. */
export type PlannedTable = {
  readonly model: TableModel;
  readonly columns: ReadonlyMap<string, ColumnModel>;
  readonly relations: ReadonlyMap<string, RelationModel>;
  readonly names: readonly string[];
};

/** The planner helpers a relation emitter calls. */
export type RelationPlanner = {
  /** Writes `child.remote = parent.local` for each key column. */
  readonly join: (
    sink: RelationSink,
    parent: string,
    child: string,
    relation: RelationModel,
  ) => void;
  /** Writes `where` predicates, including tenancy and active-set ones, for a table. */
  readonly where: (
    schema: QuerySchema,
    table: PlannedTable,
    where: unknown,
    sink: RelationSink,
    alias: string,
    depth: number,
    appended: boolean,
  ) => void;
  /** Indexes a schema's tables by TypeScript name. */
  readonly indexes: (schema: QuerySchema) => ReadonlyMap<string, PlannedTable>;
  /** Quotes an identifier. */
  readonly quote: (name: string) => string;
};

/**
 * Writes `<join> <alias> join <table> ... where <link to parent>` for a
 * `manyThrough` relation. The caller adds the related table's own predicates.
 */
export type ThroughEmit = (
  planner: RelationPlanner,
  schema: QuerySchema,
  relation: RelationModel,
  child: PlannedTable,
  sink: RelationSink,
  parent: string,
  alias: string,
  depth: number,
) => void;

/**
 * One foreign key the archive path follows.
 *
 * `local` and `remote` are SQL names, in the same order. `at` and `id` are
 * the other table's archive columns.
 */
export type ArchiveLink = {
  readonly table: string;
  readonly sql: string;
  readonly at: string;
  readonly id: string;
  readonly local: readonly string[];
  readonly remote: readonly string[];
};

/**
 * Archive columns and the children and parents resolved at schema time.
 *
 * Absent when the table is not archivable, so a normal table does not carry it.
 */
export type ArchiveModel = {
  /** SQL name of `archivedAt`. */
  readonly at: string;
  /** SQL name of `archiveId`. */
  readonly id: string;
  /** Field name of `archivedAt`. */
  readonly atField: string;
  /** Field name of `archiveId`. */
  readonly idField: string;
  /** Children archived and restored with this row. */
  readonly cascade: readonly ArchiveLink[];
  /** Archivable tables this row references. Restore refuses an archived one. */
  readonly parents: readonly ArchiveLink[];
};

/** One table, keyed by its TypeScript name on the schema. */
export type TableModel = {
  readonly name: string;
  readonly sql: string;
  /** Primary-key field names, in catalog order. */
  readonly primary: readonly string[];
  /**
   * Field lists that `onConflict.on` may name.
   *
   * Each list is a primary key or a unique constraint. Order is the catalog order.
   */
  readonly uniques: readonly (readonly string[])[];
  readonly columns: readonly ColumnModel[];
  readonly relations: readonly RelationModel[];
  /**
   * Traits that apply to this table.
   *
   * Absent when it has none. Writes read `touch` and `sealed` from here.
   */
  readonly traits?: readonly {
    readonly name: string;
    readonly touch?: readonly string[];
    readonly sealed?: readonly string[];
  }[];
  /**
   * A column is hidden or sensitive.
   *
   * Absent when none are, so a normal table does not carry the flag.
   */
  readonly conceal?: true;
  /**
   * `file.ts:line` where the table was defined.
   *
   * Absent on a catalog loaded from a build artifact. Not part of the hash.
   */
  readonly source?: string;
  /**
   * Archive columns, cascade, and parent links.
   *
   * Absent when the table is not archivable.
   */
  readonly archive?: ArchiveModel;
  /**
   * The table's presets by name: its own and its traits', merged.
   *
   * Absent when it has none, so a normal table does not carry the key. The
   * values are the author's functions; the preset module runs them.
   */
  readonly presets?: Readonly<Record<string, unknown>>;
  /**
   * Validation for this table.
   *
   * Absent until the engine fills it on the first validated call. `schema()`
   * does not pack it, so a featureless table never carries it.
   */
  readonly validation?: ValidationModel;
};

/**
 * Rules and derived checks for one table.
 *
 * Field rules and picklists are stored here. Column codecs stay on {@link ColumnModel}.
 */
export type ValidationModel = {
  /** Run the same checks on read results. Stored for a later step. */
  readonly onRead: boolean;
  /** Cross-field rules from `validate.$row`, in source order. */
  readonly row: readonly unknown[];
  /** Per-field rules. Absent fields have none. */
  readonly fields: Readonly<Record<string, readonly unknown[]>>;
  /** Insert must include these fields. */
  readonly required: readonly string[];
  /** `null` is rejected. Includes columns that have a default. */
  readonly notNull: readonly string[];
  /** Picklist values, keyed by field. Absent fields have no list. */
  readonly pick: Readonly<Record<string, readonly string[]>>;
};

/**
 * One opt-in feature attaching methods to the client or a table handle.
 *
 * Tenancy supplies `for()` and `unscoped()`. Archivable supplies `archive()`,
 * `restore()`, `withArchived()`, and `onlyArchived()`. Core only calls the list.
 */
export type SchemaHook = (target: Record<string, unknown>, ctx: SchemaHookCtx) => void;

/**
 * What the client passes to a {@link SchemaHook}.
 *
 * A client-level call sets `tables`. A table-level call sets `table`.
 */
export type SchemaHookCtx = {
  readonly names?: readonly string[];
  readonly tables?: Record<string, unknown>;
  readonly scoped?: boolean;
  readonly open?: (scope: { readonly value: string } | { readonly unscoped: string }) => unknown;
  readonly table?: string;
  readonly view?: "with" | "only";
  /** The last preset chained on this handle. Absent when none is. */
  readonly uses?: PresetUse | undefined;
  readonly reopen?: (view?: "with" | "only") => Record<string, unknown>;
  readonly session?: object;
};

/**
 * One preset call on a table handle: the call before it, its name, and its arguments.
 *
 * A chain is a linked list, newest first, so adding a call allocates one tuple.
 */
export type PresetUse = readonly [
  before: PresetUse | undefined,
  name: string,
  args: readonly unknown[],
];

/** Schema fields the read path and `connect()` read. */
export type QuerySchema = {
  readonly "~byName": { readonly [name: string]: { readonly "~row": unknown } };
  readonly model: Readonly<Record<string, TableModel>>;
  readonly requires?: { readonly postgres?: string } | undefined;
  /** Column tenancy, when the schema set it. The methods live on that object. */
  readonly tenancy?: import("./tenancy.js").ColumnTenancy;
  /**
   * Opt-in methods for the client and table handles.
   *
   * Absent when the schema uses none, so a featureless app does not carry the key.
   */
  readonly hooks?: readonly SchemaHook[];
};
