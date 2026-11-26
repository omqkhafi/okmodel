/**
 * Typed views and materialized views.
 *
 * The body is the query API: `q.<table>.find` and `.aggregate`, or `q.sql`
 * when the query needs SQL the compiler does not print. `q` has only the
 * tables and views named in `tables`. The callback runs when `schema()`
 * builds the model, not when this module is imported.
 */

import type {
  CatalogObject,
  ObjectIdentity,
  Provenance,
} from "../../../contracts/catalog/types.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import {
  materializedViewIndex,
  materializedViewObject,
  viewObject,
} from "../../../contracts/catalog/view.js";
import { OkmError } from "../../../contracts/error.js";
import type { Names } from "../casing.js";
import { ColumnBuilder, type ColumnFlags, type ColumnRowOf } from "../column.js";
import type { Expr } from "../expr/index.js";
import type { SchemaHook } from "../model.js";
import { beginGrantBatch, rememberGrants } from "../role/grant-slot.js";
import type { IndexCall, SqlText } from "../table.js";
import { viewClient, type ViewInstall } from "./client.js";
import { compileView, type CapturedBody, type CompiledView, type ViewTenant } from "./compile.js";

/** A column the view type remembers. `value` and `nullable` are type-only. */
export type ViewColumnPhantom = {
  readonly name: string;
  readonly value?: unknown;
  readonly nullable?: boolean;
};

/** One declared table or view a body may read. */
type Named = { readonly name: string };

/** Options shared by a view and a materialized view. */
type CommonOptions<Sources extends readonly Named[]> = {
  /** Tables and views this body may read. Creation order follows this list. */
  readonly tables: Sources;
  /** Schema name. Omitted is `public`. */
  readonly schema?: string;
  /** Opts the view out of tenancy. The reason is not stored in the catalog. */
  readonly tenancy?: unknown;
  /** Privileges keyed by `roles` keys. A materialized view accepts read or maintain. */
  readonly grants?: Readonly<Record<string, unknown>>;
  /** Comment on the view. Absent means unmanaged. */
  readonly comment?: string;
  /** Comments on output columns, by output name. Absent means unmanaged. */
  readonly comments?: Readonly<Record<string, string>>;
};

/** Options of {@link view}. */
export type ViewOptions<Sources extends readonly Named[]> = CommonOptions<Sources> & {
  /**
   * `security_invoker` (the default) or a definer view.
   *
   * `{ definer: reason }` also sets `security_barrier`. The reason is not stored.
   */
  readonly security?: "invoker" | { readonly definer: string };
  /** `security_barrier`. A definer view sets this even when it is omitted. */
  readonly barrier?: true;
  /** `WITH CHECK OPTION`. The database enforces it. The client does not. */
  readonly checkOption?: "local" | "cascaded";
};

/** Options of {@link materializedView}. */
export type MaterializedViewOptions<Sources extends readonly Named[]> = CommonOptions<Sources> & {
  /** `REFRESH MATERIALIZED VIEW CONCURRENTLY` after the first populate. */
  readonly refresh?: "concurrently";
  /** Indexes, the same calls `index()` returns on a table. */
  readonly indexes?:
    | readonly IndexCall[]
    | ((columns: Readonly<Record<string, { readonly name: string }>>) => readonly IndexCall[]);
  /** Access method. Omitted uses heap. */
  readonly using?: string;
  /** Storage parameters, such as `{ fillfactor: "70" }`. */
  readonly with?: Readonly<Record<string, string | number>>;
  /** Tablespace. Omitted uses the database default. */
  readonly tablespace?: string;
  /**
   * `now` populates in the plan. `later` creates the view `with no data`
   * and does not refresh it.
   */
  readonly populate?: "now" | "later";
};

/** A view declaration `schema({ views })` accepts. */
export type ViewDeclaration<
  N extends string = string,
  Cols extends readonly ViewColumnPhantom[] = readonly ViewColumnPhantom[],
> = {
  readonly name: N;
  readonly "~kind": "view";
  readonly "~columns": Cols;
  readonly install: ViewInstall;
  readonly hook: SchemaHook;
  readonly contribute: (
    peers: unknown,
    built: readonly CatalogObject[],
    names: Names,
  ) => readonly CatalogObject[];
};

