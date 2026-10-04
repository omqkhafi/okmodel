/**
 * The tenancy object `schema()` calls once.
 *
 * The methods live on the value `columnTenancy()` returns from `okmodel/tenancy`.
 * This file only names them. An application that never imports that subpath
 * does not load them.
 */

import type { ColumnBuilder, FlagTrue, PlainFlags } from "./column.js";
import type { SchemaHookCtx } from "./model.js";
import { definition } from "./misuse.js";
import type { AnyTable } from "./table.js";

/**
 * A guarded uuid column, one per tenant table.
 *
 * Insert and update omit it. The client fills it from the scope.
 */
export type TenantFields<Key extends string> = {
  readonly [K in Key]: ColumnBuilder<string, FlagTrue<PlainFlags, "guarded">>;
};

/** One tenant value, or a reason for leaving the scope. The value is not a cache key. */
export type TenantCall = { readonly value: string } | { readonly unscoped: string };

/** Text the scope predicate writes. The planner's sink has these methods. */
export type TenancyText = {
  text(value: string): void;
  param(encoded: string): void;
  mark(token: string): void;
};

/** `for()` and `unscoped()` plus the table names the root client keeps. */
export type TenancyClient = {
  readonly names: readonly string[];
  readonly for?: (input: unknown) => unknown;
  readonly unscoped?: (reason: string) => unknown;
};

/** One inspect rule the tenancy object recorded. */
export type TenancyRule = {
  readonly rule: string;
  readonly contribution: string;
  readonly provenance: string;
  readonly source?: string;
};

/**
 * Column tenancy passed to `schema({ tenancy })`.
 *
 * `columnTenancy()` from `okmodel/tenancy` builds it. `rewrite` runs once,
 * before compile. The other methods are the planner and the client.
 */
export type ColumnTenancy = {
  readonly key: string;
  readonly type: "uuid";
  readonly strategy: "column";
  /** Tables with the tenant column, widened uniques, and composite references. */
  rewrite(tables: readonly AnyTable[]): readonly AnyTable[];
  /** The guarded uuid column, for emitted row types. */
  column(): object;
  predicate(input: {
    readonly table: string;
    readonly fieldSql: (field: string) => string | undefined;
    readonly encode: ((value: unknown) => string) | undefined;
    readonly alias: string;
    readonly appended: boolean;
    readonly scope: TenantCall | undefined;
    readonly sink: TenancyText;
  }): boolean;
  guard(table: string, field: string, kind: "where" | "insert" | "update"): void;
  stamp(table: string, rows: Record<string, unknown>[], scope: TenantCall | undefined): void;
  client(input: {
    readonly names: readonly string[];
    readonly scoped: boolean;
    readonly open: (scope: TenantCall) => unknown;
  }): TenancyClient;
  rules(
    table: string,
    source: string | undefined,
    scope: TenantCall | undefined,
  ): readonly TenancyRule[];
  /**
   * Attaches `for()` and `unscoped()` on the root client.
   *
   * The same hook archivable uses for its table methods.
   *
   * @param target - The client object
   * @param ctx - Names, scope, and the table map
   */
  hook(target: Record<string, unknown>, ctx: SchemaHookCtx): void;
  missing(table: string): never;
};

/**
 * Reads `schema({ tenancy })`.
 *
 * Omitted stays `undefined`. Anything else must be `columnTenancy()`.
 *
 * @param value - The option the caller passed
 * @returns The tenancy object, or `undefined`
 */
export function readTenancy(value: unknown): ColumnTenancy | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    definition("schema() tenancy must be columnTenancy() from okmodel/tenancy.");
  }
  const record = value as Record<string, unknown>;
  if (record.strategy !== "column" || typeof record.rewrite !== "function") {
    definition("schema() tenancy must be columnTenancy() from okmodel/tenancy.");
  }
  return value as ColumnTenancy;
}
