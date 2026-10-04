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
};

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
  readonly reopen?: (view?: "with" | "only") => Record<string, unknown>;
  readonly session?: object;
};

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
