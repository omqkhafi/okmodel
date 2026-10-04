/**
 * Column builder shared by every Postgres type.
 *
 * Modifiers allocate a new builder when called. Importing this module does
 * not build a codec table. `.validate()` stores rules and does not run them.
 */

import {
  REFERENTIAL_ACTIONS,
  referentialAction,
  type ReferentialAction,
} from "../../contracts/catalog/types.js";
import { readClientGenerator, type ClientFill } from "../../contracts/generator.js";
import { readArray, writeArray } from "./array-literal.js";
import { definition, rejected } from "./misuse.js";
import { quoteLiteral } from "./quote.js";

/** Flags that decide the row, insert, and update shapes of one column. */
export type ColumnFlags = {
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
  readonly guarded: boolean;
  readonly hidden: boolean;
  readonly omitWrite: boolean;
  /** Absent from update. Insert still follows {@link InsertKind}. */
  readonly omitUpdate: boolean;
};

/** Flags for a required column with no default. */
export type PlainFlags = {
  readonly nullable: false;
  readonly hasDefault: false;
  readonly generated: false;
  readonly guarded: false;
  readonly hidden: false;
  readonly omitWrite: false;
  readonly omitUpdate: false;
};

/** Flags for {@link id} when the database fills the value. Insert and update omit it. */
export type IdFlags = {
  readonly nullable: false;
  readonly hasDefault: true;
  readonly generated: false;
  readonly guarded: true;
  readonly hidden: false;
  readonly omitWrite: true;
  readonly omitUpdate: true;
};

/**
 * Flags for {@link id} with `default: "none"`.
 *
 * Insert requires the value. Update omits it.
 */
export type IdSuppliedFlags = {
  readonly nullable: false;
  readonly hasDefault: false;
  readonly generated: false;
  readonly guarded: false;
  readonly hidden: false;
  readonly omitWrite: false;
  readonly omitUpdate: true;
};

/** Flags for {@link identity}. The database fills the value. */
export type IdentityFlags = {
  readonly nullable: false;
  readonly hasDefault: true;
  readonly generated: false;
  readonly guarded: false;
  readonly hidden: false;
  readonly omitWrite: true;
  readonly omitUpdate: true;
};

/**
 * Turns one flag on.
 *
 * @typeParam TFlags - Current flags
 * @typeParam K - Flag to set
 */
export type FlagTrue<TFlags extends ColumnFlags, K extends keyof ColumnFlags> = {
  readonly [P in keyof TFlags]: P extends K ? true : TFlags[P];
};

/**
 * Marks a column generated, which also counts as having a default.
 *
 * @typeParam TFlags - Current flags
 */
export type WithGenerated<TFlags extends ColumnFlags> = {
  readonly [P in keyof TFlags]: P extends "generated" | "hasDefault" ? true : TFlags[P];
};

/**
 * Omits a column from update and leaves insert unchanged.
 *
 * @typeParam TFlags - Current flags
 */
export type WithUpdateGuard<TFlags extends ColumnFlags> = {
  readonly [P in keyof TFlags]: P extends "omitUpdate" ? true : TFlags[P];
};

/** How a default expression is spelled in the catalog. */
export type SqlForm = "raw" | "quote" | "json" | "jsonb" | "cast";

/**
 * A foreign key declared on a column.
 *
 * `columns` names the target columns. When it is omitted, `schema()` uses
 * that table's primary key.
 */
export type ReferenceModifier = {
  readonly table: string;
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
  /** Target columns. Several columns make a composite foreign key. */
  readonly columns?: readonly string[];
  /**
   * Other local columns in the foreign key, after this column.
   *
   * Set when the key is composite. Absent on a single-column reference.
   */
  readonly along?: readonly string[];
};

/**
 * Options for {@link ColumnBuilder.references}.
 */
export type ReferenceOptions = {
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
  readonly columns?: readonly string[];
};

/**
 * Validation rules stored on the column. Nothing here interprets them.
 */
export type ValidateModifier = {
  readonly rules: readonly unknown[];
};

