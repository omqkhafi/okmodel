/**
 * `okmodel/fn`.
 *
 * `fn()` and `trigger()` return objects that produce their own catalog
 * records. `schema()` only asks each declared object for those records.
 */

import { beginGrantBatch, rememberGrants } from "../role/grant-slot.js";
import { assertIdentifier } from "../../../contracts/catalog/identifier.js";
import { OkmError } from "../../../contracts/error.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import {
  functionObject,
  triggerObject,
  whenColumnNames,
} from "../../../contracts/catalog/routine.js";
import type {
  CatalogObject,
  FunctionLanguage,
  FunctionSecurity,
  FunctionVolatility,
  ObjectIdentity,
  ObjectRef,
  Provenance,
  TriggerEvent,
  TriggerLevel,
  TriggerTiming,
} from "../../../contracts/catalog/types.js";
import { quoteIdent } from "../ddl.js";
import {
  identName,
  isFragmentParts,
  sqlExpression,
  type FragmentIdent,
  type FragmentPart,
} from "../ops/fragment.js";
import { isOperator, operatorName, operatorValue, type Eq } from "../operators.js";
import type { Window } from "../ops/window.js";
import type { AnyTable, SqlText } from "../table.js";
import { formatType, sqlOf, type ColumnState } from "../column.js";
import type { Names } from "../casing.js";
import { readEventCompiler, type EventTriggerOptions } from "../event/slot.js";
import { compileBody, type CompiledBody } from "./body.js";

/**
 * A column builder, or `voidType` / `triggerType`.
 *
 * `fn()` reads `state.baseType`. A string type name is refused.
 */
export type RoutineType = {
  readonly state: {
    readonly baseType: string;
    readonly dims: number;
    readonly decode?: (wire: string) => unknown;
  };
};

/** `returns: voidType` for a function that returns nothing. */
export const voidType: RoutineType = {
  state: { baseType: "void", dims: 0, decode: (wire) => wire },
};

/** `returns: triggerType` for a trigger function. */
export const triggerType: RoutineType = {
  state: { baseType: "trigger", dims: 0, decode: (wire) => wire },
};

/** `returns: eventTriggerType` for an event-trigger function. */
export const eventTriggerType: RoutineType = {
  state: { baseType: "event_trigger", dims: 0, decode: (wire) => wire },
};

/** `IN`, `OUT`, or `INOUT`. Absent means `IN`. */
export type ArgumentMode = "in" | "out" | "inout";

/** One argument of {@link fn}. */
export type FunctionArgumentInput<TType extends RoutineType = RoutineType> = {
  readonly name: string;
  readonly type: TType;
  readonly mode?: ArgumentMode;
  /** Application value. Encoded with the column builder. */
  readonly default?: unknown;
};

type Decoded<T> = T extends { readonly state: { readonly decode: (wire: string) => infer V } }
  ? V
  : unknown;

/**
 * A typed call.
 *
 * It is a `sql` fragment, so `where` accepts it as {@link Eq}. `.as(name)` is
 * the `select` form. `orderBy` does not: adding the call to that union is one
 * composite type over the ceiling.
 *
 * @typeParam V - Value the return codec produces
 */
export type FnCall<V = unknown> = Eq<never> & {
  /**
   * Names the select result.
   *
   * @typeParam A - Result key
   * @param name - Result key. Not a column name
   * @returns A select entry
   */
  as<const A extends string>(name: A): Window<A, [V] extends [string | number] ? V : string>;
};

/** One argument value. `ident` names a field. Null is SQL null. */
type CallValue<T> = Decoded<T> | FragmentIdent | null;

/** Argument list of a call, in declaration order. */
type CallArgs<A extends readonly FunctionArgumentInput[]> = {
  [I in keyof A]: A[I] extends FunctionArgumentInput ? CallValue<A[I]["type"]> : never;
};

/** `fn.slugify(col)`. The value is {@link FnCall}. */
type FnCaller<A extends readonly FunctionArgumentInput[], R extends RoutineType> = (
  ...args: CallArgs<A>
) => FnCall<Decoded<R>>;

/**
 * A table, or one column of a table.
 *
 * A table is an object dependency. `{ table, column }` is a column dependency.
 * `column` is the SQL name.
 */
export type DependsOn = AnyTable | { readonly table: AnyTable; readonly column: string };

/** A string, `sql` text, or a callback `schema()` runs once. */
export type RoutineBody =
  | SqlText
  | string
  | ((handle: ProcedureBodyHandle) => SqlText | string)
  | ((args: Readonly<Record<string, unknown>>, query: ProcedureQuery) => readonly unknown[]);

/**
 * Handle for `(b) => b.sql\`...\``.
 *
 * Interpolating a table records it as `dependsOn`. The callback is not
 * called when `fn()` runs.
 */
