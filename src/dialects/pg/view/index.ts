/**
 * `okmodel/view`.
 *
 * `view()` and `materializedView()` return objects that produce their own
 * catalog records. `schema()` only asks each declared object for those records.
 * DDL, diffing, and scratch verification stay out of this module's callers
 * until a plan or a check loads them.
 */

import { OkmError } from "../../../contracts/error.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import {
  materializedViewIndex,
  materializedViewObject,
  viewObject,
} from "../../../contracts/catalog/view.js";
import type { CatalogObject, Provenance } from "../../../contracts/catalog/types.js";
import { formatType } from "../column.js";
import { quoteIdent } from "../ddl.js";
import type { SchemaHook } from "../model.js";
import { type Names, namesFor } from "../casing.js";
import type { AnyTable, SqlText } from "../table.js";
import { viewClient, type ViewInstall } from "./client.js";

/** One declared output column. `type` is the Postgres type name. */
export type ViewColumnInput = {
  readonly name: string;
  readonly type: string;
};

/** Options for {@link view}. */
export type ViewOptions = {
  readonly columns: readonly ViewColumnInput[];
  readonly query: SqlText | string;
  /** Schema. The default is `public`. */
  readonly schema?: string;
  /**
   * Opts the view out of tenancy.
   *
   * A view that reads a tenant table and does not expose the tenant key is
   * OKM1820 unless this is `global("reason")`.
   */
  readonly tenancy?: unknown;
};

/** Output columns of {@link ViewFrom.from}. A tuple keeps each name. */
type TupleColumns<K extends readonly string[]> = K extends readonly []
  ? readonly []
  : K extends readonly [infer H extends string, ...infer R extends readonly string[]]
    ? readonly [{ readonly name: H; readonly type: string }, ...TupleColumns<R>]
    : readonly { readonly name: K[number]; readonly type: string }[];

/** Every column of a table, when `from` is not given a list. */
type AllColumns<T extends AnyTable> = readonly {
  readonly name: keyof T["columns"] & string;
  readonly type: string;
}[];

/** An output column of `q.from`: the SQL name, and the table field it reads. */
type RenderedColumn = ViewColumnInput & { readonly source: string };

const BUILT = Symbol("okmodel.view.from");

/** What `q.from` stores. `install` renders the SQL once the schema names are known. */
type Recipe = {
  readonly [BUILT]: true;
  readonly table: AnyTable;
  readonly picked: readonly string[] | undefined;
  readonly predicate: string | undefined;
  readonly mark: unknown;
};

/**
 * The value `(q) => q.from(...)` returns.
 *
 * @typeParam C - Output columns, for `db.views`
 */
export type ViewBuilt<C extends readonly ViewColumnInput[] = readonly ViewColumnInput[]> = {
  /** Declared columns. Present for the type. The catalog uses the SQL names. */
  readonly "~columns"?: C;
  /**
   * Adds a WHERE clause.
   *
   * The text is stored as written, the same way `query` is.
   *
   * @param predicate - SQL after `where`
   * @returns The same view, with the clause
   */
  where(predicate: SqlText | string): ViewBuilt<C>;
  /**
   * Opts the view out of tenancy.
   *
   * Pass `global("reason")` from `okmodel/tenancy`.
   *
   * @param mark - `global("reason")`
   * @returns The same view, opted out
   */
  tenancy(mark: unknown): ViewBuilt<C>;
};

/**
 * The argument of `view(name, (q) => q.from(...))`.
 */
export type ViewFrom = {
  /**
   * Selects every column of `table`.
   *
   * @param table - Source table
   * @returns The view query
   */
  from<const T extends AnyTable>(table: T): ViewBuilt<AllColumns<T>>;
  /**
   * Selects `columns` from `table`, in that order.
   *
   * @param table - Source table
   * @param columns - Output columns. Names are the table's fields
   * @returns The view query
   */
  from<const T extends AnyTable, const K extends readonly (keyof T["columns"] & string)[]>(
    table: T,
    columns: K,
  ): ViewBuilt<TupleColumns<K>>;
};

/**
 * One declared view.
 *
 * `contribute` builds the catalog record. Column dependencies are filled
 * from `pg_depend` by scratch verification, not at this call.
 *
 * @typeParam N - View name
 * @typeParam C - Declared output columns
 */
export type ViewDeclaration<
  N extends string = string,
  C extends readonly ViewColumnInput[] = readonly ViewColumnInput[],
