/**
 * Verifies declared views on a scratch schema.
 *
 * Tables from the catalog are created there, then each view. `pg_get_viewdef`
 * replaces the author query and `pg_depend` supplies column edges (D117).
 * The scratch schema is dropped before this returns. Plans never use it.
 */

import { catalog } from "../../../contracts/catalog/build.js";
import { OkmError } from "../../../contracts/error.js";
import {
  materializedViewObject,
  normaliseViewQuery,
  viewObject,
} from "../../../contracts/catalog/view.js";
import type {
  Catalog,
  ColumnObject,
  MaterializedViewObject,
  TableObject,
  ViewObject,
} from "../../../contracts/catalog/types.js";
import { quoteIdent } from "../ddl.js";
import type { CatalogQuery } from "../introspect.js";
import { PUBLIC, VIEW_DEPENDENCIES, viewDependencyEdges } from "./depend.js";

const SCRATCH = "okm_view_seal";

const VIEW_SHAPE = `
  select c.relname as name, c.relkind as kind, pg_get_viewdef(c.oid, true) as query,
    (
      select coalesce(string_agg(
        a.attname || '|' || format_type(a.atttypid, a.atttypmod),
        E'\\n' order by a.attnum
      ), '')
      from pg_attribute a
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    ) as columns
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relkind in ('v', 'm')
`;

/**
 * Reads dependencies and reprints for every view in `source`.
 *
 * The returned catalog matches what introspection prints for those views
 * when the same query is applied. A declared column list that disagrees
 * with the database is OKM1020.
 *
 * @param runner - Database connection. Statements share its session
 * @param source - Catalog whose views are still author SQL
 * @returns A catalog whose views carry the reprint and `pg_depend` edges
 */
export async function sealViews(runner: CatalogQuery, source: Catalog): Promise<Catalog> {
  const views = source.objects.filter(
    (object): object is ViewObject | MaterializedViewObject =>
      object.kind === "view" || object.kind === "materializedView",
  );
  if (views.length === 0) return source;
  await dropScratch(runner);
  await runner.query(`create schema ${quoteIdent(SCRATCH)}`);
  try {
    await runner.query(`set search_path to ${quoteIdent(SCRATCH)}`);
    for (const object of source.objects) {
      if (object.kind !== "table") continue;
      await runner.query(stubTable(object, source));
    }
    await createViews(runner, views);
    const shapes = await runner.query(VIEW_SHAPE, [SCRATCH]);
    const deps = await runner.query(VIEW_DEPENDENCIES, [SCRATCH]);
    const edges = viewDependencyEdges(deps, PUBLIC, source.objects);
    const byName = new Map(shapes.map((row) => [text(row.name), row]));
    const next = source.objects.map((object) => {
      if (object.kind !== "view" && object.kind !== "materializedView") return object;
      const row = byName.get(object.identity.name);
      if (row === undefined) {
        throw new OkmError(
          "OKM1020",
          `View ${object.identity.name} was not created in the scratch schema.`,
          {
            fix: { summary: "The query has to run against the tables in this schema." },
          },
        );
      }
      const columns = readColumns(object, text(row.columns));
      const query = normaliseViewQuery(text(row.query));
      const dependencies = edges.get(object.identity.name) ?? [];
      if (object.kind === "view") {
        return viewObject({
          namespace: object.identity.namespace,
          name: object.identity.name,
          columns,
          query,
          owner: object.owner,
          provenance: object.provenance,
          dependencies,
        });
      }
      return materializedViewObject({
        namespace: object.identity.namespace,
        name: object.identity.name,
        columns,
        query,
        owner: object.owner,
        provenance: object.provenance,
        dependencies,
        ...(object.definition.refresh !== undefined ? { refresh: object.definition.refresh } : {}),
      });
    });
    return catalog(next);
  } finally {
    await runner.query("set search_path to public");
    await dropScratch(runner);
  }
}

async function createViews(
  runner: CatalogQuery,
  views: readonly (ViewObject | MaterializedViewObject)[],
): Promise<void> {
  const pending = [...views];
  let last = "";
  for (let pass = 0; pass < views.length && pending.length > 0; pass += 1) {
    const failed: (ViewObject | MaterializedViewObject)[] = [];
    let created = 0;
    for (const object of pending) {
      const sql =
        object.kind === "materializedView"
          ? `create materialized view ${quoteIdent(object.identity.name)} as ${object.definition.query} with no data`
          : `create view ${quoteIdent(object.identity.name)} as ${object.definition.query}`;
      try {
        await runner.query(sql);
        created += 1;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        failed.push(object);
      }
    }
    if (created === 0) {
      throw new OkmError(
        "OKM1020",
        `View ${failed[0]?.identity.name ?? ""} could not be created. ${last}`,
        {
          fix: { summary: "The query has to run against the tables in this schema." },
        },
      );
    }
    pending.length = 0;
    pending.push(...failed);
  }
}

function stubTable(object: TableObject, source: Catalog): string {
  const columns = source.objects.filter(
    (item): item is ColumnObject =>
      item.kind === "column" && item.identity.parent.name === object.identity.name,
  );
  const lines = columns.map(
    (column) => `${quoteIdent(column.identity.name)} ${column.definition.dataType}`,
  );
  return `create table ${quoteIdent(object.identity.name)} (${lines.join(", ")})`;
}

function readColumns(
  object: ViewObject | MaterializedViewObject,
  printed: string,
): ViewObject["definition"]["columns"] {
  const live = printed.length === 0 ? [] : printed.split("\n");
  const declared = object.definition.columns;
  if (live.length !== declared.length) {
    throw mismatch(object.identity.name, declared.map((column) => column.name).join(", "), printed);
  }
  return declared.map((column, index) => {
    const line = live[index] ?? "";
    const splitAt = line.indexOf("|");
    const name = splitAt < 0 ? line : line.slice(0, splitAt);
    const type = splitAt < 0 ? "" : line.slice(splitAt + 1);
    if (name !== column.name || type !== column.dataType) {
      throw mismatch(object.identity.name, `${column.name}:${column.dataType}`, live[index] ?? "");
    }
    return column;
  });
}

function mismatch(view: string, declared: string, live: string): OkmError {
  return new OkmError(
    "OKM1020",
    `View ${view} declares ${declared} and the database has ${live}.`,
    { fix: { summary: "Declare the columns the query returns, in that order, with those types." } },
  );
}

async function dropScratch(runner: CatalogQuery): Promise<void> {
  const present = await runner.query(`select 1 as ok from pg_namespace where nspname = $1`, [
    SCRATCH,
  ]);
  if (present.length === 0) return;
  const rows = await runner.query(
    `
    select c.relname as name, c.relkind as kind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relkind in ('v', 'm', 'r')
  `,
    [SCRATCH],
  );
  const views = rows.filter((row) => text(row.kind) === "v" || text(row.kind) === "m");
  for (let pass = 0; pass < Math.max(views.length, 1); pass += 1) {
    for (const row of views) {
      const kind = text(row.kind) === "m" ? "materialized view" : "view";
      try {
        await runner.query(
          `drop ${kind} if exists ${quoteIdent(SCRATCH)}.${quoteIdent(text(row.name))}`,
        );
      } catch {
        // A later view in this list may still be using it. The next pass retries.
      }
    }
  }
  for (const row of rows) {
    if (text(row.kind) !== "r") continue;
    await runner.query(`drop table if exists ${quoteIdent(SCRATCH)}.${quoteIdent(text(row.name))}`);
  }
  await runner.query(`drop schema if exists ${quoteIdent(SCRATCH)}`);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}