/** Nested readonly arrays of rank `D`. Ranks above 3 stay `unknown[]`. */
export type ArrayOf<T, D extends number> = D extends 0
  ? T
  : D extends 1
    ? readonly T[]
    : D extends 2
      ? readonly (readonly T[])[]
      : D extends 3
        ? readonly (readonly (readonly T[])[])[]
        : readonly unknown[];

/**
 * Value stored on a column, including null when the column is nullable.
 *
 * Hidden columns are absent from the default row (`never`).
 *
 * @typeParam TFlags - Column flags
 * @typeParam TValue - Scalar or array value
 */
export type ColumnRow<TFlags extends ColumnFlags, TValue> = TFlags["hidden"] extends true
  ? never
  : TFlags["nullable"] extends true
    ? TValue | null
    : TValue;

/** Whether insert requires the value, allows it to be omitted, or drops it. */
export type InsertKind<TFlags extends ColumnFlags> = TFlags["omitWrite"] extends true
  ? "omit"
  : TFlags["generated"] extends true
    ? "omit"
    : TFlags["guarded"] extends true
      ? "omit"
      : TFlags["hasDefault"] extends true
        ? "optional"
        : TFlags["nullable"] extends true
          ? "optional"
          : "required";

/**
 * Insert shape of one column.
 *
 * `undefined` means the field is omitted. `never` means it is not writable.
 *
 * @typeParam TFlags - Column flags
 * @typeParam TValue - Scalar or array value
 */
export type ColumnInsert<TFlags extends ColumnFlags, TValue> =
  InsertKind<TFlags> extends "omit"
    ? never
    : InsertKind<TFlags> extends "optional"
      ? TFlags["nullable"] extends true
        ? TValue | null | undefined
        : TValue | undefined
      : TValue;

/**
 * Update shape of one column. Writable values are optional.
 *
 * @typeParam TFlags - Column flags
 * @typeParam TValue - Scalar or array value
 */
export type ColumnUpdate<TFlags extends ColumnFlags, TValue> = TFlags["omitUpdate"] extends true
  ? never
  : InsertKind<TFlags> extends "omit"
    ? never
    : TFlags["nullable"] extends true
      ? TValue | null | undefined
      : TValue | undefined;

/**
 * Row shape of a builder.
 *
 * @typeParam TBuilder - Column builder
 */
export type ColumnRowOf<TBuilder> =
  TBuilder extends ColumnBuilder<infer TValue, infer TFlags> ? ColumnRow<TFlags, TValue> : never;

/**
 * Insert shape of a builder.
 *
 * @typeParam TBuilder - Column builder
 */
export type ColumnInsertOf<TBuilder> =
  TBuilder extends ColumnBuilder<infer TValue, infer TFlags> ? ColumnInsert<TFlags, TValue> : never;

/**
 * Update shape of a builder.
 *
 * @typeParam TBuilder - Column builder
 */
export type ColumnUpdateOf<TBuilder> =
  TBuilder extends ColumnBuilder<infer TValue, infer TFlags> ? ColumnUpdate<TFlags, TValue> : never;