/** A materialized view declaration. `~kind` is what adds `refresh()` on the client. */
export type MaterializedViewDeclaration<
  N extends string = string,
  Cols extends readonly ViewColumnPhantom[] = readonly ViewColumnPhantom[],
> = Omit<ViewDeclaration<N, Cols>, "~kind"> & { readonly "~kind": "materialized" };

type ColumnList<C> = readonly {
  readonly [K in keyof C]: K extends string
    ? {
        readonly name: K;
        readonly value: ColumnRowOf<C[K]>;
        readonly nullable: C[K] extends ColumnBuilder<unknown, infer F> ? F["nullable"] : true;
      }
    : never;
}[keyof C][];

type Visible<C> = {
  readonly [
    K in keyof C as C[K] extends ColumnBuilder<unknown, infer F>
      ? F["hidden"] extends true
        ? never
        : K
      : K
  ]: C[K];
};

type FindResult<C, O> = {
  readonly op: "find";
  readonly "~columns": O extends { readonly select: readonly (infer Item)[] }
    ? readonly ItemOf<C, Item>[]
    : ColumnList<Visible<C>>;
};

type ItemOf<C, Item> = Item extends keyof C
  ? {
      readonly name: Item;
      readonly value: ColumnRowOf<C[Item]>;
      readonly nullable: C[Item] extends ColumnBuilder<any, infer F> ? F["nullable"] : true;
    }
  : Item extends Expr<infer T, infer Nul> & { readonly "~as": infer N extends string }
    ? { readonly name: N; readonly value: T; readonly nullable: Nul }
    : { readonly name: string; readonly value: unknown; readonly nullable: true };

type SourceApi<S> = S extends { readonly columns: infer C extends Readonly<Record<string, object>> }
  ? {
      /**
       * Selects rows. The options are the ones `db.<table>.find` takes.
       *
       * @param options - select, where, orderBy, and limit
       */
      find<const O extends object>(options?: O): FindResult<C, O>;
      /**
       * Groups rows. `orderBy` needs `limit`. A grouped view may omit `limit`.
       *
       * @param options - groupBy, select, where, orderBy, and limit
       */
      aggregate(options: object): {
        readonly op: "aggregate";
        readonly "~columns": readonly {
          readonly name: string;
          readonly value: unknown;
          readonly nullable: boolean;
        }[];
      };
    }
  : {
      /** Selects the view's columns. */
      find(options?: object): {
        readonly op: "find";
        readonly "~columns": S extends {
          readonly "~columns": infer Cols extends readonly ViewColumnPhantom[];
        }
          ? Cols
          : readonly [];
      };
      /** Groups the view's rows. */
      aggregate(options: object): {
        readonly op: "aggregate";
        readonly "~columns": readonly ViewColumnPhantom[];
      };
    };

type SqlResult<Cols> = {
  readonly op: "sql";
  readonly "~columns": {
    readonly [I in keyof Cols]: Cols[I] extends {
      readonly name: infer N extends string;
      readonly type: infer B;
    }
      ? {
          readonly name: N;
          readonly value: ColumnRowOf<B>;
          readonly nullable: B extends ColumnBuilder<any, infer F> ? F["nullable"] : true;
        }
      : never;
  };
};

/** `q` inside a view body. Keys are the declared tables and views, plus `sql`. */
export type ViewQuery<Sources extends readonly Named[]> = {
  readonly [K in Sources[number]["name"]]: SourceApi<
    Extract<Sources[number], { readonly name: K }>
  >;
} & {
  /**
   * A query the compiler does not print: a union, a CTE, `LATERAL`, or recursion.
   *
   * @param input - Output columns and the SQL text
   */
  sql<
    const Cols extends readonly {
      readonly name: string;
      readonly type: ColumnBuilder<any, ColumnFlags>;
    }[],
  >(input: {
    readonly columns: Cols;
    readonly query: string | SqlText;
  }): SqlResult<Cols>;
};

type ColumnsOf<Body> = Body extends {
  readonly "~columns": infer C extends readonly ViewColumnPhantom[];
}
  ? C
  : readonly ViewColumnPhantom[];

