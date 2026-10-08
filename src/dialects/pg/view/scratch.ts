/**
 * Verifies declared views on a scratch schema.
 *
 * Domain and enum types from the catalog are created there, then the tables,
 * then the functions a view may call, then each view. `pg_get_viewdef`
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
import { createObjectSql, quoteIdent } from "../ddl.js";
import type { CatalogQuery } from "../introspect.js";
import { cellText, PUBLIC, VIEW_DEPENDENCIES, viewDependencyEdges } from "./depend.js";

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
  const previous = await runner.query(`select current_setting('search_path') as path`);
  const saved = cellText(previous[0]?.path);
  const path = await scratchSearchPath(runner, source);
  try {
    await runner.query(`select set_config('search_path', $1, false)`, [path]);
    await createObjects(runner, source, "type");
    for (const object of source.objects) {
      if (object.kind !== "table") continue;
      await runner.query(stubTable(object, source));
    }
    await createObjects(runner, source, "function");
    await createViews(runner, views);
    const shapes = await runner.query(VIEW_SHAPE, [SCRATCH]);
    const deps = await runner.query(VIEW_DEPENDENCIES, [SCRATCH]);
    const edges = viewDependencyEdges(deps, PUBLIC, source.objects);
    const byName = new Map(shapes.map((row) => [cellText(row.name), row]));
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
      const columns = readColumns(object, cellText(row.columns));
      const query = normaliseViewQuery(cellText(row.query));
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
    await runner
      .query(`select set_config('search_path', $1, false)`, [saved])
      .catch(() => undefined);
    await dropScratch(runner);
  }
}

async function scratchSearchPath(runner: CatalogQuery, source: Catalog): Promise<string> {
  const names = new Set<string>();
  for (const object of source.objects) {
    if (object.kind !== "column") continue;
    const bare = object.definition.dataType
      .split(".")
      .pop()
      ?.replace(/\(.*$/, "")
      .replace(/\[\]$/, "")
      .trim()
      .toLowerCase();
    if (bare !== undefined && bare.length > 0) names.add(bare);
  }
  const extra: string[] = [];
  if (names.size > 0) {
    const rows = await runner.query(
      `select distinct n.nspname as schema
       from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       where t.typname = any(string_to_array($1, E'\\x1f'))
         and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')`,
      [[...names].join("\u001f")],
    );
    for (const row of rows) {
      const schema = cellText(row.schema);
      if (schema.length > 0 && schema !== "public" && schema !== SCRATCH) extra.push(schema);
    }
  }
  extra.sort();
  return [SCRATCH, ...extra, "public"].map((name) => quoteIdent(name)).join(", ");
}

async function createObjects(
  runner: CatalogQuery,
  source: Catalog,
  kind: "type" | "function",
): Promise<void> {
  for (const object of source.objects) {
    if (object.kind !== kind) continue;
    const statement = createObjectSql(object, SCRATCH);
    if (statement !== undefined) await runner.query(statement);
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
  const views = rows.filter((row) => cellText(row.kind) === "v" || cellText(row.kind) === "m");
  for (let pass = 0; pass < Math.max(views.length, 1); pass += 1) {
    for (const row of views) {
      const kind = cellText(row.kind) === "m" ? "materialized view" : "view";
      try {
        await runner.query(
          `drop ${kind} if exists ${quoteIdent(SCRATCH)}.${quoteIdent(cellText(row.name))}`,
        );
      } catch {
        // A later view in this list may still be using it. The next pass retries.
      }
    }
  }
  for (const row of rows) {
    if (cellText(row.kind) !== "r") continue;
    await runner.query(
      `drop table if exists ${quoteIdent(SCRATCH)}.${quoteIdent(cellText(row.name))}`,
    );
  }
  await runner.query(`drop schema if exists ${quoteIdent(SCRATCH)} cascade`);
}