/** Runtime definition a modifier updates and compile reads. */
export type ColumnState<TValue> = {
  readonly baseType: string;
  readonly dims: number;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly defaultSql: string | undefined;
  readonly defaultValue: unknown;
  /**
   * Client generator. Absent from the catalog and its hash.
   *
   * The catalog output labels it `client`. Insert fills the column when the
   * caller omits it.
   */
  readonly clientDefault: ClientFill | undefined;
  /** Column collation. Omitted from the catalog when unset. */
  readonly collation: string | undefined;
  /**
   * `implicit` is a bare `t.id()`. `schema({ defaults: { id } })` may replace
   * it. `column` is a choice on that column and wins.
   */
  readonly idSource: "implicit" | "column" | undefined;
  readonly identity: { readonly always: boolean } | undefined;
  readonly generated: { readonly stored: boolean; readonly expression: string } | undefined;
  readonly unique:
    | { readonly reason: string | undefined; readonly global: boolean | undefined }
    | undefined;
  readonly picklist: { readonly values: readonly string[]; readonly check: boolean } | undefined;
  readonly guarded: boolean;
  readonly hidden: boolean;
  /** Redacted in logs, errors, and `inspect()`. Not part of the catalog hash. */
  readonly sensitive: boolean;
  readonly omitWrite: boolean;
  readonly omitUpdate: boolean;
  readonly renamedFrom: string | undefined;
  readonly sqlName: string | undefined;
  readonly comment: string | undefined;
  readonly extension: string | undefined;
  readonly typeDependency: string | undefined;
  /** Ordered enum labels. Absent on every column that is not an enum. */
  readonly enumLabels: readonly string[] | undefined;
  readonly domain: { readonly base: string; readonly check: string } | undefined;
  readonly primaryKey: boolean;
  readonly typeLabel: string | undefined;
  readonly references: ReferenceModifier | undefined;
  readonly validate: ValidateModifier | undefined;
  readonly sqlForm: SqlForm;
  readonly encode: (value: TValue) => string;
  readonly decode: (wire: string) => TValue;
  readonly elementEncode: (value: unknown) => string;
  readonly elementDecode: (wire: string) => unknown;
};

/** Fields a scalar builder sets. Flags are passed beside the codec. */
export type OpenColumn<TValue> = {
  readonly baseType: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
  readonly guarded: boolean;
  readonly hidden: boolean;
  readonly omitWrite: boolean;
  readonly omitUpdate?: boolean;
  readonly encode: (value: TValue) => string;
  readonly decode: (wire: string) => TValue;
  readonly sqlForm: SqlForm;
  readonly defaultSql?: string;
  readonly clientDefault?: ClientFill;
  readonly collation?: string;
  readonly idSource?: "implicit" | "column";
  readonly identity?: { readonly always: boolean };
  readonly extension?: string;
  readonly typeDependency?: string;
  readonly enumLabels?: readonly string[];
  readonly domain?: { readonly base: string; readonly check: string };
  readonly primaryKey?: boolean;
  readonly typeLabel?: string;
};

/**
 * Chainable column definition.
 *
 * Call {@link ColumnBuilder.encode} and {@link ColumnBuilder.decode} for the
 * codec. Catalog compilation lives in `compileColumn` so a caller that only
 * encodes does not load it.
 *
 * @typeParam TValue - TypeScript value
 * @typeParam TFlags - Nullability, defaults, generation, and exposure
 */
export class ColumnBuilder<TValue, TFlags extends ColumnFlags> {
  /** Phantom value, so the class carries `TValue`. */
  declare readonly "~value": TValue;
  /** Phantom flags. */
  declare readonly "~flags": TFlags;
  /** Definition. Modifiers replace the builder instead of mutating it. */
  readonly state: ColumnState<TValue>;

  /**
   * @param state - Definition
   */
  constructor(state: ColumnState<TValue>) {
    this.state = state;
  }

  /**
   * Encodes a value to the text the catalog and the driver store.
   *
   * @param value - Application value
   * @returns Wire text
   */
  encode(value: TValue): string {
    return this.state.encode(value);
  }

  /**
   * Decodes wire text to the application value.
   *
   * @param wire - Text from {@link encode}
   * @returns Application value
   */
  decode(wire: string): TValue {
    return this.state.decode(wire);
  }

  /**
   * Allows SQL NULL.
   *
   * @returns The same column, nullable
   */
  nullable(): ColumnBuilder<TValue, FlagTrue<TFlags, "nullable">> {
    return rebuild<TValue, FlagTrue<TFlags, "nullable">>(this.state, { nullable: true });
  }