/**
 * Declares a view.
 *
 * Security defaults to invoker. `{ definer: reason }` is a security-barrier
 * definer view. The callback may read only `options.tables`.
 *
 * @typeParam N - View name
 * @typeParam Sources - Tables and views the body may read
 * @typeParam Body - What the callback returns
 * @param name - SQL name
 * @param options - Sources and view options
 * @param build - `q.<table>.find`, `.aggregate`, or `q.sql`
 * @returns A declaration for `schema({ views })`
 */
export function view<
  const N extends string,
  const Sources extends readonly Named[],
  const Body extends { readonly "~columns": readonly ViewColumnPhantom[] },
>(
  name: N,
  options: ViewOptions<Sources>,
  build: (q: ViewQuery<Sources>) => Body,
): ViewDeclaration<N, ColumnsOf<Body>> {
  return declare(name, options, build, "view") as ViewDeclaration<N, ColumnsOf<Body>>;
}

/**
 * Declares a materialized view.
 *
 * It is created `with no data`. `populate: "now"` refreshes it in the plan.
 * `refresh: "concurrently"` needs a unique index on plain columns.
 *
 * @typeParam N - View name
 * @typeParam Sources - Tables and views the body may read
 * @typeParam Body - What the callback returns
 * @param name - SQL name
 * @param options - Sources, indexes, and storage
 * @param build - `q.<table>.find`, `.aggregate`, or `q.sql`
 * @returns A declaration for `schema({ views })`
 */
export function materializedView<
  const N extends string,
  const Sources extends readonly Named[],
  const Body extends { readonly "~columns": readonly ViewColumnPhantom[] },
>(
  name: N,
  options: MaterializedViewOptions<Sources>,
  build: (q: ViewQuery<Sources>) => Body,
): MaterializedViewDeclaration<N, ColumnsOf<Body>> {
  return declare(name, options, build, "materialized") as MaterializedViewDeclaration<
    N,
    ColumnsOf<Body>
  >;
}

type Kind = "view" | "materialized";

type Box = {
  readonly name: string;
  readonly sources: readonly Named[];
  readonly kind: Kind;
  body: CapturedBody | undefined;
  compiled: CompiledView | undefined;
  casing: Names["casing"] | "missing";
  compiling: boolean;
  /** Set in `install`, before the first compile. A nested compile may pass it down. */
  tenant: ViewTenant | undefined;
};

