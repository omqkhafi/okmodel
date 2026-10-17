/**
 * Verifies declared views on a scratch schema.
 *
 * Domain and enum types from the catalog are created there, then the tables,
 * then the functions a view may call, then each view. `pg_get_viewdef`
 * replaces the author query and `pg_depend` supplies column edges (D117).
 * A `BEGIN ATOMIC` body is replaced with the `pg_get_functiondef` block, so a
 * plan from the live catalog does not treat Postgres's reprint as a change
 * (D273). A name that appears once is that row. Overloads compare identity
 * arguments after typmods and aliases are folded, so two overloads do not
 * share a body. The scratch schema is dropped before this returns. Plans
 * never use it.
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
  FunctionObject,
  MaterializedViewObject,
  TableObject,
  ViewObject,
} from "../../../contracts/catalog/types.js";
import { createObjectSql, quoteIdent } from "../ddl.js";
import { atomicBody, type CatalogQuery } from "../introspect.js";
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
 * with the database is OKM1020. A `BEGIN ATOMIC` function body is the
 * server reprint, including an argument qualifier such as `by_id.n`.
 *
 * @param runner - Database connection. Statements share its session
 * @param source - Catalog whose views and atomic bodies are still author SQL
 * @returns A catalog whose views and atomic bodies carry the reprint
 */