  /**
   * Stores a literal database default, or a client generator.
   *
   * A literal is written into the catalog as SQL. A function is a client
   * generator: insert fills the column when it is omitted, and the catalog
   * stores no default. Pass `uuidv4`, `uuidv7`, `okid(...)`, or any function.
   *
   * @param value - Literal default, or a function that returns one value
   * @returns The same column, with a default
   */
  default(
    value: (TFlags["nullable"] extends true ? TValue | null : TValue) | (() => TValue),
  ): ColumnBuilder<TValue, FlagTrue<TFlags, "hasDefault">> {
    const clientDefault = readClientGenerator(value);
    if (clientDefault !== undefined) {
      return rebuild<TValue, FlagTrue<TFlags, "hasDefault">>(this.state, {
        hasDefault: true,
        defaultSql: undefined,
        defaultValue: undefined,
        clientDefault,
        generated: undefined,
      });
    }
    if (value === null && this.state.nullable === false) {
      definition("A null default is only accepted on a nullable column. Call .nullable() first.");
    }
    if (this.state.picklist !== undefined && value !== null) {
      const text = String(value);
      if (!this.state.picklist.values.includes(text)) {
        definition(
          `Default ${text} is not in the picklist ${this.state.picklist.values.join(", ")}.`,
        );
      }
    }
    return rebuild<TValue, FlagTrue<TFlags, "hasDefault">>(this.state, {
      hasDefault: true,
      defaultSql: value === null ? "NULL" : sqlOf(this.state, value as TValue),
      defaultValue: value,
      clientDefault: undefined,
      generated: undefined,
    });
  }

  /**
   * Stores a SQL default expression as written.
   *
   * @param expression - SQL expression
   * @returns The same column, with a default
   */
  defaultSql(expression: string): ColumnBuilder<TValue, FlagTrue<TFlags, "hasDefault">> {
    if (expression.length === 0) {
      definition("defaultSql must be a non-empty SQL expression.");
    }
    return rebuild<TValue, FlagTrue<TFlags, "hasDefault">>(this.state, {
      hasDefault: true,
      defaultSql: expression,
      defaultValue: undefined,
      clientDefault: undefined,
      generated: undefined,
    });
  }

  /**
   * Makes this column the table's primary key.
   *
   * Insert still accepts the value. Update omits it. A composite key is the
   * `primaryKey` option on `table()`, not a second call.
   *
   * @returns The same column, as a primary key
   */
  primaryKey(): ColumnBuilder<TValue, WithUpdateGuard<TFlags>> {
    return rebuild<TValue, WithUpdateGuard<TFlags>>(this.state, {
      primaryKey: true,
      omitUpdate: true,
    });
  }

  /**
   * Records a unique constraint.
   *
   * On a tenant table the key is included, unless `global` names a reason.
   * `global: "reason"` and `{ global: true, reason }` are the same opt-out.
   *
   * @param options - Exemption reason, and whether the unique ignores the tenant key
   * @returns The same column
   */
  unique(options?: {
    readonly reason?: string;
    readonly global?: boolean | string;
  }): ColumnBuilder<TValue, TFlags> {
    const marker = options?.global;
    if (typeof marker === "string" && marker.trim().length === 0) {
      definition("unique() global needs a reason.");
    }
    const named = typeof marker === "string" ? marker.trim() : undefined;
    const globalFlag: boolean | undefined = typeof marker === "string" ? true : marker;
    return rebuild<TValue, TFlags>(this.state, {
      unique: {
        reason: named ?? options?.reason,
        global: globalFlag,
      },
    });
  }

