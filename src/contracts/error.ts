/**
 * `OkmError`: categories, HTTP mapping, and `safe` / `match` (spec §14).
 *
 * Doctor text for every OKM code lives in the tooling registry and is not
 * imported here. A caller who never explains a code does not load it.
 */

import type { Row, TableName } from "./rows.js";
import { nearestName } from "./nearest.js";

/**
 * Catalog failures that have a code in spec section 21 or D128.
 *
 * OKM1020 stays the code for an unknown table and for catalog failures that
 * still have no narrower code. A dependency cycle is OKM1026. A document this
 * version cannot read is OKM1027.
 */
export const CATALOG_CODES = [
  "OKM1020",
  "OKM1021",
  "OKM1022",
  "OKM1023",
  "OKM1026",
  "OKM1027",
  "OKM1122",
] as const;

/** A catalog error code. */
export type CatalogCode = (typeof CATALOG_CODES)[number];

/**
 * Column definition, reserved options, and codec failures (D130, D132).
 *
 * OKM1060 is an invalid column definition. OKM1061 is a table or schema option
 * the types accept but this version does not implement. OKM1210 is a value a
 * codec rejects.
 */
export const COLUMN_CODES = ["OKM1060", "OKM1061", "OKM1210"] as const;

/** A column or codec error code. */
export type ColumnCode = (typeof COLUMN_CODES)[number];

/**
 * Query, capability, and connect codes the read path throws.
 *
 * These are spec §21 codes. They are a type only, so the runtime entry does
 * not gain a second registry.
 */
export type QueryCode =
  | "OKM1101"
  | "OKM1102"
  | "OKM1104"
  | "OKM1105"
  | "OKM1111"
  | "OKM1120"
  | "OKM1121"
  | "OKM1124"
  | "OKM1130"
  | "OKM1190"
  | "OKM1701"
  | "OKM1704"
  | "OKM1801"
  | "OKM1802"
  | "OKM1803"
  | "OKM1843";

/** Kinds from spec §14, in category order. */
export const ERROR_KINDS = [
  "invalid",
  "not_null",
  "check",
  "foreign_key",
  "unique",
  "exclusion",
  "conflict",
  "not_found",
  "not_unique",
  "forbidden",
  "serialization",
  "deadlock",
  "lock_timeout",
  "timeout",
  "cancelled",
  "unavailable",
  "schema_drift",
  "driver",
  "read_only",
  "outcome_unknown",
] as const;

/** One spec §14 kind. */
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Categories from spec §14. Statuses are overridable per category. */
export const ERROR_CATEGORIES = [
  "input",
  "conflict",
  "not_found",
  "forbidden",
  "transient",
  "internal",
] as const;

/** One spec §14 category. */
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * A structured suggestion for a person or a coding agent.
 *
 * `suggestion` is the nearest accepted name when the input was a typo.
 */
export type ErrorFix = {
  /** What to do, in one sentence. */
  readonly summary: string;
  /** Accepted name to use instead, when one is close. */
  readonly suggestion?: string;
};

/**
 * One failed validation check.
 *
 * `message` is a key, never prose and never a row value. `path` walks the
 * value: a field name, or a row index then a field name.
 */
export type ValidationIssue = {
  readonly path: readonly (string | number)[];
  readonly message: string;
};

/** Column name to constraint reason. Row values are not included. */
export type ErrorFields = Readonly<Record<string, string>>;

/** Body of {@link OkmError.toHttp}. */
export type HttpErrorBody = {
  /** OKM code, or the kind when spec §21 does not number that kind. */
  readonly code: string;
  /** Same text as {@link OkmError.summary}. */
  readonly reason: string;
  /** Field reasons. Empty when the error has no columns. */
  readonly fields: ErrorFields;
};

/** HTTP mapping of one error. */
export type HttpError = {
  readonly status: number;
  readonly body: HttpErrorBody;
};

/** Replacement statuses. Omitted categories keep the spec default. */
export type ErrorStatuses = Partial<Record<ErrorCategory, number>>;

