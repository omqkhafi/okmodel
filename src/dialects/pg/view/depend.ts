/**
 * Column dependencies of a view, read from `pg_depend`.
 *
 * Postgres records them on the view's rewrite rule. The edge is column
 * granularity when that column is a catalog object.
 */

import { identityKey, staticNamespace } from "../../../contracts/catalog/identity.js";
import type { CatalogObject, Namespace, ObjectIdentity } from "../../../contracts/catalog/types.js";

/**
 * `pg_depend` rows for views and materialized views in one schema.
 *
 * `$1` is the concrete schema name. `refobjsubid > 0` keeps column edges.
 */
export const VIEW_DEPENDENCIES = `
  select v.relname as view, t.relname as table, a.attname as column
  from pg_depend d
  join pg_rewrite r on r.oid = d.objid and d.classid = 'pg_rewrite'::regclass
  join pg_class v on v.oid = r.ev_class
  join pg_class t on t.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
  join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
  join pg_namespace n on n.oid = v.relnamespace
  where n.nspname = $1
    and v.relkind in ('v', 'm')
    and d.refobjsubid > 0
    and v.oid <> t.oid
    and t.relkind in ('r', 'p', 'v', 'm')
`;

/**
 * Turns dependency rows into edges that exist in `objects`.
 *
 * A table column becomes a column edge. A view that is itself a catalog
 * object becomes an object edge. Anything else is omitted: the catalog
 * refuses an edge whose target is missing.
 *
 * @param rows - Rows from {@link VIEW_DEPENDENCIES}
 * @param namespace - Logical namespace stored on the edges
 * @param objects - Catalog the edges must point into
 * @returns Edges keyed by view name
 */
export function viewDependencyEdges(
  rows: readonly Readonly<Record<string, unknown>>[],
  namespace: Namespace,
  objects: readonly CatalogObject[],
): Map<string, ObjectIdentity[]> {
  const keys = new Set(objects.map((object) => identityKey(object.identity)));
  const byView = new Map<string, ObjectIdentity[]>();
  for (const row of rows) {
    const view = text(row.view);
    const table = text(row.table);
    const column = text(row.column);
    if (view.length === 0 || table.length === 0 || column.length === 0) continue;
    const columnEdge: ObjectIdentity = {
      kind: "column",
      parent: { namespace, name: table },
      name: column,
    };
    const columnKey = identityKey(columnEdge);
    let edge: ObjectIdentity = columnEdge;
    if (!keys.has(columnKey)) {
      const viewEdge = objectEdge(namespace, table, objects);
      if (viewEdge === undefined) continue;
      edge = viewEdge;
    }
    const list = byView.get(view) ?? [];
    list.push(edge);
    byView.set(view, list);
  }
  return byView;
}

function objectEdge(
  namespace: Namespace,
  name: string,
  objects: readonly CatalogObject[],
): ObjectIdentity | undefined {
  for (const object of objects) {
    if (object.kind !== "view" && object.kind !== "materializedView") continue;
    if (object.identity.name !== name) continue;
    if (object.identity.namespace.form !== "static" || namespace.form !== "static") continue;
    if (object.identity.namespace.name !== namespace.name) continue;
    return object.identity;
  }
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

/** Logical public namespace. Tests and the default schema use it. */
export const PUBLIC = staticNamespace("public");