  /**
   * Narrows a string column to a literal union.
   *
   * `{ check: false }` keeps the list in the type and skips the catalog CHECK.
   * An empty list or a repeated value is OKM1060.
   *
   * @param values - Allowed literals, in stored order
   * @param options - Whether the catalog gets a CHECK
   * @returns The column typed as that union
   */
  picklist<const TValues extends readonly (TValue & string)[]>(
    values: TValues,
    options?: { readonly check?: boolean },
  ): ColumnBuilder<TValues[number], TFlags> {
    if (values.length === 0) {
      definition("A picklist must contain at least one value.");
    }
    const allowed = new Set<string>();
    for (const value of values) {
      if (value.length === 0) {
        definition("Picklist values must be non-empty strings.");
      }
      if (allowed.has(value)) {
        definition(`Picklist value ${value} is repeated. Each value is accepted once.`);
      }
      allowed.add(value);
    }
    if (typeof this.state.defaultValue === "string" && !allowed.has(this.state.defaultValue)) {
      definition(`Default ${this.state.defaultValue} is not in the picklist ${values.join(", ")}.`);
    }
    const previous = this.state.elementEncode;
    const elementEncode = (value: unknown): string => {
      if (typeof value !== "string" || !allowed.has(value)) {
        rejected(
          `Picklist rejected ${String(value)}. Accepted values: ${[...allowed].join(", ")}.`,
        );
      }
      return previous(value);
    };
    return rebuild<TValues[number], TFlags>(this.state as ColumnState<TValues[number]>, {
      picklist: { values: values.slice(), check: options?.check !== false },
      elementEncode,
      encode: elementEncode as (value: TValues[number]) => string,
    });
  }

  /**
   * Stores a generated expression. Insert and update omit the column.
   *
   * @param expression - SQL expression
   * @param options - `stored` defaults to true
   * @returns The same column, generated
   */
  generated(
    expression: string,
    options?: { readonly stored?: boolean },
  ): ColumnBuilder<TValue, WithGenerated<TFlags>> {
    if (expression.length === 0) {
      definition("generated() must be a non-empty SQL expression.");
    }
    return rebuild<TValue, WithGenerated<TFlags>>(this.state, {
      generated: { stored: options?.stored !== false, expression },
      hasDefault: true,
      defaultSql: undefined,
      defaultValue: undefined,
      clientDefault: undefined,
    });
  }

  /**
   * Omits the column from insert and update input.
   *
   * @returns The same column, guarded
   */
  guarded(): ColumnBuilder<TValue, FlagTrue<TFlags, "guarded">> {
    return rebuild<TValue, FlagTrue<TFlags, "guarded">>(this.state, { guarded: true });
  }

  /**
   * Excludes the column from the default row.
   *
   * A named `select` still returns it. Includes never do.
   *
   * @returns The same column, hidden
   */
  hidden(): ColumnBuilder<TValue, FlagTrue<TFlags, "hidden">> {
    return rebuild<TValue, FlagTrue<TFlags, "hidden">>(this.state, { hidden: true });
  }

  /**
   * Redacts the value in logs, errors, and `inspect()`.
   *
   * The stored value is unchanged. A read that selects the column still
   * returns it. The catalog hash does not include this flag.
   *
   * @returns The same column, sensitive
   */
  sensitive(): ColumnBuilder<TValue, TFlags> {
    return rebuild<TValue, TFlags>(this.state, { sensitive: true });
  }

  /**
   * Stores validation rules or one Standard Schema.
   *
   * The rules are stored. They run only when validation is enabled and the
   * engine has loaded. A field listed here and in the table `validate`
   * section is OKM1030, reported by `okm check`.
   *
   * @param rules - Rule list, or one Standard Schema
   * @returns The same column, with the rules stored
   */
  validate(
    rules: readonly unknown[] | { readonly "~standard": unknown },
  ): ColumnBuilder<TValue, TFlags> {
    const list = Array.isArray(rules) ? rules : [rules];
    return rebuild<TValue, TFlags>(this.state, { validate: { rules: list } });
  }

  /**
   * Points this column at another table.
   *
   * `schema()` checks that the table exists (OKM1020). The argument stays a
   * string so the column type does not cycle through `Register`.
   *
   * @param table - Target table name
   * @param options - Referential actions and target columns
   * @returns The same column, with the reference stored
   */
  references(table: string, options?: ReferenceOptions): ColumnBuilder<TValue, TFlags> {
    if (table.length === 0) {
      definition("references() needs a table name.");
    }
    const onDelete = readAction(options?.onDelete, "onDelete");
    const onUpdate = readAction(options?.onUpdate, "onUpdate");
    const columns = readReferenceColumns(options?.columns);
    return rebuild<TValue, TFlags>(this.state, {
      references: {
        table,
        ...(onDelete !== undefined ? { onDelete } : {}),
        ...(onUpdate !== undefined ? { onUpdate } : {}),
        ...(columns !== undefined ? { columns } : {}),
      },
    });
  }