> = {
  readonly name: N;
  readonly schema: string;
  /** Declared columns, for types only. `db.views` reads them. */
  readonly "~columns"?: C;
  /** `"view"`. A materialized view is `"materialized"`, which adds `refresh()`. */
  readonly "~kind": "view";
  /**
   * Catalog record for this declaration.
   *
   * @param peers - The `schema({ views })` list
   * @param built - Objects the schema has already staged
   * @returns The view record
   */
  contribute(peers: unknown, built: unknown): readonly CatalogObject[];
  /** Publishes the read model. `schema()` calls it. */
  install: ViewInstall;
  /** Moves the read handle under `db.views`. */
  hook: SchemaHook;
};

/** One index owned by a materialized view. */
export type MaterializedViewIndexInput = {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
};

/** Options for {@link materializedView}. */
export type MaterializedViewOptions = ViewOptions & {
  readonly indexes?: readonly MaterializedViewIndexInput[];
  /**
   * Populate mode.
   *
   * `"concurrently"` plans `REFRESH MATERIALIZED VIEW CONCURRENTLY` and
   * requires a unique index (OKM1822). Omitted still populates, without
   * `CONCURRENTLY`.
   */
  readonly refresh?: "concurrently";
};

/**
 * One declared materialized view.
 *
 * Identity is `(namespace, name)`. Indexes are separate catalog objects.
 *
 * @typeParam N - Materialized view name
 * @typeParam C - Declared output columns
 */
export type MaterializedViewDeclaration<
  N extends string = string,
  C extends readonly ViewColumnInput[] = readonly ViewColumnInput[],
> = {
  readonly name: N;
  readonly schema: string;
  /** Declared columns, for types only. `db.views` reads them. */
  readonly "~columns"?: C;
  /** `"materialized"`. `db.views` adds `refresh()` for this kind only. */
  readonly "~kind": "materialized";
  /**
   * Catalog records for this declaration.
   *
   * @param peers - The `schema({ views })` list
   * @param built - Objects the schema has already staged
   * @returns The materialized view and its indexes
   */
  contribute(peers: unknown, built: unknown): readonly CatalogObject[];
  /** Publishes the read model. `schema()` calls it. */
  install: ViewInstall;
  /** Moves the read handle under `db.views`. */
  hook: SchemaHook;
};

/**
 * Declares a view as SQL with output columns.
 *
 * The query is stored as written. A scratch database reads `pg_depend` and
 * `pg_get_viewdef` before a plan treats the body as canonical.
 *
 * @param name - View name
 * @param options - Columns and query
 * @returns The definition object `schema({ views })` stores
 */
export function view<const N extends string, const C extends readonly ViewColumnInput[]>(
  name: N,
  options: ViewOptions & { readonly columns: C },
): ViewDeclaration<N, C>;
/**
 * Declares a view from a table.
 *
 * `view(name, (q) => q.from(table))` selects that table's columns. Pass a
 * column list to project. `.where` adds a predicate. `.tenancy` opts out.
 *
 * @param name - View name
 * @param build - `q.from(...)`
 * @returns The definition object `schema({ views })` stores
 */
export function view<const N extends string, const C extends readonly ViewColumnInput[]>(
  name: N,
  build: (q: ViewFrom) => ViewBuilt<C>,
): ViewDeclaration<N, C>;
export function view<const N extends string, const C extends readonly ViewColumnInput[]>(
  name: N,
  source: (ViewOptions & { readonly columns: C }) | ((q: ViewFrom) => ViewBuilt<C>),
): ViewDeclaration<N, C> {
  if (typeof source === "function") return viewFrom(name, source);
  const options = source;
  const schema = options.schema ?? "public";
  const columns = options.columns.map((column) => ({ name: column.name, dataType: column.type }));
  const query = bodyText(options.query);
  const bound = viewClient(name, options.columns, query, options.tenancy, "plain");
  let securityInvoker = false;
  return {
    name,
    schema,
    "~kind": "view",
    install(model, tenancy, tables, names, scoped) {
      bound.install(model, tenancy, tables, names, scoped);
      securityInvoker = tenancy?.strategy === "rls" && scoped.has(name);
    },
    hook: bound.hook,
    contribute(peers, built) {
      assertPeers(peers);
      assertNoTable(built, name);
      const provenance: Provenance = { origin: "file", name };
      return [
        viewObject({
          namespace: staticNamespace(schema),
          name,
          columns,
          query,
          provenance,
          ...(securityInvoker ? { securityInvoker: true as const } : {}),
        }),
      ];
    },
  };
}

/**
 * Declares a materialized view.
 *
 * Creation is `WITH NO DATA`. Populate is a later plan step. `refresh:
 * "concurrently"` without a unique index is OKM1822.
 *
 * @param name - Materialized view name
 * @param options - Columns, query, indexes, and refresh mode
 * @returns The definition object `schema({ views })` stores
 */
export function materializedView<
  const N extends string,
  const C extends readonly ViewColumnInput[],