/** Structured log record. Row values are never included. */
export type ErrorLog = {
  readonly name: "OkmError";
  readonly code: string;
  readonly kind: ErrorKind;
  readonly category: ErrorCategory;
  readonly summary: string;
  readonly retryable: boolean;
  readonly batchIndex: number | null;
  readonly fix: ErrorFix;
  readonly fields: ErrorFields;
  /** Validation checks, when the failure is OKM1200. */
  readonly issues?: readonly ValidationIssue[];
  readonly table?: string;
  readonly columns?: readonly string[];
  readonly constraint?: string;
  readonly sqlstate?: string;
};

/** Fields the constructor accepts beyond the code and the summary. */
export type OkmErrorOptions = {
  readonly kind?: ErrorKind;
  readonly fix?: ErrorFix;
  readonly table?: string;
  readonly columns?: readonly string[];
  /** Constraint reason stored by {@link OkmError.fields}. Defaults to the kind. */
  readonly fieldReason?: string;
  readonly constraint?: string;
  readonly sqlstate?: string;
  /** Statement index, or `null` at commit. Omitted on a single statement. */
  readonly batchIndex?: number | null;
  readonly cause?: unknown;
  readonly retryable?: boolean;
  /**
   * Row values. Stored only when `includeValues` is set, and never logged.
   * Development only (spec §14).
   */
  readonly includeValues?: boolean;
  readonly values?: Readonly<Record<string, string>>;
  /** Checks from a failed validation. Omitted on every other error. */
  readonly issues?: readonly ValidationIssue[];
  /**
   * Category overrides from `connect({ errors })`.
   *
   * {@link OkmError.toHttp} uses them when the caller does not pass statuses.
   */
  readonly http?: ErrorStatuses;
};

/** Success or a mapped {@link OkmError}. */
export type SafeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OkmError };

const NO_COLUMNS: readonly string[] = [];
const NO_FIELDS: ErrorFields = {};

const DEFAULT_STATUS: { readonly [K in ErrorCategory]: number } = {
  input: 422,
  conflict: 409,
  not_found: 404,
  forbidden: 403,
  transient: 503,
  internal: 500,
};

const CATEGORY_OF: { readonly [K in ErrorKind]: ErrorCategory } = {
  invalid: "input",
  not_null: "input",
  check: "input",
  foreign_key: "input",
  unique: "conflict",
  exclusion: "conflict",
  conflict: "conflict",
  not_found: "not_found",
  not_unique: "not_found",
  forbidden: "forbidden",
  serialization: "transient",
  deadlock: "transient",
  lock_timeout: "transient",
  timeout: "transient",
  cancelled: "transient",
  unavailable: "transient",
  schema_drift: "internal",
  driver: "internal",
  read_only: "internal",
  outcome_unknown: "internal",
};

/**
 * Column names on a registered table, or plain strings when it is not registered.
 *
 * An empty `Register` leaves every name as `string`. Augmenting `Register`
 * narrows `users` to that table's columns.
 */
export type ErrorColumns<T extends string> = [TableName] extends [never]
  ? readonly string[]
  : T extends TableName
    ? readonly (keyof Row<T> & string)[]
    : readonly string[];

type Categorised<C extends ErrorCategory> = OkmError & { readonly category: C };

/**
 * One OKModel error.
 *
 * Construction does not format a stack trace and does not compile a regular
 * expression. Row values stay out unless `includeValues` was set.
 */
export class OkmError extends Error {
  /** Spec code, or the kind when spec §21 does not number that kind. */
  readonly code: string;
  /** Spec §14 kind. */
  readonly kind: ErrorKind;
  /** Spec §14 category. */
  readonly category: ErrorCategory;
  /** Whether a declared retry may run this error again. `cancelled` never retries. */
  readonly retryable: boolean;
  /** What to change. */
  readonly fix: ErrorFix;
  /** Table the database named, when it named one. */
  readonly table: string | undefined;
  /** Columns the failure names. Empty when it names none. */
  readonly columns: readonly string[];
  /** Constraint name the database sent, when it sent one. */
  readonly constraint: string | undefined;
  /** SQLSTATE the database sent, when it sent one. */
  readonly sqlstate: string | undefined;
  /**
   * Failing statement inside a batch, or `null` when the failure is the commit.
   *
   * `null` on a single statement as well: there is no statement index.
   */
  readonly batchIndex: number | null;
  /** Constraint reason used by {@link fields}. */
  readonly fieldReason: string;
  /** Cached {@link fields} result. */
  #fields: ErrorFields | undefined;
  /** Row values. Present only when the caller opted in. Not logged. */
  readonly #values: Readonly<Record<string, string>> | undefined;
  /** Status overrides from `connect()`. Not logged. */
  readonly #http: ErrorStatuses | undefined;
  /** Validation checks. Absent when this error is not a failed check. */
  readonly issues?: readonly ValidationIssue[];