function declare<const Sources extends readonly Named[]>(
  name: string,
  options: ViewOptions<Sources> | MaterializedViewOptions<Sources>,
  build: (q: ViewQuery<Sources>) => unknown,
  kind: Kind,
): object {
  if (name.length === 0) fail("OKM1020", "A view needs a name.");
  const sources = options.tables;
  if (!Array.isArray(sources)) {
    fail("OKM1020", `View ${name} needs tables.`);
  }
  const security = readSecurity(name, options as ViewOptions<Sources>);
  if (kind === "materialized") {
    const mat = options as MaterializedViewOptions<Sources>;
    if (mat.refresh === "concurrently" && mat.indexes === undefined) {
      throw new OkmError(
        "OKM1822",
        `Materialized view ${name} cannot refresh concurrently without a plain unique index.`,
        { fix: { summary: "Add a unique index on plain columns, or drop refresh." } },
      );
    }
  }
  const box: Box = {
    name,
    sources,
    kind,
    body: undefined,
    compiled: undefined,
    casing: "missing",
    compiling: false,
    tenant: undefined,
  };
  const render = (names: Names, tenant?: ViewTenant): CompiledView => {
    if (box.compiling) cycle([...renderStack, name]);
    if (box.compiled !== undefined && box.casing === names.casing) return box.compiled;
    const active = box.tenant ?? tenant;
    box.compiling = true;
    renderStack.push(name);
    try {
      box.body ??= capture(name, sources, build as (q: ViewQuery<readonly Named[]>) => unknown);
      box.compiled = compileView(
        name,
        box.body,
        sources,
        names,
        (source) => {
          const nested = source as {
            readonly render?: (names: Names, tenant?: ViewTenant) => CompiledView;
          };
          if (nested.render === undefined) {
            fail(
              "OKM1120",
              `View ${name} reads ${sourceName(source)}, which is not a table or a view.`,
            );
          }
          return nested.render(names, active);
        },
        active,
      );
      box.casing = names.casing;
      return box.compiled;
    } finally {
      box.compiling = false;
      renderStack.pop();
    }
  };
  const client = viewClient(
    name,
    () =>
      render(lastNames(box)).columns.map((column) => ({
        name: column.name,
        type: column.dataType,
        source: column.field,
        ...(column.nullable ? { nullable: true as const } : {}),
        ...(column.strict ? { strict: true as const } : {}),
        ...(column.encode !== undefined ? { encode: column.encode } : {}),
        ...(column.decode !== undefined ? { decode: column.decode } : {}),
      })),
    () => render(lastNames(box)).query,
    options.tenancy,
    refreshMode(options as { readonly refresh?: unknown }, kind),
  );
  const declaration = {
    name,
    "~kind": kind === "materialized" ? ("materialized" as const) : ("view" as const),
    render,
    install(
      model: Parameters<ViewInstall>[0],
      tenancy: Parameters<ViewInstall>[1],
      tables: Parameters<ViewInstall>[2],
      names: Parameters<ViewInstall>[3],
      scoped: Parameters<ViewInstall>[4],
    ) {
      box.tenant = viewTenant(tenancy);
      rememberNames(box, names);
      client.install(model, tenancy, tables, names, scoped);
    },
    sources,
    hook: client.hook,
    contribute(
      peers: unknown,
      built: readonly CatalogObject[],
      names: Names,
    ): readonly CatalogObject[] {
      rememberNames(box, names);
      assertCycle(peers);
      if (typeof built === "object" && built !== null) beginGrantBatch(built);
      rememberGrants(
        kind === "materialized" ? "materializedView" : "view",
        options.schema ?? "public",
        name,
        options.grants,
      );
      const compiled = render(names);
      const namespace = staticNamespace(options.schema ?? "public");
      const provenance: Provenance = { origin: "file", name };
      const dependencies = dependencyEdges(name, sources, built, names, namespace);
      const columnComments = options.comments;
      const columns = compiled.columns.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        ...(columnComments?.[column.name] !== undefined
          ? { comment: columnComments[column.name] }
          : {}),
      }));
      const query = compiled.query;
      if (kind === "view") {
        return [
          viewObject({
            namespace,
            name,
            columns,
            query,
            provenance,
            dependencies,
            ...(security.invoker ? { securityInvoker: true as const } : {}),
            ...(security.barrier ? { securityBarrier: true as const } : {}),
            ...("checkOption" in options && options.checkOption !== undefined
              ? { checkOption: options.checkOption }
              : {}),
            ...(options.comment !== undefined ? { comment: options.comment } : {}),
          }),
        ];
      }
      const mat = options as MaterializedViewOptions<readonly Named[]>;
      const indexes = indexCalls(mat.indexes, compiled);
      assertPlainUnique(name, mat.refresh, indexes);
      const storage = storagePairs(mat.with);
      const parent = { namespace, name };
      return [
        materializedViewObject({
          namespace,
          name,
          columns,
          query,
          provenance,
          dependencies,
          ...(mat.refresh === "concurrently" ? { refresh: "concurrently" as const } : {}),
          ...(mat.populate === "later" ? { populate: "later" as const } : {}),
          ...(mat.using !== undefined && mat.using !== "heap" ? { using: mat.using } : {}),
          ...(storage.length > 0 ? { storage } : {}),
          ...(mat.tablespace !== undefined ? { tablespace: mat.tablespace } : {}),
          ...(options.comment !== undefined ? { comment: options.comment } : {}),
        }),
        ...indexes.map((index) =>
          materializedViewIndex({
            parent,
            ...(index.sqlName !== undefined ? { name: index.sqlName } : {}),
            columns: index.columns.map((column) => sqlColumn(column, compiled)),
            unique: index.isUnique,
            ...(index.expression !== undefined ? { expression: index.expression } : {}),
            ...(index.predicate !== undefined ? { predicate: index.predicate } : {}),
            ...(index.method !== undefined ? { method: index.method } : {}),
            ...(index.included !== undefined ? { include: index.included } : {}),
            ...(index.elements !== undefined ? { elements: index.elements } : {}),
            ...(index.storage !== undefined ? { storage: index.storage } : {}),
            ...(index.nullsNotDistinct === true ? { nullsNotDistinct: true } : {}),
            ...(index.commentText !== undefined ? { comment: index.commentText } : {}),
            provenance,
          }),
        ),
      ];
    },
  };
  return declaration;
}

