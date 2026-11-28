/**
 * Data `schema()` keeps until the first `.catalog` read.
 *
 * Types only. The featureless app does not load the compiler that reads them.
 */

import type { ConstraintInput, IndexInput } from "../../contracts/catalog/object.js";
import type {
  Namespace,
  ObjectIdentity,
  ObjectRef,
  Provenance,
} from "../../contracts/catalog/types.js";
import type { Names } from "./casing.js";
import type { ColumnState } from "./column.js";
import type { AnyTable, ColumnHandle } from "./table.js";
import type { Trait } from "./trait.js";

/** One enum `schema()` noticed while reading columns. */
export type EnumNote = {
  readonly labels: readonly string[];
  readonly table: string;
  readonly provenance: Provenance;
  readonly comment?: string;
  readonly grants?: unknown;
};

/** A check whose `enforced: false` is applied after the constraint object exists. */
export type HeldCheck = {
  readonly input: ConstraintInput;
  /** Set only when the author passed `enforced: false` on a check object. */
  readonly enforced?: false;
};

/** One column the compiler emits. The state object is the builder's. */
export type CompileColumn = {
  readonly field: string;
  readonly sqlName: string;
  readonly state: ColumnState<unknown>;
  readonly provenance: Provenance;
};

/**
 * One table, already validated, waiting for catalog objects.
 *
 * Constraint and index inputs are plain data. The factories run in the compiler.
 */
export type CompileTable = {
  readonly tsName: string;
  readonly sqlName: string;
  readonly parent: ObjectRef;
  readonly provenance: Provenance;
  readonly options: { readonly comment?: string } | undefined;
  readonly columns: readonly CompileColumn[];
  readonly byField: ReadonlyMap<
    string,
    { readonly sqlName: string; readonly dataType: string; readonly state: ColumnState<unknown> }
  >;
  readonly handles: Readonly<Record<string, ColumnHandle>>;
  /** Filled by a series while the compiler runs. Empty when the table object is built. */
  readonly tableDependencies: ObjectIdentity[];
  readonly primaryKey?: ConstraintInput;
  readonly exclusions: readonly ConstraintInput[];
  readonly namedUniques: readonly ConstraintInput[];
  readonly indexes: readonly IndexInput[];
  readonly checks: readonly HeldCheck[];
};

/**
 * Everything the catalog compiler needs from one `schema()` call.
 *
 * Built while the query model is built. Nothing here imports the factories.
 */
export type CatalogCompileInput = {
  readonly namespace: Namespace;
  readonly names: Names;
  readonly requires: { readonly postgres?: string } | undefined;
  readonly tables: readonly AnyTable[];
  readonly prepared: readonly CompileTable[];
  readonly enums: ReadonlyMap<string, EnumNote>;
  readonly extensions: unknown;
  readonly functions: unknown;
  readonly triggers: unknown;
  readonly views: unknown;
  readonly sequences: unknown;
  readonly schemaTraits: readonly Trait[] | undefined;
  readonly extra: { readonly gist: boolean };
  readonly foreignKeys: readonly ConstraintInput[];
  /** Tenant field names, in key order. Absent when the schema has no tenancy. */
  readonly tenancyFields?: readonly string[];
  /** True for a path table, which has no tenant column of its own. */
  readonly isPath?: (table: string) => boolean;
};
