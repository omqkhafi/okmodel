/**
 * Read model and client hook for a declared view.
 *
 * `schema()` calls `install` and the client calls `hook`. Neither path is
 * imported by a featureless app. Writes are not copied onto the handle.
 */

import { OkmError } from "../../../contracts/error.js";
import type { ColumnTenancy } from "../tenancy.js";
import type { ColumnModel, SchemaHook, SchemaHookCtx, TableModel } from "../model.js";
import type { Names } from "../casing.js";
import type { AnyTable } from "../table.js";
import { decodeText, encodeText } from "../text.js";
import { decodeUuid, encodeUuid } from "../keys.js";

const globalViews = new WeakMap<object, string>();

/**
 * Reason from `global("reason")` on a view, when the view opted out.
 *
 * The reason is not a catalog field, so the catalog hash does not change.
 *
 * @param model - The view's query model
 * @returns The reason, or `undefined` when the view is not global
 */
export function viewGlobalReason(model: object): string | undefined {
  return globalViews.get(model);
}

/**
 * Whether `query` names `name` as an identifier.
 *
 * @param query - Author SQL
 * @param name - Table name, SQL or client
 * @returns Whether the text mentions that name
 */
export function viewMentions(query: string, name: string): boolean {
  let pattern = '(^|[^A-Za-z0-9_])"?';
  for (const char of name) {
    if ("\\^$[]().*+?|{}".includes(char)) pattern += "\\";
    pattern += char;
  }
  pattern += '"?(?![A-Za-z0-9_])';
  return new RegExp(pattern).test(query);
}

/** What `schema()` passes when it binds a view. */
export type ViewInstall = (
  model: { [name: string]: TableModel },
  tenancy: ColumnTenancy | undefined,
  tables: readonly AnyTable[],
  names: Names,
  scoped: Set<string>,
) => void;

/**
 * One output column. `source` is the table field a `q.from` column reads. The
 * client key comes from it, so a cased SQL name cannot change the key.
 */
type SourceColumn = {
  readonly name: string;
  readonly type: string;
  readonly source?: string;
  readonly nullable?: boolean;
  readonly strict?: boolean;
  readonly encode?: (value: unknown) => string;
  readonly decode?: (wire: string) => unknown;
};

/** A value, or a function `install` calls once the schema names are known. */
type ColumnSource = readonly SourceColumn[] | (() => readonly SourceColumn[]);

/** A query string, or a function `install` calls once the schema names are known. */
type QuerySource = string | (() => string);

/**
 * Reads declared columns. A function runs then.
 *
 * @param source - Columns or a getter
 * @returns The columns
 */
function readColumns(source: ColumnSource): readonly SourceColumn[] {
  return typeof source === "function" ? source() : source;
}

/**
 * Reads the query. A function runs then.
 *
 * @param source - SQL or a getter
 * @returns The SQL
 */
function readQuery(source: QuerySource): string {
  return typeof source === "function" ? source() : source;
}

/**
 * Client name, read model, and the hook that moves the handle under `views`.
 *
 * @param name - SQL name of the view
 * @param columns - Declared output columns, or a getter `install` calls
 * @param query - Author SQL, or a getter `install` calls
 * @param tenancy - `global("reason")`, when the view opts out
 * @param refresh - `plain` stores no `refresh`. A materialized view is `blocking` or `concurrently`
 * @returns Methods stored on the declaration
 */
export function viewClient(
  name: string,
  columns: ColumnSource,
  query: QuerySource,
  tenancy: unknown,
  refresh: "plain" | "blocking" | "concurrently" = "plain",
): { readonly field: string; readonly install: ViewInstall; readonly hook: SchemaHook } {
  const field = camelCase(name);
  const marked = readGlobal(name, tenancy);
  let strictFields: readonly string[] = [];
  return {
    field,
    install(model, scope, tables, names, scoped) {
      const listed = readColumns(columns);
      const text = readQuery(query);
      if (Object.hasOwn(model, field)) {
        throw new OkmError("OKM1023", `View ${name} uses the client name ${field}.`, {
          fix: { summary: "Give the view a name that no table uses." },
        });
      }
      const exposes = exposesKey(listed, scope, names);
      if (scope !== undefined && readsTenant(text, tables, names, scoped)) {
        if (!exposes && marked === undefined) {
          throw new OkmError(
            "OKM1820",
            `View ${name} reads a tenant table and does not expose ${scope.key}.`,
            {
              fix: {
                summary:
                  "Expose the tenant key so the predicate can be applied, or declare global(reason).",
              },
            },
          );
        }
        if (exposes) {
          scope.scopeView(field);
          scoped.add(name);
        }
      }
      const models = columnModels(listed, scope, names);
      strictFields = models.strict;
      const built: TableModel = {
        name: field,
        sql: name,
        primary: [],
        uniques: [],
        columns: models.columns,
        relations: [],
      };
      if (marked !== undefined) globalViews.set(built, marked);
      model[field] = built;
    },
    hook(target, ctx) {
      if (ctx.table === field && ctx.session !== undefined) {
        if (refresh !== "plain") target.refresh = refreshHandle(ctx.session, name, refresh);
        return;
      }
      publish(field, target, ctx, strictFields);
    },
  };
}