const namesSeen = new WeakMap<Box, Names>();
const renderStack: string[] = [];

function rememberNames(box: Box, names: Names): void {
  namesSeen.set(box, names);
}

function lastNames(box: Box): Names {
  return (
    namesSeen.get(box) ?? {
      casing: undefined,
      name: (key) => key,
      table: (item) => item.name,
      column: (_item, field) => field,
    }
  );
}

/**
 * The tenant column the compiler should see.
 *
 * @param tenancy - Column tenancy from `schema()`, when the schema set it
 * @returns The key and its column, or `undefined` when the schema has no tenancy
 */
function viewTenant(tenancy: Parameters<ViewInstall>[1]): ViewTenant | undefined {
  if (tenancy === undefined) return undefined;
  return {
    key: tenancy.key,
    column: () => tenancy.column(),
    isPath: (table: string) => tenancy.isPath?.(table) === true,
  };
}

function queryText(name: string, query: string | SqlText): string {
  if (typeof query === "string") return query;
  if (typeof query.text === "string") return query.text;
  fail("OKM1120", `View ${name} q.sql query must be a string or sql\`...\`.`);
}

function capture(
  name: string,
  sources: readonly Named[],
  build: (q: ViewQuery<readonly Named[]>) => unknown,
): CapturedBody {
  const q = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "sql") {
          return (input: {
            readonly columns: readonly { readonly name: string; readonly type: object }[];
            readonly query: string | SqlText;
          }) => ({
            op: "sql" as const,
            columns: input.columns,
            query: queryText(name, input.query),
          });
        }
        if (typeof key !== "string") fail("OKM1120", `View ${name} cannot read that key.`);
        const source = sources.find((item) => item.name === key);
        if (source === undefined) {
          throw new OkmError("OKM1120", `View ${name} reads ${key}, which is not in tables.`, {
            fix: { summary: "Add it to tables, or remove the read." },
          });
        }
        return {
          find: (options?: Readonly<Record<string, unknown>>) => ({
            op: "find" as const,
            source,
            options: options ?? {},
          }),
          aggregate: (options?: Readonly<Record<string, unknown>>) => ({
            op: "aggregate" as const,
            source,
            options: options ?? {},
          }),
        };
      },
    },
  ) as ViewQuery<readonly Named[]>;
  const body = build(q) as CapturedBody | undefined;
  if (body === undefined || (body.op !== "find" && body.op !== "aggregate" && body.op !== "sql")) {
    throw new OkmError(
      "OKM1121",
      `View ${name} must return q.<table>.find(), q.<table>.aggregate(), or q.sql().`,
      {
        fix: { summary: "Return one of those calls." },
      },
    );
  }
  return body;
}

function readSecurity(
  name: string,
  options: {
    readonly security?: "invoker" | { readonly definer: string };
    readonly barrier?: true;
  },
): { readonly invoker: boolean; readonly barrier: boolean } {
  const security = options.security;
  if (security === undefined || security === "invoker") {
    return { invoker: true, barrier: options.barrier === true };
  }
  if (typeof security === "object" && security !== null && typeof security.definer === "string") {
    if (security.definer.trim().length === 0) {
      fail("OKM1020", `View ${name} definer needs a reason.`);
    }
    return { invoker: false, barrier: true };
  }
  fail("OKM1020", `View ${name} security must be "invoker" or { definer: reason }.`);
}