export async function sealViews(runner: CatalogQuery, source: Catalog): Promise<Catalog> {
  const views = source.objects.filter(
    (object): object is ViewObject | MaterializedViewObject =>
      object.kind === "view" || object.kind === "materializedView",
  );
  const hasAtomic = source.objects.some(
    (object) => object.kind === "function" && object.definition.atomic === true,
  );
  if (views.length === 0 && !hasAtomic) return source;
  await dropScratch(runner);
  await runner.query(`create schema ${quoteIdent(SCRATCH)}`);
  const previous = await runner.query(`select current_setting('search_path') as path`);
  const saved = cellText(previous[0]?.path);
  const path = await scratchSearchPath(runner, source);
  try {
    await runner.query(`select set_config('search_path', $1, false)`, [path]);
    await createExtensions(runner, source);
    await createObjects(runner, source, "type");
    for (const object of source.objects) {
      if (object.kind !== "table") continue;
      await runner.query(stubTable(object, source));
    }
    await createObjects(runner, source, "function");
    const reprinted = await reprintAtomicBodies(runner, source);
    if (views.length === 0) return reprinted;
    await createViews(runner, views);
    const shapes = await runner.query(VIEW_SHAPE, [SCRATCH]);
    const deps = await runner.query(VIEW_DEPENDENCIES, [SCRATCH]);
    const edges = viewDependencyEdges(deps, PUBLIC, source.objects);
    const byName = new Map(shapes.map((row) => [cellText(row.name), row]));
    const next = reprinted.objects.map((object) => {
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
          ...(object.definition.securityInvoker === true ? { securityInvoker: true as const } : {}),
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

/**
 * Creates catalog extensions before stub tables need their types.
 *
 * Extensions are database-wide, so the seal path uses `IF NOT EXISTS` and
 * does not drop them with the scratch schema.
 *
 * @param runner - Database connection
 * @param source - Catalog that may declare extensions such as `citext`
 */
async function createExtensions(runner: CatalogQuery, source: Catalog): Promise<void> {
  for (const object of source.objects) {
    if (object.kind !== "extension") continue;
    const statement = createObjectSql(object, SCRATCH);
    if (statement === undefined) continue;
    await runner.query(statement.replace(/^create extension\b/i, "create extension if not exists"));
  }
}

const FUNCTION_DEFS = `
  select p.proname as name,
    pg_get_function_identity_arguments(p.oid) as args,
    pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = $1 and p.prokind = 'f'
`;

/** One function Postgres created in the scratch schema. */
type PrintedFunction = {
  readonly name: string;
  readonly args: readonly string[];
  readonly body: string;
};

/**
 * Replaces each atomic body with the block Postgres prints.
 *
 * A name that appears on one scratch row is that row. Argument text is
 * compared only when two or more rows share the name. A plpgsql body is left
 * as written. Postgres qualifies an argument as `function.argument` when the
 * body names a table. That qualifier is part of the reprint, not a different
 * function.
 *
 * @param runner - Database connection
 * @param source - Catalog whose functions were just created in the scratch schema
 * @returns `source` when no atomic body changed
 */
async function reprintAtomicBodies(runner: CatalogQuery, source: Catalog): Promise<Catalog> {
  const created = source.objects.filter(
    (object): object is FunctionObject => object.kind === "function",
  );
  if (!created.some((object) => object.definition.atomic === true)) return source;
  const rows = await runner.query(FUNCTION_DEFS, [SCRATCH]);
  const printed: PrintedFunction[] = rows.map((row) => ({
    name: cellText(row.name),
    args: splitIdentityArguments(cellText(row.args)),
    body: atomicBody(cellText(row.definition)),
  }));
  const byName = new Map<string, number[]>();
  for (let index = 0; index < printed.length; index += 1) {
    const name = printed[index]?.name ?? "";
    const list = byName.get(name);
    if (list === undefined) byName.set(name, [index]);
    else list.push(index);
  }
  const used = new Set<number>();
  let changed = false;
  const objects = source.objects.map((object) => {
    if (object.kind !== "function" || object.definition.atomic !== true) return object;
    const named = byName.get(object.identity.name) ?? [];
    const index = chooseReprint(object, printed, named, used);
    used.add(index);
    const body = printed[index]?.body;
    if (body === undefined || body === object.definition.body) return object;
    changed = true;
    return { ...object, definition: { ...object.definition, body } };
  });
  return changed ? catalog(objects) : source;
}

/**
 * Picks the scratch row for one atomic function.
 *
 * One row for the name is taken as it is. Overloads have to match normalised
 * identity arguments. A miss names the catalog arguments and every scratch
 * list for that name.
 *
 * @param object - Catalog function
 * @param printed - Functions created in the scratch schema
 * @param named - Indexes of rows with this function's name
 * @param used - Rows already given to another overload
 * @returns Index into `printed`
 */
function chooseReprint(
  object: FunctionObject,
  printed: readonly PrintedFunction[],
  named: readonly number[],
  used: ReadonlySet<number>,
): number {
  const only = named[0];
  if (named.length === 1 && only !== undefined && !used.has(only)) return only;
  const matches = named.filter((index) => {
    const row = printed[index];
    return row !== undefined && !used.has(index) && identityMatches(object, row.args);
  });
  const index = matches[0];
  if (named.length > 1 && matches.length === 1 && index !== undefined) return index;
  throw reprintMiss(
    object,
    named.map((index) => printed[index]).filter((row) => row !== undefined),
  );
}

/**
 * OKM1020 when an overload cannot be paired with one scratch row.
 *
 * @param object - Catalog function
 * @param rows - Scratch rows that share its name
 * @returns The error, with both argument lists
 */
function reprintMiss(object: FunctionObject, rows: readonly PrintedFunction[]): OkmError {
  const catalog = object.identity.argTypes.join(", ");
  const scratch =
    rows.length === 0
      ? "(none)"
      : rows
          .map((row) => (row.args.length === 0 ? "(no arguments)" : row.args.join(", ")))
          .join("; ");
  return new OkmError(
    "OKM1020",
    `Function ${object.identity.name}(${catalog}) was not created in the scratch schema. Catalog arguments: ${catalog}. Scratch arguments: ${scratch}.`,
    { fix: { summary: "The function body has to run against the tables in this schema." } },
  );
}

/**
 * Whether one scratch argument list is this overload.
 *
 * Compared only when the name is shared. Typmods, array suffixes, and
 * abbreviations are folded first. `pg_get_function_identity_arguments`
 * prints `name type`.
 *
 * @param object - Catalog function
 * @param args - Identity arguments, one entry per input
 * @returns `true` when every argument type matches
 */
function identityMatches(object: FunctionObject, args: readonly string[]): boolean {
  if (args.length !== object.identity.argTypes.length) return false;
  return args.every((printed, index) =>
    printedHasType(object.identity.argTypes[index] ?? "", printed),
  );
}

/**
 * Splits `pg_get_function_identity_arguments` on commas outside parentheses.
 *
 * @param args - Identity argument list, or empty
 * @returns One `name type` entry per input argument
 */
function splitIdentityArguments(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed.length === 0) return [];
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of trimmed) {
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

/**
 * Abbreviations an author may write, and the type Postgres prints.
 */
const ARG_TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: "integer",
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  bool: "boolean",
  decimal: "numeric",
  char: "character",
  float4: "real",
  float8: "double precision",
  varchar: "character varying",
  time: "time without time zone",
  timetz: "time with time zone",
  timestamp: "timestamp without time zone",
  timestamptz: "timestamp with time zone",
};

/**
 * Whether one identity argument is this catalog type.
 *
 * The printed form may lead with the argument name (`n integer`) and may
 * schema-qualify the type (`okm_view_seal.task_status`).
 *
 * @param author - Type stored on the function identity
 * @param printed - One identity argument from Postgres
 * @returns `true` when the types are the same
 */
function printedHasType(author: string, printed: string): boolean {
  const want = canonicalArgType(author);
  const got = printed.trim().replaceAll(/\s+/g, " ").toLowerCase();
  if (canonicalArgType(got) === want) return true;
  const space = got.indexOf(" ");
  if (space < 0) return false;
  const name = got.slice(0, space);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return false;
  return canonicalArgType(got.slice(space + 1)) === want;
}

/**
 * Folds a type name for comparison.
 *
 * @param type - Author type or a printed identity argument
 * @returns Lowercase type with one space between words and no schema
 */
function canonicalArgType(type: string): string {
  let compact = type.trim().replaceAll(/\s+/g, " ").toLowerCase();
  const dot = compact.lastIndexOf(".");
  if (dot >= 0) compact = compact.slice(dot + 1);
  compact = stripTypmods(compact).replaceAll(/\s+/g, " ").trim();
  let arrays = 0;
  while (compact.endsWith("[]")) {
    arrays += 1;
    compact = compact.slice(0, -2).trim();
  }
  const aliased = ARG_TYPE_ALIASES[compact] ?? compact;
  return arrays === 0 ? aliased : `${aliased}${"[]".repeat(arrays)}`;
}

/**
 * Drops precision and scale. Identity arguments do not carry them.
 *
 * @param type - Type text, already lowercased
 * @returns The same text with every parenthetical removed
 */
function stripTypmods(type: string): string {
  let out = "";
  let depth = 0;
  for (const char of type) {
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
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
  const routines = await runner.query(
    `
    select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1
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
  for (const row of routines) {
    const args = cellText(row.args);
    await runner.query(
      `drop function if exists ${quoteIdent(SCRATCH)}.${quoteIdent(cellText(row.name))}(${args})`,
    );
  }
  for (const row of rows) {
    if (cellText(row.kind) !== "r") continue;
    await runner.query(
      `drop table if exists ${quoteIdent(SCRATCH)}.${quoteIdent(cellText(row.name))}`,
    );
  }
  await runner.query(`drop schema if exists ${quoteIdent(SCRATCH)} cascade`);
}