  /**
   * Same text as `message`.
   *
   * @returns The summary
   */
  get summary(): string {
    return this.message;
  }

  /**
   * @param code - Spec code, or a kind name for an unnumbered mapped error
   * @param message - What failed. This becomes {@link summary}
   * @param options - Kind, columns, and fix. Omitted fields are derived
   */
  constructor(code: string, message: string, options?: OkmErrorOptions) {
    const cause = options?.cause;
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OkmError";
    this.code = code;
    const kind = options?.kind ?? kindFromCode(code);
    this.kind = kind;
    this.category = CATEGORY_OF[kind];
    this.retryable = options?.retryable ?? defaultRetryable(kind);
    this.fix = options?.fix ?? { summary: defaultFix(kind) };
    this.table = options?.table;
    const columns = options?.columns;
    this.columns = columns === undefined || columns.length === 0 ? NO_COLUMNS : columns;
    this.constraint = options?.constraint;
    this.sqlstate = options?.sqlstate;
    this.batchIndex = options?.batchIndex === undefined ? null : options.batchIndex;
    this.fieldReason = options?.fieldReason ?? kind;
    this.#values = options?.includeValues === true ? options.values : undefined;
    this.#http = options?.http;
    if (options?.issues !== undefined) this.issues = options.issues;
  }