>(
  name: N,
  options: MaterializedViewOptions & { readonly columns: C },
): MaterializedViewDeclaration<N, C> {
  const schema = options.schema ?? "public";
  const columns = options.columns.map((column) => ({ name: column.name, dataType: column.type }));
  const query = bodyText(options.query);
  if (options.refresh !== undefined && options.refresh !== "concurrently") {
    throw new OkmError("OKM1120", `Materialized view ${name} refresh must be "concurrently".`, {
      fix: { summary: 'Omit refresh, or pass refresh: "concurrently" with a unique index.' },
    });
  }
  const bound = viewClient(
    name,
    options.columns,
    query,
    options.tenancy,
    options.refresh === "concurrently" ? "concurrently" : "blocking",
  );
  const indexes = options.indexes ?? [];
  if (options.refresh === "concurrently" && !indexes.some((index) => index.unique === true)) {
    throw new OkmError(
      "OKM1822",
      `Materialized view ${name} refreshes concurrently and has no unique index.`,
      { fix: { summary: "Add a unique index, or refresh without CONCURRENTLY." } },
    );
  }
  const columnNames = new Set(columns.map((column) => column.name));
  for (const index of indexes) {
    for (const column of index.columns) {
      if (!columnNames.has(column)) {
        throw new OkmError(
          "OKM1020",
          `Index on ${name} names column ${column}, which the materialized view does not have.`,
          { fix: { summary: "Name a column of the materialized view." } },
        );
      }
    }
  }
  return {
    name,
    schema,
    "~kind": "materialized",
    install: bound.install,
    hook: bound.hook,
    contribute(peers, built) {
      assertPeers(peers);
      assertNoTable(built, name);
      const namespace = staticNamespace(schema);
      const provenance: Provenance = { origin: "file", name };
      const parent = { namespace, name };
      return [
        materializedViewObject({
          namespace,
          name,
          columns,
          query,
          provenance,
          ...(options.refresh === "concurrently" ? { refresh: "concurrently" as const } : {}),
        }),
        ...indexes.map((index) =>
          materializedViewIndex({
            parent,
            ...(index.name !== undefined ? { name: index.name } : {}),
            columns: index.columns,
            ...(index.unique === true ? { unique: true } : {}),
            provenance,
          }),
        ),
      ];
    },
  };
}

const viewFromApi = {
  from(table: AnyTable, columns?: readonly string[]): ViewBuilt {
    return finish({
      [BUILT]: true,
      table,
      picked: columns,
      predicate: undefined,
      mark: undefined,
    });
  },
} as ViewFrom;

/**
 * Declares a view from `(q) => q.from(...)`.
 *
 * @param name - View name
 * @param build - The callback
 * @returns The view declaration
 */
function viewFrom<const N extends string, const C extends readonly ViewColumnInput[]>(
  name: N,
  build: (q: ViewFrom) => ViewBuilt<C>,
): ViewDeclaration<N, C> {
  const built = build(viewFromApi);
  if (!isRecipe(built)) {
    throw new OkmError("OKM1121", `View ${name} must return q.from(...).`, {
      fix: { summary: "Return q.from(table), and chain where() or tenancy() on that value." },
    });
  }
  const recipe = built;
  let namesMode: Names | undefined;
  let rendered: { readonly query: string; readonly columns: readonly RenderedColumn[] } | undefined;
  const render = (): { readonly query: string; readonly columns: readonly RenderedColumn[] } => {
    rendered ??= renderQuery(name, recipe, namesMode ?? namesFor(undefined));
    return rendered;
  };
  const bound = viewClient(
    name,
    () => render().columns,
    () => render().query,
    recipe.mark,
    "plain",
  );
  let securityInvoker = false;
  return {
    name,
    schema: "public",
    "~kind": "view",
    install(model, tenancy, tables, names, scoped) {
      namesMode = names;
      rendered = undefined;
      bound.install(model, tenancy, tables, names, scoped);
      securityInvoker = tenancy?.strategy === "rls" && scoped.has(name);
    },
    hook: bound.hook,
    contribute(peers, builtObjects) {
      assertPeers(peers);
      assertNoTable(builtObjects, name);
      const query = render().query;
      const columns = render().columns.map((column) => ({
        name: column.name,
        dataType: column.type,
      }));
      const provenance: Provenance = { origin: "file", name };
      return [
        viewObject({
          namespace: staticNamespace("public"),
          name,
          columns,
          query,
          provenance,
          ...(securityInvoker ? { securityInvoker: true as const } : {}),
        }),
      ];
    },
  };
}

/**
 * Reports whether `value` is a {@link Recipe}.
 *
 * @param value - The callback result
 * @returns Whether `from` created it
 */
function isRecipe(value: unknown): value is Recipe {
  return typeof value === "object" && value !== null && BUILT in value;
}