function refreshMode(
  options: { readonly refresh?: unknown },
  kind: Kind,
): "plain" | "blocking" | "concurrently" {
  if (kind !== "materialized") return "plain";
  if (options.refresh === undefined) return "blocking";
  if (options.refresh === "concurrently") return "concurrently";
  if (typeof options.refresh === "object" && options.refresh !== null) {
    throw new OkmError(
      "OKM1120",
      "Scheduled refresh is not built in. Declare the pg_cron pack and follow the recipe in the views page.",
      {
        fix: { summary: 'Use refresh: "concurrently", or schedule the refresh outside the view.' },
      },
    );
  }
  throw new OkmError("OKM1120", 'refresh must be "concurrently".', {
    fix: { summary: 'Pass "concurrently", or omit refresh.' },
  });
}

function indexCalls(
  indexes: MaterializedViewOptions<readonly Named[]>["indexes"],
  compiled: CompiledView,
): readonly IndexCall[] {
  if (indexes === undefined) return [];
  if (typeof indexes === "function") {
    const columns: Record<string, { readonly name: string }> = {};
    for (const column of compiled.columns) columns[column.field] = { name: column.name };
    return indexes(columns);
  }
  return indexes;
}

function assertPlainUnique(name: string, refresh: unknown, indexes: readonly IndexCall[]): void {
  if (refresh !== "concurrently") return;
  const plain = indexes.some(
    (index) =>
      index.isUnique === true &&
      index.expression === undefined &&
      index.predicate === undefined &&
      index.columns.length > 0,
  );
  if (plain) return;
  throw new OkmError(
    "OKM1822",
    `Materialized view ${name} refreshes concurrently and has no unique index on plain columns.`,
    {
      fix: {
        summary:
          "Add a unique index with no expression and no predicate, or refresh without CONCURRENTLY.",
      },
    },
  );
}

function storagePairs(
  withOptions: Readonly<Record<string, string | number>> | undefined,
): readonly (readonly [string, string])[] {
  if (withOptions === undefined) return [];
  return Object.entries(withOptions).map(([key, value]) => [key, String(value)] as const);
}

function dependencyEdges(
  name: string,
  sources: readonly Named[],
  built: readonly CatalogObject[],
  names: Names,
  namespace: ReturnType<typeof staticNamespace>,
): readonly ObjectIdentity[] {
  const edges: ObjectIdentity[] = [];
  for (const source of sources) {
    if ("columns" in source && !("contribute" in source)) {
      const sql = names.table(source as Parameters<Names["table"]>[0]);
      const found = built.find((object) => object.kind === "table" && object.identity.name === sql);
      if (found === undefined) {
        fail("OKM1020", `View ${name} reads ${source.name}, which is not a table of this schema.`);
      }
      edges.push(found.identity);
      continue;
    }
    const kind = (source as { readonly "~kind"?: string })["~kind"];
    edges.push({
      kind: kind === "materialized" ? "materializedView" : "view",
      namespace,
      name: source.name,
    });
  }
  return edges;
}

function assertCycle(peers: unknown): void {
  if (!Array.isArray(peers)) return;
  const views = peers.filter((item): item is Box & Named => isBox(item));
  const byName = new Map(views.map((item) => [item.name, item]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (current: string): void => {
    const mark = state.get(current) ?? 0;
    if (mark === 1) cycle([...stack.slice(stack.indexOf(current)), current]);
    if (mark === 2) return;
    state.set(current, 1);
    stack.push(current);
    const box = byName.get(current);
    if (box !== undefined) {
      for (const source of box.sources) {
        if (byName.has(source.name)) visit(source.name);
      }
    }
    stack.pop();
    state.set(current, 2);
  };
  for (const item of views) visit(item.name);
}

function isBox(value: unknown): value is Box & Named {
  return (
    typeof value === "object" &&
    value !== null &&
    "sources" in value &&
    "name" in value &&
    Array.isArray((value as Box).sources)
  );
}

function cycle(names: readonly string[]): never {
  throw new OkmError("OKM1900", `Views ${names.join(" -> ")} depend on each other.`, {
    fix: { summary: "Remove a table from one view so the declarations do not form a cycle." },
  });
}

function sourceName(source: object): string {
  const name = (source as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : "that value";
}

function sqlColumn(column: string, compiled: CompiledView): string {
  return (
    compiled.columns.find((item) => item.field === column || item.name === column)?.name ?? column
  );
}

function fail(code: "OKM1020" | "OKM1120", message: string): never {
  throw new OkmError(code, message, { fix: { summary: message } });
}
