/**
 * Types `okmodel/validate` adds to a table handle.
 *
 * Nothing here exists at runtime. `index.ts` merges these members into
 * `TableExtras` with a module augmentation, so a program that never imports
 * `okmodel/validate` does not see them and does not pay for them.
 */

import type { ValidationIssue } from "../../contracts/error.js";
import type { InputMark } from "../../contracts/rows.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import type { InsertOf, OptionalInsert, RequiredInsert, UpdateOf } from "../types.js";

/**
 * Reads one stored `validation` option: a boolean or `{ enabled, onRead, style }`.
 *
 * An object without `enabled` is on, as it is at runtime.
 *
 * @typeParam V - The option as the caller wrote it, or `undefined`
 */
type Enabled<V> = V extends true
  ? true
  : V extends { readonly enabled: infer E }
    ? E extends true
      ? true
      : false
    : V extends object
      ? true
      : false;

/** The `validation` option a table's own `options` carry, or `never` when it sets none. */
type TableOption<T> = T extends { readonly options?: infer O }
  ? O extends { readonly validation: infer V }
    ? V
    : never
  : never;

/**
 * The effective setting for one table: its own option, else the schema's.
 *
 * @typeParam S - Connected schema
 * @typeParam K - Table name
 */
export type ValidationOn<S extends QuerySchema, K extends keyof S["~byName"]> = Enabled<
  [TableOption<S["~byName"][K]>] extends [never]
    ? S extends { readonly "~validation": infer V }
      ? V
      : undefined
    : TableOption<S["~byName"][K]>
>;

/** Insert shape plus {@link InputMark}. */
type Marked<S extends QuerySchema, K extends keyof S["~byName"]> = InsertOf<S, K> & InputMark;

/**
 * One insert body, with optional columns left optional and the input mark.
 *
 * Guarded fields and the tenant key are already absent from the shape.
 *
 * @typeParam S - Connected schema
 * @typeParam K - Table name
 */
export type InputBody<S extends QuerySchema, K extends keyof S["~byName"]> = RequiredInsert<
  Marked<S, K>
> &
  OptionalInsert<Marked<S, K>>;

/** What `validate()` accepts: one body, or a list. */
type Bodies<S extends QuerySchema, K extends keyof S["~byName"]> =
  | InputBody<S, K>
  | readonly Marked<S, K>[];

/**
 * Members `insert` gains when this table validates.
 *
 * @typeParam S - Connected schema
 * @typeParam K - Table name
 */
export type ValidateInsert<S extends QuerySchema, K extends keyof S["~byName"]> =
  ValidationOn<S, K> extends true
    ? {
        /**
         * Checks one row or a list and returns it frozen.
         *
         * A later insert of that value skips these rules.
         */
        validate<const T extends Bodies<S, K>>(body: T): Promise<T>;
        /** The same checks. Issues come back instead of OKM1200. */
        check(body: unknown): Promise<readonly ValidationIssue[]>;
        /** Validates only these fields. */
        pick<const F extends readonly (keyof InsertOf<S, K> & string)[]>(
          ...fields: F
        ): {
          validate(body: unknown): Promise<Pick<InsertOf<S, K>, F[number]> & InputMark>;
          check(body: unknown): Promise<readonly ValidationIssue[]>;
        };
        /** Validates every field except these. */
        omit<const F extends readonly (keyof InsertOf<S, K> & string)[]>(
          ...fields: F
        ): {
          validate(body: unknown): Promise<Omit<InsertOf<S, K>, F[number]> & InputMark>;
          check(body: unknown): Promise<readonly ValidationIssue[]>;
        };
        /** Standard Schema. Issues are returned. Other errors still throw. */
        readonly "~standard": {
          readonly version: 1;
          readonly vendor: "okmodel";
          validate(
            value: unknown,
          ): Promise<{ readonly value: unknown } | { readonly issues: readonly ValidationIssue[] }>;
        };
      }
    : unknown;

/** A patch: any subset of the update shape, plus {@link InputMark}. */
type Patch<S extends QuerySchema, K extends keyof S["~byName"]> = Partial<UpdateOf<S, K>> &
  InputMark;

/**
 * Members `update` gains when this table validates.
 *
 * @typeParam S - Connected schema
 * @typeParam K - Table name
 */
export type ValidateUpdate<S extends QuerySchema, K extends keyof S["~byName"]> =
  ValidationOn<S, K> extends true
    ? {
        /** Checks a patch. A `{ set }` body checks `set`. */
        validate<const T extends Patch<S, K> | { readonly set: Patch<S, K> }>(body: T): Promise<T>;
      }
    : unknown;