export type ProcedureBodyHandle = {
  /** Interpolates tables, columns, and arguments, and records tables. */
  sql(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlText;
  /** One declared argument, qualified when the SQL is printed. */
  arg(name: string): unknown;
  /** Records a table the SQL text does not interpolate. */
  reads(table: object): void;
};

/**
 * `q.accounts.find(...)` inside a typed procedure body.
 *
 * The last statement's columns are assigned to `OUT` parameters, in order.
 */
export type ProcedureQuery = Record<
  string,
  {
    find(options?: object): unknown;
    aggregate(options?: object): unknown;
    insert(options: object): unknown;
    update(options: object): unknown;
    delete(options?: object): unknown;
  }
> & {
  sql(input: string | SqlText): unknown;
};

/** Options for a function. `returns` is a column builder. */
export type FunctionOptions = {
  readonly kind?: "function";
  readonly arguments?: readonly FunctionArgumentInput[];
  readonly returns: RoutineType | "event_trigger";
  readonly language: FunctionLanguage;
  readonly volatility?: FunctionVolatility;
  /** A procedure option. A function cannot set it. */
  readonly commits?: never;
  readonly security?: FunctionSecurity;
  /** Required when `security` is `"definer"` (OKM1823). */
  readonly searchPath?: string;
  readonly body: RoutineBody;
  /**
   * Tables and columns the body uses.
   *
   * Required for plpgsql (OKM1824) unless the body callback records them.
   * Omitted for `LANGUAGE sql` that begins with `BEGIN ATOMIC`.
   */
  readonly dependsOn?: readonly DependsOn[];
  /** Schema. The default is `public`. */
  readonly schema?: string;
  /** `EXECUTE` for declared roles. Keys are `roles` keys. */
  readonly grants?: Readonly<Record<string, unknown>>;
  /** Comment on the function. Absent means unmanaged. */
  readonly comment?: string;
  /** A procedure option. A function cannot set it. */
  readonly raises?: never;
};

/** Options for `kind: "procedure"`. `returns` and `volatility` are refused. */
export type ProcedureOptions = {
  readonly kind: "procedure";
  readonly arguments?: readonly FunctionArgumentInput[];
  /** Procedures have no return type. */
  readonly returns?: never;
  readonly language?: FunctionLanguage;
  /** Procedures have no volatility. */
  readonly volatility?: never;
  /**
   * The body commits.
   *
   * Refused with `security: "definer"`, `searchPath`, a `BEGIN ATOMIC` body,
   * and a body that does not contain `COMMIT` or `ROLLBACK` (OKM1551).
   */
  readonly commits?: true;
  readonly security?: FunctionSecurity;
  /** Required when `security` is `"definer"` (OKM1823). */
  readonly searchPath?: string;
  readonly body: RoutineBody;
  readonly dependsOn?: readonly DependsOn[];
  readonly schema?: string;
  readonly grants?: Readonly<Record<string, unknown>>;
  readonly comment?: string;
  /** `RAISE` names. The value is a five-character SQLSTATE. */
  readonly raises?: Readonly<Record<string, string>>;
};

/** One server notice `run` can hand to `onNotice`. */
export type ProcedureNotice = {
  readonly severity: string;
  readonly code?: string;
  readonly message: string;
};

/** Deadline, cancellation, and notices for {@link ProcedureRoutine.run}. */
export type ProcedureRunOptions = {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
  readonly onNotice?: (notice: ProcedureNotice) => void;
};

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

type InProperty<T> = T extends { readonly mode: "out" }
  ? never
  : T extends { readonly name: infer N extends string; readonly type: infer Type }
    ? T extends { readonly default: unknown }
      ? { readonly [K in N]?: CallValue<Type> }
      : { readonly [K in N]: CallValue<Type> }
    : never;

type OutProperty<T> = T extends {
  readonly mode: "out" | "inout";
  readonly name: infer N extends string;
  readonly type: infer Type;
}
  ? { readonly [K in N]: Decoded<Type> | null }
  : never;

/** Arguments `run` accepts. `OUT` is omitted. A default makes the key optional. */
export type ProcedureArgs<A extends readonly FunctionArgumentInput[]> = UnionToIntersection<
  InProperty<A[number]>
>;

/** `OUT` and `INOUT` values, or `void` when the procedure has neither. */
export type ProcedureResult<A extends readonly FunctionArgumentInput[]> = [
  OutProperty<A[number]>,
] extends [never]
  ? void
  : UnionToIntersection<OutProperty<A[number]>>;

/**
 * A procedure `schema({ functions })` stores.
 *
 * `run` sends `CALL` in named notation. Every `OUT` is `NULL::type`.
 */
export type ProcedureRoutine<A extends readonly FunctionArgumentInput[] = readonly []> = Routine & {
  /**
   * Calls the procedure.
   *
   * `commits: true` is refused inside a transaction before any SQL is sent (2D000).
   * `bigint` and `numeric` results arrive as strings. `timestamptz` may arrive
   * as a `Date` before the codec runs; the codec then returns its declared mode.
   *
   * @param db - A connected client
   * @param args - `IN` and `INOUT` values, by argument name
   * @param options - Timeout, abort signal, and notices
   * @returns `OUT` and `INOUT` values, or `undefined` when there are none
   */
  run(
    db: object,
    args?: ProcedureArgs<A>,
    options?: ProcedureRunOptions,
  ): Promise<ProcedureResult<A>>;
};

/**
 * One declared function.
 *
 * `contribute` builds the catalog record. Overloads differ by argument types.
 */
export type Routine = {
  readonly name: string;
  readonly schema: string;
  readonly argTypes: readonly string[];
  /**
   * Catalog record for this declaration.
   *
   * @param peers - The `schema({ functions })` list
   * @param built - Objects the schema has already staged
   * @returns The function record
   */
  contribute(peers: unknown, built: unknown): readonly CatalogObject[];
};

/** Options for a trigger on a table. */
export type TableTriggerOptions = {
  readonly on: AnyTable;
  readonly timing: TriggerTiming;
  readonly events: readonly TriggerEvent[];
  readonly level: TriggerLevel;
  /** `UPDATE OF` columns. SQL names. Each one is a column dependency. */
  readonly updateOf?: readonly string[];
  readonly when?: SqlText | string;
  /**
   * Transition tables. Statement level, `after`, one event, and no `updateOf`.
   *
   * `insert` names `new`. `delete` names `old`. `update` names either.
   */
  readonly referencing?: { readonly old?: string; readonly new?: string };
  readonly calls: Routine;
  /** Comment on the trigger. Absent means unmanaged. */
  readonly comment?: string;
  readonly event?: never;
};

/** Options for {@link trigger}. An `event` makes it an event trigger. */
export type TriggerOptions = TableTriggerOptions | EventTriggerOptions;

/**
 * One declared trigger.
 *
 * Identity is `(table, name)`.
 */
export type TriggerDeclaration = {
  readonly name: string;
  /**
   * Catalog record for this declaration.
   *
   * @param peers - The `schema({ triggers })` list
   * @param built - Objects the schema has already staged
   * @returns The trigger record
   */
  contribute(peers: unknown, built: unknown): readonly CatalogObject[];
};

/**
 * Declares a function, or a procedure when `kind` is `"procedure"`.
 *
 * plpgsql without `dependsOn` is OKM1824. `security: "definer"` without
 * `searchPath` is OKM1823. A procedure's identity is its name plus its `IN`
 * and `INOUT` types.
 *
 * @param name - Routine name
 * @param options - Signature, language, body, and dependencies
 * @returns The definition object `schema({ functions })` stores
 */
export function fn<const A extends readonly FunctionArgumentInput[], const R extends RoutineType>(
  name: string,
  options: FunctionOptions & { readonly arguments?: A; readonly returns: R },
): Routine & FnCaller<A, R>;
export function fn(
  name: string,
  options: FunctionOptions & { readonly returns: "event_trigger" },
): Routine;
export function fn<const A extends readonly FunctionArgumentInput[]>(
  name: string,
  options: ProcedureOptions & { readonly arguments?: A },
): ProcedureRoutine<A>;
export function fn(
  name: string,
  options: (FunctionOptions | ProcedureOptions) & {
    readonly arguments?: readonly FunctionArgumentInput[];
  },
): Routine | ProcedureRoutine {
  const procedure = options.kind === "procedure";
  const kind = procedure ? "procedure" : "function";
  if (procedure && options.returns !== undefined) {
    throw new OkmError("OKM1020", `Procedure ${name} has no return type.`, {
      fix: { summary: "Remove returns. A procedure uses OUT arguments." },
    });
  }
  if (procedure && options.volatility !== undefined) {
    throw new OkmError("OKM1020", `Procedure ${name} has no volatility.`, {
      fix: { summary: "Remove volatility. A procedure is not a function." },
    });
  }
  const language =
    options.language ?? (options.commits === true ? "plpgsql" : procedure ? "sql" : undefined);
  if (language !== "sql" && language !== "plpgsql") {
    throw new OkmError(
      "OKM1020",
      `${kind === "procedure" ? "Procedure" : "Function"} ${name} needs a language.`,
      {
        fix: { summary: 'Set language to "sql" or "plpgsql".' },
      },
    );
  }
  assertDefiner(name, options.security, options.searchPath);
  const bound = (options.arguments ?? []).map((argument) => readArgument(name, argument));
  const returnsSql = procedure ? "" : readType(name, "return type", requiredReturns(options)).sql;
  const schemaName = options.schema ?? "public";
  const raises = readRaises(options.raises);
  const early =
    typeof options.body === "string" || isSqlText(options.body)
      ? compileBody(
          name,
          kind,
          options.body,
          [],
          identityNames,
          bound.map((item) => item.name),
        )
      : undefined;
  if (
    !procedure &&
    language === "plpgsql" &&
    options.dependsOn === undefined &&
    early?.atomic !== true &&
    typeof options.body !== "function" &&
    returnsSql !== "event_trigger"
  ) {
    missingDepends(name);
  }
  if (procedure) assertCommits(name, options, early);
  const spec: ProcedureSpec = {
    label: name,
    schema: quoteIdent(schemaName),
    name: quoteIdent(name),
    commits: options.commits === true,
    raises: raiseCodes(raises),
    arguments: bound.map((item) => ({
      name: item.name,
      quoted: quoteIdent(item.name),
      sqlType: item.sql,
      mode: item.mode,
      hasDefault: item.defaultSql !== undefined,
      encode: item.encode,
      decode: item.decode,
    })),
  };
  rememberRoutine({ schema: schemaName, name, routine: kind, spec });
  const contribute = (
    peers: unknown,
    built: unknown,
    names?: Names,
    sources?: readonly object[],
  ): readonly CatalogObject[] => {
    assertPeers(peers, "functions");
    if (typeof built === "object" && built !== null) beginGrantBatch(built);
    rememberGrants(procedure ? "procedure" : "function", schemaName, name, options.grants);
    const tables = sources ?? [];
    const compiled =
      early ??
      compileBody(
        name,
        kind,
        options.body,
        tables,
        names ?? identityNames,
        bound.map((item) => item.name),
      );
    if (
      !procedure &&
      language === "plpgsql" &&
      options.dependsOn === undefined &&
      compiled.dependsOn.length === 0 &&
      !compiled.atomic &&
      returnsSql !== "event_trigger"
    ) {
      missingDepends(name);
    }
    if (procedure) assertCommits(name, options, compiled);
    const depends = [
      ...(options.dependsOn ?? []),
      ...compiled.dependsOn.filter((item): item is AnyTable => isAnyTable(item)),
    ];
    const namespace = staticNamespace(schemaName);
    const provenance: Provenance = { origin: "file", name };
    return [
      functionObject({
        namespace,
        name,
        ...(bound.length > 0
          ? {
              arguments: bound.map((item) => ({
                name: item.name,
                type: item.sql,
                ...(item.mode !== "in" ? { mode: item.mode } : {}),
                ...(item.defaultSql !== undefined ? { default: item.defaultSql } : {}),
              })),
            }
          : {}),
        returns: returnsSql,
        language,
        ...(procedure || options.volatility === undefined
          ? {}
          : { volatility: options.volatility }),
        ...(options.security !== undefined ? { security: options.security } : {}),
        ...(options.searchPath !== undefined ? { searchPath: options.searchPath } : {}),
        body: compiled.sql,
        ...(compiled.atomic ? { atomic: true } : {}),
        ...(procedure ? { routine: "procedure" as const } : {}),
        ...(options.commits === true ? { commits: true as const } : {}),
        ...(raises !== undefined ? { raises } : {}),
        provenance,
        dependencies: dependencyEdges(depends, built),
        ...(options.comment !== undefined ? { comment: options.comment } : {}),
      }),
    ];
  };
  if (procedure) {
    const handle: ProcedureRoutine = {
      name,
      schema: schemaName,
      argTypes: bound.filter((item) => item.mode !== "out").map((item) => item.sql),
      contribute,
      run: (db: object, args?: object, runOptions?: ProcedureRunOptions) =>
        callProcedure(name, db, spec, args, runOptions) as Promise<never>,
    };
    return handle;
  }
  const call = (...args: readonly unknown[]): FnCall =>
    invoke(schemaName, name, bound, returnsSql, args);
  define(call, "name", name);
  define(call, "schema", schemaName);
  define(
    call,
    "argTypes",
    bound.map((item) => item.sql),
  );
  define(call, "contribute", contribute);
  return call as Routine & FnCaller<readonly FunctionArgumentInput[], RoutineType>;
}

const identityNames: Names = {
  casing: undefined,
  name: (key) => key,
  table: (item) => item.name,
  column: (_item, field) => field,
};

const registered: {
  schema: string;
  name: string;
  routine: "function" | "procedure";
  spec: ProcedureSpec;
}[] = [];

function rememberRoutine(entry: (typeof registered)[number]): void {
  const index = registered.findIndex(
    (item) =>
      item.schema === entry.schema &&
      item.name === entry.name &&
      item.routine === entry.routine &&
      item.spec.arguments.length === entry.spec.arguments.length &&
      item.spec.arguments.every(
        (argument, at) =>
          argument.sqlType === entry.spec.arguments[at]?.sqlType &&
          argument.mode === entry.spec.arguments[at]?.mode,
      ),
  );
  if (index >= 0) registered[index] = entry;
  else registered.push(entry);
}

/** One argument `run` sends. Built in the dialect so the runtime does not quote. */
export type ProcedureSpec = {
  readonly label: string;
  readonly schema: string;
  readonly name: string;
  readonly commits: boolean;
  readonly raises: Readonly<Record<string, string>>;
  readonly arguments: readonly {
    readonly name: string;
    readonly quoted: string;
    readonly sqlType: string;
    readonly mode: ArgumentMode;
    readonly hasDefault: boolean;
    readonly encode: (value: unknown) => string;
    readonly decode: (wire: string) => unknown;
  }[];
};

/**
 * Routines declared by `fn()` in this process.
 *
 * `okm call` reads this after the schema module loads. Importing `okmodel/fn`
 * does not fill it.
 *
 * @returns The declarations, in source order
 */
export function registeredRoutines(): readonly {
  readonly schema: string;
  readonly name: string;
  readonly routine: "function" | "procedure";
  readonly spec: ProcedureSpec;
}[] {
  return registered;
}

type BoundArgument = {
  readonly name: string;
  readonly sql: string;
  readonly mode: ArgumentMode;
  readonly defaultSql: string | undefined;
  readonly encode: (value: unknown) => string;
  readonly decode: (wire: string) => unknown;
};

function requiredReturns(
  options: FunctionOptions | ProcedureOptions,
): RoutineType | "event_trigger" {
  if (options.kind === "procedure" || options.returns === undefined) {
    throw new OkmError("OKM1020", "A function needs returns.", {
      fix: { summary: "Pass a column builder, such as t.text(), voidType, or triggerType." },
    });
  }
  return options.returns;
}

function readArgument(fnName: string, argument: FunctionArgumentInput): BoundArgument {
  const read = readType(fnName, `argument ${argument.name}`, argument.type);
  const mode = argument.mode ?? "in";
  if (mode !== "in" && mode !== "out" && mode !== "inout") {
    throw new OkmError(
      "OKM1020",
      `Function ${fnName} argument ${argument.name} mode is not supported.`,
      {
        fix: { summary: 'Use "in", "out", or "inout".' },
      },
    );
  }
  return {
    name: argument.name,
    sql: read.sql,
    mode,
    defaultSql:
      argument.default === undefined ? undefined : sqlOf(read.state, argument.default as never),
    encode:
      (read.state as { encode?: (value: unknown) => string }).encode ?? ((value) => String(value)),
    decode: read.state.decode ?? ((wire) => wire),
  };
}

function readType(
  fnName: string,
  role: string,
  type: RoutineType | "event_trigger",
): { readonly sql: string; readonly state: ColumnState<unknown> } {
  if (type === "event_trigger") {
    return { sql: "event_trigger", state: eventTriggerType.state as ColumnState<unknown> };
  }
  if (typeof type === "string") {
    throw new OkmError(
      "OKM1020",
      `Function ${fnName} ${role} needs a column builder, such as t.text(), not a string.`,
      {
        fix: { summary: "Pass t.text(), t.integer(), voidType, triggerType, or eventTriggerType." },
      },
    );
  }
  const state = type?.state;
  if (state === undefined || typeof state.baseType !== "string" || typeof state.dims !== "number") {
    throw new OkmError("OKM1020", `Function ${fnName} ${role} needs a column builder.`, {
      fix: { summary: "Pass t.text(), t.integer(), voidType, or triggerType." },
    });
  }
  return { sql: formatType(state.baseType, state.dims), state: state as ColumnState<unknown> };
}

function readRaises(
  raises: Readonly<Record<string, string>> | undefined,
): readonly { readonly name: string; readonly code: string }[] | undefined {
  if (raises === undefined) return undefined;
  return Object.entries(raises).map(([raiseName, code]) => ({ name: raiseName, code }));
}

function raiseCodes(
  raises: readonly { readonly name: string; readonly code: string }[] | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const item of raises ?? []) out[item.code] = item.name;
  return out;
}