/**
 * `refresh()` for one materialized view.
 *
 * The call returns a thenable and does not start the statement. The import
 * and the refresh run on the first `await`, the same way a query handle does.
 * `batch` sees `~refresh` and refuses the handle before any statement.
 *
 * @param session - Client session from the table hook
 * @param name - SQL name
 * @param mode - Blocking or concurrent. A plain view does not call this
 * @returns The method stored on the handle
 */
function refreshHandle(
  session: object,
  name: string,
  mode: "blocking" | "concurrently",
): () => Promise<void> {
  const concurrently = mode === "concurrently";
  return () =>
    lazyRefresh(() =>
      import("./refresh.js").then((mod) => mod.refreshView(session, name, concurrently)),
    );
}

/**
 * A thenable that starts `run` the first time it is awaited.
 *
 * Calling `refresh()` does not start it, so an unawaited failure is not an
 * unhandled rejection, and `batch` can refuse the handle before any statement.
 *
 * @param run - The refresh. Called at most once
 * @returns The handle `await` and `batch` see
 */
function lazyRefresh(run: () => Promise<void>): Promise<void> {
  let pending: Promise<void> | undefined;
  const once = (): Promise<void> => {
    pending ??= run();
    return pending;
  };
  const self = {
    // oxlint-disable-next-line unicorn/no-thenable -- await starts the refresh; calling it does not
    then(
      onFulfilled?: (value: void) => unknown,
      onRejected?: (error: unknown) => unknown,
    ): Promise<unknown> {
      return once().then(onFulfilled, onRejected);
    },
    catch(onRejected?: (error: unknown) => unknown): Promise<unknown> {
      return self.then(undefined, onRejected);
    },
    finally(fn: () => void): Promise<unknown> {
      return self.then(
        (value) => {
          fn();
          return value;
        },
        (error: unknown) => {
          fn();
          throw error;
        },
      );
    },
    "~refresh": true as const,
  };
  return self as unknown as Promise<void>;
}

function publish(
  field: string,
  target: Record<string, unknown>,
  ctx: SchemaHookCtx,
  strict: readonly string[],
): void {
  if (ctx.tables === undefined || ctx.table !== undefined) return;
  const handle = ctx.tables[field];
  if (typeof handle !== "object" || handle === null) return;
  const source = handle as Record<string, unknown>;
  const views = target.views;
  const map: Record<string, unknown> =
    typeof views === "object" && views !== null ? (views as Record<string, unknown>) : {};
  map[field] = {
    find: guard(source.find, strict, false),
    one: guard(source.one, strict, true),
    count: source.count,
    exists: source.exists,
    ...(typeof source.aggregate === "function"
      ? { aggregate: guard(source.aggregate, strict, false) }
      : {}),
    ...(typeof source.refresh === "function" ? { refresh: source.refresh } : {}),
  };
  target.views = map;
  delete ctx.tables[field];
  delete target[field];
}

/**
 * Checks a non-null view column after the row is decoded.
 *
 * The wrapper stays lazy: the query starts when the handle is awaited, the
 * same way the table handle does.
 *
 * @param method - `find`, `one`, or `aggregate` on the table handle
 * @param strict - Client fields declared not null
 * @param one - The result is one row, or null
 * @returns The same method, refusing NULL in a non-null column
 */
function guard(method: unknown, strict: readonly string[], one: boolean): unknown {
  if (typeof method !== "function" || strict.length === 0) return method;
  return (options?: unknown) => {
    const pending = (method as (input?: unknown) => Promise<unknown> & Record<string, unknown>)(
      options,
    );
    const self = {
      // oxlint-disable-next-line unicorn/no-thenable -- await starts the query; calling find does not
      then(onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
        return Promise.resolve(pending)
          .then((value) => checkNulls(value, strict, one))
          .then(onFulfilled, onRejected);
      },
      catch(onRejected?: (error: unknown) => unknown) {
        return self.then(undefined, onRejected);
      },
      finally(fn: () => void) {
        return self.then(
          (value) => {
            fn();
            return value;
          },
          (error: unknown) => {
            fn();
            throw error;
          },
        );
      },
      sql: typeof pending.sql === "function" ? pending.sql.bind(pending) : undefined,
      inspect: typeof pending.inspect === "function" ? pending.inspect.bind(pending) : undefined,
    };
    return self;
  };
}