  /**
   * Records the previous SQL name. Migrations read it later.
   *
   * @param name - Previous column name
   * @returns The same column
   */
  renamedFrom(name: string): ColumnBuilder<TValue, TFlags> {
    if (name.length === 0) {
      definition("renamedFrom must be a non-empty previous column name.");
    }
    return rebuild<TValue, TFlags>(this.state, { renamedFrom: name });
  }

  /**
   * Sets the catalog column name when it differs from the field name.
   *
   * @param name - SQL identifier
   * @returns The same column
   */
  sqlName(name: string): ColumnBuilder<TValue, TFlags> {
    if (name.length === 0) {
      definition("sqlName must be a non-empty SQL identifier.");
    }
    return rebuild<TValue, TFlags>(this.state, { sqlName: name });
  }

  /**
   * Stores a comment. The catalog column object has no comment field yet,
   * so compile returns it beside the column.
   *
   * @param text - Comment text
   * @returns The same column
   */
  comment(text: string): ColumnBuilder<TValue, TFlags> {
    return rebuild<TValue, TFlags>(this.state, { comment: text });
  }

  /**
   * Wraps the value in an array. `dims` defaults to one more rank, starting at 1.
   *
   * @param options - Explicit rank from 1 to 6
   * @returns An array column
   */
  array<const D extends number = 1>(options?: {
    readonly dims?: D;
  }): ColumnBuilder<ArrayOf<TValue, D>, TFlags> {
    if (this.state.dims !== 0) {
      definition("array() accepts a scalar column. This column is already an array.");
    }
    const dims = options?.dims ?? 1;
    if (!Number.isInteger(dims) || dims < 1 || dims > 6) {
      definition(`Array dims ${String(dims)} must be an integer from 1 to 6.`);
    }
    const elementEncode = this.state.elementEncode;
    const elementDecode = this.state.elementDecode;
    const raw = this.state.sqlForm === "raw";
    return rebuild<ArrayOf<TValue, D>, TFlags>(this.state as ColumnState<ArrayOf<TValue, D>>, {
      dims,
      encode: (value) => writeArray(value, dims, elementEncode, raw),
      decode: (wire) => readArray(wire, dims, elementDecode) as ArrayOf<TValue, D>,
    });
  }
}

/** Codec and SQL type, without the flag booleans {@link required} fills in. */
export type RequiredBody<TValue> = Omit<
  OpenColumn<TValue>,
  "nullable" | "hasDefault" | "generated" | "guarded" | "hidden" | "omitWrite"
>;

/**
 * Starts a required scalar column.
 *
 * @typeParam TValue - TypeScript value
 * @param body - Type and codec
 * @returns A builder with {@link PlainFlags}
 */
export function required<TValue>(body: RequiredBody<TValue>): ColumnBuilder<TValue, PlainFlags> {
  return openColumn({
    nullable: false,
    hasDefault: false,
    generated: false,
    guarded: false,
    hidden: false,
    omitWrite: false,
    ...body,
  });
}

/**
 * Starts a scalar column.
 *
 * @typeParam TValue - TypeScript value
 * @typeParam TFlags - Flags the caller names
 * @param input - Type, codec, and flags
 * @returns A builder
 */