function assertDefiner(
  fnName: string,
  security: FunctionSecurity | undefined,
  searchPath: string | undefined,
): void {
  if (security === "definer" && (searchPath === undefined || searchPath.trim().length === 0)) {
    throw new OkmError(
      "OKM1823",
      `Function ${fnName} is security definer and has no search_path.`,
      {
        fix: { summary: "Set search_path on the function to the schemas it is allowed to see." },
      },
    );
  }
  if (searchPath !== undefined && searchPath.trim().length > 0) {
    for (const part of searchPath.split(",")) {
      assertIdentifier(part.trim(), `function ${fnName} search_path`);
    }
  }
}

function assertCommits(
  fnName: string,
  options: FunctionOptions | ProcedureOptions,
  body: CompiledBody | undefined,
): void {
  const flag = options.commits === true;
  if (flag && options.security === "definer") {
    refuseCommits(fnName, "sets commits with security definer");
  }
  if (flag && options.searchPath !== undefined) {
    refuseCommits(fnName, "sets commits with search_path");
  }
  if (body === undefined) return;
  if (flag && body.atomic) refuseCommits(fnName, "sets commits with a BEGIN ATOMIC body");
  if (flag && !body.commits) {
    refuseCommits(fnName, "sets commits, and its body has no COMMIT or ROLLBACK");
  }
  if (!flag && body.commits) refuseCommits(fnName, "commits in its body without commits: true");
}