function checkNulls(value: unknown, strict: readonly string[], one: boolean): unknown {
  if (one) {
    if (value !== null && typeof value === "object")
      scan([value as Record<string, unknown>], strict);
    return value;
  }
  if (Array.isArray(value)) scan(value as readonly Record<string, unknown>[], strict);
  return value;
}

function scan(rows: readonly Record<string, unknown>[], strict: readonly string[]): void {
  for (const row of rows) {
    for (const field of strict) {
      if (row[field] == null) {
        throw new OkmError(
          "OKM1901",
          `View column ${field} is declared not null and the database returned NULL.`,
          {
            fix: {
              summary:
                "Declare the column with .nullable(), or stop the query from returning NULL.",
            },
          },
        );
      }
    }
  }
}

function columnModels(
  columns: readonly SourceColumn[],
  tenancy: ColumnTenancy | undefined,
  names: Names,
): { readonly columns: readonly ColumnModel[]; readonly strict: readonly string[] } {
  const seen = new Set<string>();
  const models: ColumnModel[] = [];
  const strict: string[] = [];
  for (const column of columns) {
    const field = fieldName(column.source ?? column.name, tenancy, names);
    if (seen.has(field)) {
      throw new OkmError("OKM1020", `View column ${column.name} repeats ${field}.`, {
        fix: { summary: "Declare each output column once." },
      });
    }
    seen.add(field);
    const uuid = column.type.toLowerCase() === "uuid";
    const key = tenancy !== undefined && field === tenancy.key;
    if (column.strict === true) strict.push(field);
    models.push({
      field,
      sql: column.name,
      dataType: column.type,
      encode:
        column.encode ??
        (uuid
          ? (value: unknown) => encodeUuid(textValue(value))
          : (value: unknown) => encodeText(textValue(value))),
      decode: column.decode ?? (uuid ? decodeUuid : decodeText),
      hidden: false,
      sensitive: false,
      guarded: key,
      writable: false,
      guardUpdate: false,
      ...(column.nullable === true ? { nullable: true } : {}),
    });
  }
  return { columns: models, strict };
}

function exposesKey(
  columns: readonly SourceColumn[],
  tenancy: ColumnTenancy | undefined,
  names: Names,
): boolean {
  if (tenancy === undefined) return false;
  return columns.some(
    (column) => fieldName(column.source ?? column.name, tenancy, names) === tenancy.key,
  );
}

function readsTenant(
  query: string,
  tables: readonly AnyTable[],
  names: Names,
  scoped: ReadonlySet<string>,
): boolean {
  for (const name of scoped) {
    if (viewMentions(query, name)) return true;
  }
  for (const table of tables) {
    const mark = (table.options as { readonly tenancy?: unknown } | undefined)?.tenancy;
    if (isGlobalMark(mark)) continue;
    const sql = names.table(table);
    if (viewMentions(query, sql) || viewMentions(query, table.name)) return true;
  }
  return false;
}

function readGlobal(name: string, tenancy: unknown): string | undefined {
  if (tenancy === undefined) return undefined;
  if (!isGlobalMark(tenancy)) {
    throw new OkmError("OKM1020", `View ${name} tenancy must be global("reason").`, {
      fix: { summary: 'Pass global("reason") from okmodel/tenancy, or omit tenancy.' },
    });
  }
  return tenancy.reason;
}

function isGlobalMark(
  value: unknown,
): value is { readonly kind: "global"; readonly reason: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { readonly kind?: unknown; readonly reason?: unknown };
  return (
    record.kind === "global" && typeof record.reason === "string" && record.reason.trim().length > 0
  );
}

function fieldName(column: string, tenancy: ColumnTenancy | undefined, names: Names): string {
  const field = camelCase(column);
  if (
    tenancy !== undefined &&
    (column === tenancy.key || field === tenancy.key || column === names.name(tenancy.key))
  )
    return tenancy.key;
  return field;
}

function camelCase(name: string): string {
  let out = "";
  let upper = false;
  for (const char of name) {
    if (char === "_") {
      upper = out.length > 0;
      continue;
    }
    out += upper ? char.toUpperCase() : char;
    upper = false;
  }
  return out;
}

function textValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new OkmError("OKM1121", "A view column value must be text.", {
      fix: { summary: "Pass a string." },
    });
  }
  return value;
}