  /**
   * Maps a caught value to an {@link OkmError}.
   *
   * An {@link OkmError} is returned as itself. A driver error whose kind is
   * `timeout`, `cancelled`, or `outcome_unknown` keeps that kind. Postgres
   * SQLSTATE mapping is `mapPostgresError` in the Postgres dialect: this
   * method does not interpret constraint SQLSTATEs.
   *
   * @param error - Any thrown value
   * @returns An OKModel error
   */
  static from(error: unknown): OkmError {
    if (error instanceof OkmError) return error;
    if (isDriverError(error)) return fromDriver(error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new OkmError("driver", stripRowValues(message), { kind: "driver", cause: error });
  }

  /**
   * Narrows `error` to one kind, and to one table's columns when `table` is set.
   *
   * @param error - Caught value
   * @param kind - Expected kind
   * @param table - Expected table. Columns are typed from `Register` when it names one
   * @returns `true` when the kind matches and, if given, the table matches
   */
  static is<K extends ErrorKind>(
    error: unknown,
    kind: K,
  ): error is Omit<OkmError, "kind"> & { readonly kind: K };
  static is<K extends ErrorKind, T extends string>(
    error: unknown,
    kind: K,
    table: T,
  ): error is Omit<OkmError, "kind" | "table" | "columns"> & {
    readonly kind: K;
    readonly table: T;
    readonly columns: ErrorColumns<T>;
  };
  static is(error: unknown, kind: ErrorKind, table?: string): error is OkmError {
    if (!(error instanceof OkmError) || error.kind !== kind) return false;
    return table === undefined || error.table === table;
  }

  /**
   * Field name to constraint reason.
   *
   * The same object is returned on later calls. Row values are not included.
   *
   * @returns A map, empty when the error names no column
   */
  fields(): ErrorFields {
    const cached = this.#fields;
    if (cached !== undefined) return cached;
    if (this.columns.length === 0) {
      this.#fields = NO_FIELDS;
      return NO_FIELDS;
    }
    const built: Record<string, string> = {};
    const reason = this.fieldReason;
    for (const column of this.columns) built[column] = reason;
    this.#fields = built;
    return built;
  }

  /**
   * Row values, only when the error was built with `includeValues`.
   *
   * @returns The values, or `undefined` when they were not kept
   */
  values(): Readonly<Record<string, string>> | undefined {
    return this.#values;
  }

  /**
   * HTTP status and a body without row values.
   *
   * @param statuses - Category overrides from `connect()`. Omitted categories use the spec default
   * @returns Status and `{ code, reason, fields }`
   */
  toHttp(statuses?: ErrorStatuses): HttpError {
    const chosen = statuses ?? this.#http;
    const override = chosen?.[this.category];
    return {
      status: override ?? DEFAULT_STATUS[this.category],
      body: {
        code: this.code,
        reason: this.message,
        fields: this.fields(),
      },
    };
  }

  /**
   * Structured record for a log. Row values are omitted.
   *
   * @returns The fields a log line may print
   */
  log(): ErrorLog {
    return {
      name: "OkmError",
      code: this.code,
      kind: this.kind,
      category: this.category,
      summary: this.message,
      retryable: this.retryable,
      batchIndex: this.batchIndex,
      fix: this.fix,
      fields: this.fields(),
      ...(this.table !== undefined ? { table: this.table } : {}),
      ...(this.columns.length > 0 ? { columns: this.columns } : {}),
      ...(this.constraint !== undefined ? { constraint: this.constraint } : {}),
      ...(this.sqlstate !== undefined ? { sqlstate: this.sqlstate } : {}),
      ...(this.issues !== undefined ? { issues: this.issues } : {}),
    };
  }

  /**
   * Runs the handler for this category, or `_` when that category is omitted.
   *
   * @param handlers - One function per category that the caller handles, plus `_`
   * @returns Whatever the chosen handler returns
   */
  match<I = never, C = never, NF = never, F = never, T = never, X = never, D = never>(handlers: {
    readonly input?: (error: Categorised<"input">) => I;
    readonly conflict?: (error: Categorised<"conflict">) => C;
    readonly not_found?: (error: Categorised<"not_found">) => NF;
    readonly forbidden?: (error: Categorised<"forbidden">) => F;
    readonly transient?: (error: Categorised<"transient">) => T;
    readonly internal?: (error: Categorised<"internal">) => X;
    readonly _: (error: OkmError) => D;
  }): I | C | NF | F | T | X | D {
    const handler = handlers[this.category] as
      | ((error: OkmError) => I | C | NF | F | T | X | D)
      | undefined;
    if (handler !== undefined) return handler(this);
    return handlers._(this);
  }
}

/**
 * Settles `pending` as `{ ok, value }` or `{ ok, error }`.
 *
 * The error is {@link OkmError.from}. Postgres constraint mapping happens
 * before this, in the dialect, once a query throws.
 *
 * @param pending - Work that may throw
 * @returns A result that does not throw
 */
export function safe<T>(pending: Promise<T>): Promise<SafeResult<T>> {
  return pending.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error: OkmError.from(error) }),
  );
}

/**
 * Throws an {@link OkmError} for a catalog failure.
 *
 * @param code - Spec code
 * @param message - What failed. Name the accepted values
 * @param options - Fix and nearest-name suggestion
 */
export function catalogError(code: CatalogCode, message: string, options?: OkmErrorOptions): never {
  throw new OkmError(code, message, options);
}

/**
 * Throws for an unknown table, field, preset, or option.
 *
 * The message must already name the accepted values. A close candidate adds
 * "Did you mean `name`?" and a {@link ErrorFix.suggestion}.
 *
 * @param code - Spec code for this guard
 * @param input - The name that was rejected
 * @param candidates - Accepted and reserved names
 * @param message - What failed, including the accepted values
 */
export function throwNamed(
  code: CatalogCode | ColumnCode | QueryCode,
  input: string,
  candidates: readonly string[],
  message: string,
): never {
  const suggestion = nearestName(input, candidates);
  if (suggestion === undefined) throw new OkmError(code, message);
  throw new OkmError(code, `${message} Did you mean \`${suggestion}\`?`, {
    fix: { summary: `Use \`${suggestion}\`.`, suggestion },
  });
}