function refuseCommits(fnName: string, reason: string): never {
  throw new OkmError("OKM1551", `Procedure ${fnName} ${reason}.`, {
    fix: { summary: "A committing procedure is plpgsql, invoker, and has no SET clause." },
  });
}

function missingDepends(fnName: string): never {
  throw new OkmError(
    "OKM1824",
    `Function ${fnName} is plpgsql and has no dependsOn. Postgres does not record dependencies inside the body.`,
    {
      fix: {
        summary:
          "List dependsOn. LANGUAGE sql with BEGIN ATOMIC is inferred and does not need the list.",
      },
    },
  );
}

function isAnyTable(value: object): value is AnyTable {
  return "name" in value && typeof value.name === "string" && "columns" in value;
}

function isSqlText(value: unknown): value is SqlText {
  return (
    typeof value === "object" && value !== null && "text" in value && typeof value.text === "string"
  );
}

async function callProcedure(
  fnName: string,
  db: object,
  spec: ProcedureSpec,
  args: object | undefined,
  options: ProcedureRunOptions | undefined,
): Promise<unknown> {
  const slot = (db as Record<symbol, unknown>)[Symbol.for("okm.procedure")];
  if (typeof slot !== "function") {
    throw new OkmError("OKM1120", `Procedure ${fnName} needs a connected client.`, {
      fix: { summary: "Call run on the client from connect()." },
    });
  }
  return (
    slot as (
      spec: ProcedureSpec,
      args: object,
      options: ProcedureRunOptions | undefined,
    ) => Promise<unknown>
  )(spec, args ?? {}, options);
}