export function openColumn<TValue, TFlags extends ColumnFlags>(
  input: OpenColumn<TValue>,
): ColumnBuilder<TValue, TFlags> {
  const elementEncode = input.encode as (value: unknown) => string;
  const elementDecode = input.decode as (wire: string) => unknown;
  return new ColumnBuilder({
    baseType: input.baseType,
    dims: 0,
    nullable: input.nullable,
    hasDefault: input.hasDefault,
    defaultSql: input.defaultSql,
    defaultValue: undefined,
    clientDefault: input.clientDefault,
    collation: input.collation,
    idSource: input.idSource,
    identity: input.identity,
    generated: undefined,
    unique: undefined,
    picklist: undefined,
    guarded: input.guarded,
    hidden: input.hidden,
    sensitive: false,
    omitWrite: input.omitWrite,
    omitUpdate: input.omitUpdate === true,
    renamedFrom: undefined,
    sqlName: undefined,
    comment: undefined,
    extension: input.extension,
    typeDependency: input.typeDependency,
    enumLabels: input.enumLabels,
    domain: input.domain,
    primaryKey: input.primaryKey === true,
    typeLabel: input.typeLabel,
    references: undefined,
    validate: undefined,
    sqlForm: input.sqlForm,
    encode: input.encode,
    decode: input.decode,
    elementEncode,
    elementDecode,
  });
}

/**
 * SQL type name, with `[]` repeated for each array rank.
 *
 * @param baseType - Scalar SQL type
 * @param dims - Array rank, 0 for a scalar
 * @returns Catalog `dataType`
 */
export function formatType(baseType: string, dims: number): string {
  if (dims === 0) {
    return baseType;
  }
  return baseType + "[]".repeat(dims);
}

/**
 * SQL spelling of a default value.
 *
 * @param state - Column definition
 * @param value - Application value
 * @returns A default expression
 */
export function sqlOf<TValue>(state: ColumnState<TValue>, value: TValue): string {
  const encoded = state.encode(value);
  const typed = formatType(state.baseType, state.dims);
  if (state.sqlForm === "cast") {
    return `${quoteLiteral(encoded)}::${typed}`;
  }
  if (state.sqlForm === "json") {
    return `${quoteLiteral(encoded)}::json`;
  }
  if (state.sqlForm === "jsonb") {
    return `${quoteLiteral(encoded)}::jsonb`;
  }
  if (state.dims > 0 || state.sqlForm === "quote") {
    return quoteLiteral(encoded);
  }
  return encoded;
}

function readAction(
  action: ReferentialAction | undefined,
  role: string,
): ReferentialAction | undefined {
  if (action === undefined) {
    return undefined;
  }
  if (referentialAction(action) === undefined) {
    definition(
      `references() ${role} ${action} is not a referential action. Accepted actions: ${REFERENTIAL_ACTIONS.join(", ")}.`,
    );
  }
  return action;
}

function readReferenceColumns(
  columns: readonly string[] | undefined,
): readonly string[] | undefined {
  if (columns === undefined) {
    return undefined;
  }
  if (columns.length === 0) {
    definition("references() columns must name at least one target column.");
  }
  const copy: string[] = [];
  for (const name of columns) {
    if (name.length === 0) {
      definition("references() columns must be non-empty names.");
    }
    copy.push(name);
  }
  return copy;
}

/**
 * Returns a column with a cleared unique flag or a replaced reference.
 *
 * `okmodel/tenancy` uses this while rewriting tables. `schema()` then compiles
 * the result with the ordinary unique and foreign-key paths.
 *
 * @param column - Column to copy
 * @param patch - Unique or primary flag to drop, or the reference to store
 * @returns A new column builder
 */
export function retarget<TValue, TFlags extends ColumnFlags>(
  column: ColumnBuilder<TValue, TFlags>,
  patch: {
    readonly dropUnique?: boolean;
    readonly dropPrimary?: boolean;
    readonly references?: ReferenceModifier;
  },
): ColumnBuilder<TValue, TFlags> {
  return rebuild(column.state, {
    ...(patch.dropUnique === true ? { unique: undefined } : {}),
    ...(patch.dropPrimary === true ? { primaryKey: false } : {}),
    ...(patch.references !== undefined ? { references: patch.references } : {}),
  });
}

function rebuild<TValue, TFlags extends ColumnFlags>(
  state: ColumnState<TValue>,
  patch: Partial<ColumnState<TValue>>,
): ColumnBuilder<TValue, TFlags> {
  return new ColumnBuilder({ ...state, ...patch });
}
