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
import type { SchemaHook } from "../model.js";
import type { SqlText } from "../table.js";
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
): ViewDeclaration<N, C> {
  const schema = options.schema ?? "public";
  const columns = options.columns.map((column) => ({ name: column.name, dataType: column.type }));
  const query = bodyText(options.query);
  const bound = viewClient(name, options.columns, query, options.tenancy, "plain");
  let securityInvoker = false;
  return {
    name,
    schema,
    "~kind": "view",
    install(model, tenancy, tables, casing, scoped) {
      bound.install(model, tenancy, tables, casing, scoped);
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