/**
 * Sets one own property on a call.
 *
 * `Object.assign` cannot write `name`: a function's `name` is read-only.
 *
 * @param target - The call
 * @param key - Property name
 * @param value - Property value
 */
function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const NUMERIC_RETURNS = new Set<string>([
  "smallint",
  "integer",
  "bigint",
  "int2",
  "int4",
  "int8",
  "real",
  "double precision",
  "float4",
  "float8",
  "numeric",
]);

/**
 * Builds the call fragment `schema.name(args)`.
 *
 * A string, number, or boolean is a parameter. `ident` and a column handle
 * name a field. Null is SQL null. Another call is nested.
 *
 * @param schemaName - Function schema
 * @param name - Function name
 * @param declared - Declared arguments
 * @param returns - Declared return type
 * @param args - Values the caller passed
 * @returns The tagged call
 */
function invoke(
  schemaName: string,
  name: string,
  declared: readonly BoundArgument[],
  returns: string,
  args: readonly unknown[],
): FnCall {
  if (args.length !== declared.length) {
    throw new OkmError(
      "OKM1120",
      `Function ${name} expects ${String(declared.length)} arguments.`,
      { fix: { summary: "Pass one value for each declared argument, in order." } },
    );
  }
  const parts: FragmentPart[] = [{ k: "t", s: `${quoteIdent(schemaName)}.${quoteIdent(name)}(` }];
  for (let index = 0; index < args.length; index += 1) {
    if (index > 0) parts.push({ k: "t", s: ", " });
    appendArg(parts, args[index], name);
  }
  parts.push({ k: "t", s: ")" });
  const textual = !(NUMERIC_RETURNS.has(returns) || returns.startsWith("numeric("));
  return sqlExpression(parts, textual) as unknown as FnCall;
}