/**
 * Removes row values from a server message.
 *
 * `Key (email)=(ada@example.com)` becomes `Key (email)`. A `contains (...)`
 * list becomes `contains (…)`.
 *
 * @param text - Driver or server text
 * @returns Text safe to put on an error
 */
export function stripRowValues(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 61 && text.charCodeAt(index + 1) === 40) {
      const end = matchingParen(text, index + 1);
      if (end !== undefined) {
        index = end;
        continue;
      }
    }
    if (startsAt(text, index, "contains (")) {
      const open = index + "contains ".length;
      const end = matchingParen(text, open);
      if (end !== undefined) {
        result += "contains (…)";
        index = end;
        continue;
      }
    }
    result += text.charAt(index);
  }
  return result;
}

function kindFromCode(code: string): ErrorKind {
  if (isErrorKind(code)) return code;
  switch (code) {
    case "OKM1401":
      return "outcome_unknown";
    case "OKM1846":
      return "timeout";
    case "OKM1520":
      return "schema_drift";
    default:
      return "invalid";
  }
}

function isErrorKind(code: string): code is ErrorKind {
  return Object.hasOwn(CATEGORY_OF, code);
}

function defaultRetryable(kind: ErrorKind): boolean {
  if (kind === "cancelled" || kind === "outcome_unknown") return false;
  return CATEGORY_OF[kind] === "transient";
}

function defaultFix(kind: ErrorKind): string {
  switch (kind) {
    case "cancelled":
      return "Do not retry. The caller aborted the call.";
    case "outcome_unknown":
      return "Check whether the write landed, using an idempotency key, before retrying.";
    case "timeout":
    case "serialization":
    case "deadlock":
    case "lock_timeout":
    case "unavailable":
      return "Retry the call.";
    case "unique":
    case "exclusion":
    case "conflict":
      return "Change the conflicting value, or update the existing row.";
    case "not_null":
      return "Provide a value for the column.";
    case "check":
    case "invalid":
      return "Change the value so it passes the check.";
    case "foreign_key":
      return "Use a key that exists, or insert the referenced row first.";
    case "not_found":
      return "Look up a row that exists.";
    case "not_unique":
      return "Narrow the filter so it matches one row.";
    case "forbidden":
      return "Use a role that is allowed to perform this operation.";
    case "read_only":
      return "Run the write on the primary.";
    case "schema_drift":
      return "Apply the migrations that match this build.";
    case "driver":
      return "Read the summary and correct the call.";
  }
}

type DriverShape = {
  readonly message: string;
  readonly sqlstate?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly detail?: string;
  readonly batchIndex?: number | null;
  readonly kind?: "timeout" | "cancelled" | "outcome_unknown";
  readonly cause?: unknown;
};

function isDriverError(error: unknown): error is DriverShape {
  return error instanceof Error && error.name === "DriverError";
}

function fromDriver(error: DriverShape): OkmError {
  const kind = error.kind ?? "driver";
  const code = kind === "outcome_unknown" ? "OKM1401" : kind;
  const columns =
    error.column === undefined || error.column.length === 0 ? undefined : [error.column];
  return new OkmError(code, stripRowValues(error.message), {
    kind,
    ...(error.table !== undefined ? { table: error.table } : {}),
    ...(columns !== undefined ? { columns } : {}),
    ...(error.constraint !== undefined ? { constraint: error.constraint } : {}),
    ...(error.sqlstate !== undefined ? { sqlstate: error.sqlstate } : {}),
    ...(error.batchIndex !== undefined ? { batchIndex: error.batchIndex } : {}),
    cause: error.cause ?? error,
  });
}

/**
 * Index of the parenthesis that closes the one at `open`.
 *
 * @param text - Source text
 * @param open - Index of the opening `(`
 * @returns Index of the matching `)`, or `undefined` when it is missing
 */
export function matchingParen(text: string, open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 40) depth += 1;
    else if (code === 41) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function startsAt(text: string, index: number, needle: string): boolean {
  if (index + needle.length > text.length) return false;
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (text.charCodeAt(index + offset) !== needle.charCodeAt(offset)) return false;
  }
  return true;
}