/**
 * Chains `where` and `tenancy` on one recipe.
 *
 * @param recipe - The from() state
 * @returns The builder value
 */
function finish<C extends readonly ViewColumnInput[]>(recipe: Recipe): ViewBuilt<C> {
  const built = {
    ...recipe,
    where(predicate: SqlText | string): ViewBuilt<C> {
      return finish({ ...recipe, predicate: bodyText(predicate) });
    },
    tenancy(mark: unknown): ViewBuilt<C> {
      return finish({ ...recipe, mark });
    },
  };
  return built;
}

/**
 * Renders `select ... from ...` with the schema's SQL names.
 *
 * @param name - View name, for errors
 * @param recipe - The from() state
 * @param names - Name lookups for the schema
 * @returns The query and the SQL column names
 */
function renderQuery(
  name: string,
  recipe: Recipe,
  names: Names,
): { readonly query: string; readonly columns: readonly RenderedColumn[] } {
  const fields = recipe.picked ?? Object.keys(recipe.table.columns);
  if (fields.length === 0) {
    throw new OkmError("OKM1120", `View ${name} selects no columns.`, {
      fix: { summary: "Pick at least one column of the table." },
    });
  }
  const columns: RenderedColumn[] = [];
  const selected: string[] = [];
  for (const field of fields) {
    const column = recipe.table.columns[field];
    if (column === undefined || typeof column !== "object" || column === null) {
      throw new OkmError(
        "OKM1020",
        `View ${name} names ${field}, which ${recipe.table.name} does not have.`,
        { fix: { summary: "Pass a column of that table." } },
      );
    }
    const sqlName = columnSql(column, field, names);
    columns.push({ name: sqlName, type: columnType(column, field), source: field });
    selected.push(quoteIdent(sqlName));
  }
  const tableName = names.table(recipe.table);
  let query = `select ${selected.join(", ")} from ${quoteIdent(tableName)}`;
  if (recipe.predicate !== undefined && recipe.predicate.trim().length > 0) {
    query += ` where ${recipe.predicate}`;
  }
  return { query, columns };
}

/**
 * SQL name of one output column.
 *
 * @param column - Column builder
 * @param field - TypeScript field
 * @param names - Name lookups for the schema
 * @returns The name in the SELECT list
 */
function columnSql(column: object, field: string, names: Names): string {
  const state = readState(column, field);
  if (state.sqlName !== undefined && state.sqlName.length > 0) return state.sqlName;
  return names.name(field);
}

/**
 * Postgres type of one output column.
 *
 * @param column - Column builder
 * @param field - TypeScript field, for the error
 * @returns The type name stored on the view
 */
function columnType(column: object, field: string): string {
  const state = readState(column, field);
  return formatType(state.baseType, state.dims);
}

/**
 * Reads `baseType` and `dims` off a column builder.
 *
 * @param column - Column builder
 * @param field - TypeScript field, for the error
 * @returns The state the builder stores
 */
function readState(
  column: object,
  field: string,
): { readonly baseType: string; readonly dims: number; readonly sqlName: string | undefined } {
  if (!("state" in column)) {
    throw new OkmError("OKM1020", `Column ${field} has no type.`, {
      fix: { summary: "Pass a column built with t." },
    });
  }
  const state = column.state;
  if (typeof state !== "object" || state === null || !("baseType" in state)) {
    throw new OkmError("OKM1020", `Column ${field} has no type.`, {
      fix: { summary: "Pass a column built with t." },
    });
  }
  const baseType = state.baseType;
  const dims = "dims" in state && typeof state.dims === "number" ? state.dims : 0;
  const sqlName =
    "sqlName" in state && typeof state.sqlName === "string" ? state.sqlName : undefined;
  if (typeof baseType !== "string" || baseType.length === 0) {
    throw new OkmError("OKM1020", `Column ${field} has no type.`, {
      fix: { summary: "Pass a column built with t." },
    });
  }
  return { baseType, dims, sqlName };
}

function bodyText(body: SqlText | string): string {
  return typeof body === "string" ? body : body.text;
}

function assertPeers(peers: unknown): void {
  if (!Array.isArray(peers)) {
    throw new OkmError("OKM1020", "schema({ views }) must be a list.", {
      fix: { summary: "Pass an array to schema({ views })." },
    });
  }
}

function assertNoTable(built: unknown, name: string): void {
  if (!Array.isArray(built)) return;
  for (const object of built) {
    if (!isRecord(object) || object.kind !== "table" || !isRecord(object.identity)) continue;
    if (object.identity.name === name) {
      throw new OkmError("OKM1023", `View ${name} uses the name of a table.`, {
        fix: { summary: "Give the view a name that no table uses." },
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