/**
 * Appends one argument.
 *
 * @param parts - Call parts
 * @param value - The argument
 * @param name - Function name, for the error
 */
function appendArg(parts: FragmentPart[], value: unknown, name: string): void {
  if (value === null) {
    parts.push({ k: "n" });
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    parts.push({ k: "p", v: String(value) });
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OkmError("OKM1120", `Function ${name} needs a finite number.`, {
        fix: { summary: "Pass a finite number, or leave it out." },
      });
    }
    parts.push({ k: "p", v: String(value) });
    return;
  }
  const field = identName(value);
  if (field !== undefined) {
    parts.push({ k: "i", n: field });
    return;
  }
  if (isOperator(value) && operatorName(value) === "sql") {
    const stored = operatorValue(value);
    if (isFragmentParts(stored)) {
      parts.push({ k: "f", parts: stored });
      return;
    }
  }
  if (isHandle(value)) {
    assertIdentifier(value.name, `function ${name}`);
    parts.push({ k: "i", n: value.name });
    return;
  }
  throw new OkmError("OKM1121", `Function ${name} received a value it cannot bind.`, {
    fix: { summary: "Pass a string, number, boolean, null, or ident(field)." },
  });
}

/**
 * A `{ name }` handle that is not an operator.
 *
 * @param value - One argument
 * @returns Whether it names a field
 */
