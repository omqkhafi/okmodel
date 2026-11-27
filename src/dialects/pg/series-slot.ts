/**
 * Series options a column carries until `schema()` reads them.
 *
 * SQL, triggers, and checks stay out of this file. `okmodel/seq` installs the compiler.
 */

import type {
  CatalogObject,
  ObjectIdentity,
  ObjectRef,
  Provenance,
} from "../../contracts/catalog/types.js";

/** How a counter starts again. A string is one calendar unit. */
export type SeriesResetDraft =
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | {
      readonly every: number;
      readonly unit: "day" | "week" | "month" | "quarter" | "year";
      readonly from: string;
    };

/** Options stored on the column builder. Names are field names. */
export type SeriesDraft = {
  readonly name: string;
  readonly as: "smallint" | "integer" | "bigint";
  readonly start?: string;
  readonly increment?: string;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
  readonly reset?: SeriesResetDraft;
  readonly at?: string;
  readonly by?: string;
  readonly scope?: readonly string[];
  readonly when?: (columns: Readonly<Record<string, { readonly name: string }>>) => unknown;
  readonly moves?: "refuse" | "renumber";
  readonly grants?: unknown;
  readonly comment?: string;
};

/**
 * A counter is required when the series is scoped, reset, or deferred, or the table is a tenant table.
 *
 * `via()` has no tenant column. A global table is not a tenant table.
 *
 * @param draft - Series options
 * @param options - Table options after the tenancy rewrite
 * @returns `true` when the number is a counter, not a native sequence
 */
export function counterSeries(draft: SeriesDraft, options: object | undefined): boolean {
  if (draft.reset !== undefined || draft.when !== undefined || (draft.scope?.length ?? 0) > 0) {
    return true;
  }
  if (options === undefined) return false;
  const record = options as {
    tenantKeys?: readonly string[];
    tenancy?: { via?: unknown };
  };
  if (record.tenantKeys !== undefined && record.tenantKeys.length > 0) return true;
  const tenancy = record.tenancy;
  return typeof tenancy === "object" && tenancy !== null && typeof tenancy.via === "string";
}

/**
 * Whether the table is isolated by `via()` and has no tenant column.
 *
 * @param options - Table options after the tenancy rewrite
 * @returns `true` when `tenancy` is a `via()` path
 */
export function viaSeries(options: object | undefined): boolean {
  if (options === undefined) return false;
  const tenancy = (options as { tenancy?: { via?: unknown } }).tenancy;
  return typeof tenancy === "object" && tenancy !== null && typeof tenancy.via === "string";
}

/** Turns a series draft into catalog objects. Installed by `okmodel/seq`. */
export type SeriesCompiler = (input: {
  readonly tableName: string;
  readonly sqlName: string;
  readonly columnSql: string;
  readonly column: { readonly state: object };
  readonly draft: SeriesDraft;
  readonly options: object | undefined;
  readonly namespace: ObjectRef["namespace"];
  readonly provenance: Provenance;
  readonly parent: ObjectRef;
  readonly columnProvenance: Provenance;
  readonly columns: ReadonlyMap<string, { readonly sqlName: string; readonly dataType: string }>;
  readonly handles: Readonly<Record<string, { readonly name: string }>>;
  readonly tableDependencies: ObjectIdentity[];
  readonly objects: CatalogObject[];
  finish(dependencies?: readonly ObjectIdentity[]): void;
}) => void;

let compiler: SeriesCompiler | undefined;

/**
 * Installs the series compiler. A later call replaces it.
 *
 * @param next - Compiler `schema()` runs when a column carries a series
 */
export function installSeriesCompiler(next: SeriesCompiler): void {
  compiler = next;
}

/**
 * Reads the installed compiler.
 *
 * @returns The compiler, or `undefined` when `okmodel/seq` was not imported
 */
export function readSeriesCompiler(): SeriesCompiler | undefined {
  return compiler;
}