function isHandle(value: unknown): value is { readonly name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    !isOperator(value)
  );
}

/**
 * Declares a trigger.
 *
 * @param name - Trigger name, unique on its table
 * @param options - Table, timing, events, and the function it calls
 * @returns The definition object `schema({ triggers })` stores
 */
export function trigger(name: string, options: TriggerOptions): TriggerDeclaration {
  if (isEventTrigger(options)) {
    const compiler = readEventCompiler();
    if (compiler === undefined) {
      throw new OkmError(
        "OKM1931",
        `Event trigger ${name} needs okmodel/event. Import it before schema().`,
        { fix: { summary: 'Add import "okmodel/event" in the file that calls schema().' } },
      );
    }
    return compiler.declaration(name, {
      event: options.event,
      calls: options.calls,
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
    });
  }
  return {
    name,
    contribute(peers, built) {
      assertPeers(peers, "triggers");
      const parent = tableRef(options.on, built);
      const namespace = staticNamespace(options.calls.schema);
      const calls = {
        namespace,
        name: options.calls.name,
        argTypes: options.calls.argTypes,
      };
      if (!hasIdentity(built, { kind: "function", ...calls })) {
        throw new OkmError(
          "OKM1020",
          `Trigger ${name} calls ${options.calls.name}, which is not in the catalog.`,
          { fix: { summary: "List the function in schema({ functions }) before the trigger." } },
        );
      }
      for (const column of options.updateOf ?? []) {
        if (!hasIdentity(built, { kind: "column", parent, name: column })) {
          throw new OkmError(
            "OKM1020",
            `Trigger ${name} names column ${column}, which ${parent.name} does not have.`,
            { fix: { summary: "Name a column of the table the trigger is on." } },
          );
        }
      }
      if (options.referencing !== undefined) {
        assertReferencing(name, options, tablePartitioned(built, parent.name));
      }
      const when = options.when === undefined ? undefined : bodyText(options.when);
      for (const column of whenColumnNames(when)) {
        if (!hasIdentity(built, { kind: "column", parent, name: column })) {
          throw new OkmError(
            "OKM1020",
            `Trigger ${name} when names column ${column}, which ${parent.name} does not have.`,
            { fix: { summary: "Name a column of the table the trigger is on." } },
          );
        }
        if (options.timing === "before" && generatedWhen(built, parent.name, column)) {
          throw new OkmError(
            "OKM1920",
            `Trigger ${name} when references generated column ${column}. PostgreSQL refuses a generated column in a BEFORE row trigger.`,
            {
              fix: {
                summary: "Read the column in an AFTER row trigger, or repeat its expression.",
              },
            },
          );
        }
      }
      return [
        triggerObject({
          parent,
          name,
          timing: options.timing,
          events: options.events,
          level: options.level,
          calls,
          ...(options.updateOf !== undefined ? { updateOf: options.updateOf } : {}),
          ...(when !== undefined ? { when } : {}),
          ...(options.referencing !== undefined ? { referencing: options.referencing } : {}),
          provenance: { origin: "file", name },
          ...(options.comment !== undefined ? { comment: options.comment } : {}),
        }),
      ];
    },
  };
}

function isEventTrigger(options: TriggerOptions): options is EventTriggerOptions {
  return "event" in options && options.event !== undefined;
}

function assertReferencing(name: string, options: TableTriggerOptions, partitioned: boolean): void {
  const referencing = options.referencing;
  if (referencing === undefined) return;
  if (options.timing !== "after" || options.level !== "statement" || options.events.length !== 1) {
    throw new OkmError(
      "OKM1931",
      `Trigger ${name} transition tables need timing after, statement level, and one event.`,
      { fix: { summary: "Use after, for each statement, and a single event." } },
    );
  }
  if (options.updateOf !== undefined) {
    throw new OkmError("OKM1931", `Trigger ${name} transition tables cannot use updateOf.`, {
      fix: { summary: "Remove updateOf. A transition table sees the whole statement." },
    });
  }
  if (partitioned && options.level === "statement") {
    throw new OkmError(
      "OKM1931",
      `Trigger ${name} names transition tables on a partitioned table. PostgreSQL refuses them there. Use a statement-level trigger without referencing, or a plain table.`,
      { fix: { summary: "Remove referencing from the partitioned table." } },
    );
  }
  const event = options.events[0];
  const old = referencing.old !== undefined;
  const next = referencing.new !== undefined;
  if (!old && !next) {
    throw new OkmError("OKM1931", `Trigger ${name} referencing needs old or new.`, {
      fix: { summary: "Name the transition table." },
    });
  }
  if (event === "truncate" || (event === "insert" && old) || (event === "delete" && next)) {
    throw new OkmError("OKM1931", `Trigger ${name} ${event} cannot use that transition table.`, {
      fix: {
        summary:
          "insert names new, delete names old, and update names either. truncate names neither.",
      },
    });
  }
}

function tablePartitioned(built: unknown, table: string): boolean {
  if (!Array.isArray(built)) return false;
  for (const object of built) {
    if (!isRecord(object) || object.kind !== "table" || !isRecord(object.identity)) continue;
    if (object.identity.name !== table) continue;
    return isRecord(object.definition) && object.definition.partition !== undefined;
  }
  return false;
}

function bodyText(body: SqlText | string): string {
  return typeof body === "string" ? body : body.text;
}

function assertPeers(peers: unknown, option: "functions" | "triggers"): void {
  if (!Array.isArray(peers)) {
    throw new OkmError("OKM1020", `schema({ ${option} }) must be a list.`, {
      fix: { summary: `Pass an array to schema({ ${option} }).` },
    });
  }
}

function dependencyEdges(
  dependsOn: readonly DependsOn[] | undefined,
  built: unknown,
): readonly ObjectIdentity[] {
  if (dependsOn === undefined) return [];
  return dependsOn.map((item) => {
    if ("column" in item && "table" in item) {
      const parent = tableRef(item.table, built);
      const edge: ObjectIdentity = { kind: "column", parent, name: item.column };
      if (!hasIdentity(built, edge)) {
        throw new OkmError(
          "OKM1020",
          `dependsOn names column ${item.column}, which ${parent.name} does not have.`,
          { fix: { summary: "Name a column of a table in this schema." } },
        );
      }
      return edge;
    }
    const parent = tableRef(item, built);
    return { kind: "table", namespace: parent.namespace, name: parent.name };
  });
}

function tableRef(table: AnyTable, built: unknown): ObjectRef {
  if (!Array.isArray(built)) {
    throw new OkmError("OKM1020", `Table ${table.name} is not in the catalog.`, {
      fix: { summary: "List the table in schema({ tables })." },
    });
  }
  for (const object of built) {
    if (!isRecord(object) || object.kind !== "table") continue;
    const identity = object.identity;
    const provenance = object.provenance;
    if (!isRecord(identity) || !isRecord(provenance)) continue;
    if (
      provenance.origin === "file" &&
      provenance.name === table.name &&
      typeof identity.name === "string"
    ) {
      const namespace = identity.namespace;
      if (
        isRecord(namespace) &&
        namespace.form === "static" &&
        typeof namespace.name === "string"
      ) {
        return { namespace: staticNamespace(namespace.name), name: identity.name };
      }
    }
  }
  throw new OkmError("OKM1020", `Table ${table.name} is not in the catalog.`, {
    fix: { summary: "List the table in schema({ tables })." },
  });
}

function generatedWhen(built: unknown, table: string, column: string): boolean {
  if (!Array.isArray(built)) return false;
  for (const object of built) {
    if (!isRecord(object) || object.kind !== "column" || !isRecord(object.identity)) continue;
    const parent = object.identity.parent;
    if (object.identity.name !== column || !isRecord(parent) || parent.name !== table) continue;
    const definition = object.definition;
    return isRecord(definition) && definition.generated !== undefined;
  }
  return false;
}

function hasIdentity(built: unknown, identity: ObjectIdentity): boolean {
  if (!Array.isArray(built)) return false;
  for (const object of built) {
    if (!isRecord(object) || !isRecord(object.identity)) continue;
    if (same(object.identity, identity)) return true;
  }
  return false;
}

function same(left: Record<string, unknown>, right: ObjectIdentity): boolean {
  if (left.kind !== right.kind) return false;
  if (right.kind === "function") {
    return (
      left.name === right.name && JSON.stringify(left.argTypes) === JSON.stringify(right.argTypes)
    );
  }
  if (right.kind === "column") {
    const parent = left.parent;
    return left.name === right.name && isRecord(parent) && parent.name === right.parent.name;
  }
  if (right.kind === "table") return left.name === right.name;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
