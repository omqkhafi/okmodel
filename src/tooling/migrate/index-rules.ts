/**
 * Index shape checks that stay out of `schema()`.
 *
 * Unique, include, ordering, and a name past 63 bytes are refused here.
 * A predicate or expression is judged by {@link checkScratch}: Postgres
 * accepts an immutable expression and refuses `now()`, `current_date`,
 * `random()`, and a function declared stable or volatile.
 */

import { OkmError } from "../../contracts/error.js";
import { assertCommentText, assertIdentifier } from "../../contracts/catalog/identifier.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  FunctionObject,
  IndexObject,
} from "../../contracts/catalog/types.js";
import { createIndexSql, qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import { checkScratch } from "./scratch-check.js";

const INCLUDE_METHODS = new Set(["btree", "gist", "spgist"]);

/**
 * Refuses an index shape Postgres will not build.
 *
 * @param catalog - Schema catalog about to be planned
 * @throws OkmError OKM1903 for a method restriction, OKM1122 for a long name or a comment
 */
export function assertIndexRules(catalog: Catalog): void {
  for (const object of catalog.objects) {
    if (object.comment !== undefined) {
      assertCommentText(object.comment, `${object.kind} ${named(object)} comment`);
    }
    if (
      (object.kind === "view" || object.kind === "materializedView") &&
      object.definition.columns.some((column) => column.comment !== undefined)
    ) {
      for (const column of object.definition.columns) {
        if (column.comment !== undefined) {
          assertCommentText(column.comment, `${object.identity.name}.${column.name} comment`);
        }
      }
    }
    if (object.kind !== "index") continue;
    assertIdentifier(object.identity.name, "index name");
    const method = object.definition.method ?? methodOf(object.definition.expression) ?? "btree";
    const name = object.identity.name;
    if (object.definition.unique === true && method !== "btree") {
      throw new OkmError(
        "OKM1903",
        `Index ${name} is unique on ${method}. Unique indexes are btree.`,
        { fix: { summary: "Remove .unique(), or use btree." } },
      );
    }
    if (object.definition.include !== undefined && !INCLUDE_METHODS.has(method)) {
      throw new OkmError(
        "OKM1903",
        `Index ${name} uses include on ${method}. Include is btree, gist, or spgist, and only plain columns.`,
        { fix: { summary: "Remove .include(), or use btree, gist, or spgist." } },
      );
    }
    const ordered = object.definition.elements?.some(
      (element) => element.order !== undefined || element.nulls !== undefined,
    );
    if (ordered === true && method !== "btree") {
      throw new OkmError(
        "OKM1903",
        `Index ${name} sets descending or nulls order on ${method}. Those options are btree.`,
        { fix: { summary: "Remove .desc() or the nulls order, or use btree." } },
      );
    }
  }
}

/** Reads `using gin` from an extension tail. A structured method wins over this. */
function methodOf(expression: string | undefined): string | undefined {
  return /^using\s+([a-z_][a-z0-9_]*)/i.exec(expression ?? "")?.[1]?.toLowerCase();
}

/**
 * Asks Postgres whether each predicate and expression may be indexed.
 *
 * A `using` tail is an access method, not an expression, so it is skipped.
 * Functions declared in the catalog are created first so a stable or volatile
 * `fn()` is the server's refusal.
 *
 * @param catalog - Schema catalog `okm check` loaded
 * @throws OkmError OKM1848 when Postgres refuses the statement
 */
export async function assertIndexImmutable(catalog: Catalog): Promise<void> {
  const functions = catalog.objects.filter(
    (object): object is FunctionObject => object.kind === "function",
  );
  for (const object of catalog.objects) {
    if (object.kind !== "index") continue;
    if (!scratchIndex(object)) continue;
    const statements = [
      ...functions.filter((fn) => mentioned(object, fn.identity.name)).map(functionSql),
      `create table ${qualify("public", "okm_scratch")} (${tableColumns(catalog, object)})`,
      createIndexSql(renamed(object), "public"),
    ];
    const verdict = await checkScratch(statements);
    if (!verdict.ok) throw verdict.error;
  }
}

function scratchIndex(object: IndexObject): boolean {
  const expression = object.definition.expression;
  if (expression?.startsWith("using ") === true) return false;
  return expression !== undefined || object.definition.predicate !== undefined;
}

function mentioned(object: IndexObject, name: string): boolean {
  const text = `${object.definition.expression ?? ""} ${object.definition.predicate ?? ""}`;
  return text.includes(name);
}

function tableColumns(catalog: Catalog, index: IndexObject): string {
  const table = index.identity.parent.name;
  const columns = catalog.objects.filter(
    (object): object is ColumnObject =>
      object.kind === "column" && object.identity.parent.name === table,
  );
  const wanted = new Set<string>([
    ...index.definition.columns,
    ...(index.definition.include ?? []),
    ...(index.definition.elements ?? []).flatMap((element) =>
      element.column === undefined ? [] : [element.column],
    ),
  ]);
  const text = `${index.definition.expression ?? ""}\n${index.definition.predicate ?? ""}`;
  for (const column of columns) {
    if (mentions(text, column.identity.name)) wanted.add(column.identity.name);
  }
  const used = columns.filter((column) => wanted.has(column.identity.name));
  const picked = used.length > 0 ? used : columns.slice(0, 1);
  if (picked.length === 0) return "id integer";
  return picked
    .map(
      (column) =>
        `${quoteIdent(column.identity.name)} ${scratchType(catalog, column.definition.dataType)}`,
    )
    .join(", ");
}

/** A catalog enum or domain is not created in the scratch database. Text stands in. */
function scratchType(catalog: Catalog, dataType: string): string {
  const array = dataType.endsWith("[]");
  const base = array ? dataType.slice(0, -2) : dataType;
  const owned = catalog.objects.some(
    (object) => object.kind === "type" && object.identity.name === base,
  );
  if (!owned) return dataType;
  return array ? "text[]" : "text";
}

function mentions(text: string, name: string): boolean {
  const quoted = `"${name.replaceAll('"', '""')}"`;
  if (text.includes(quoted)) return true;
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text.charAt(at - 1);
    const after = text.charAt(at + name.length);
    if (!identChar(before) && !identChar(after)) return true;
    from = at + name.length;
  }
  return false;
}

function identChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function named(object: CatalogObject): string {
  return "name" in object.identity ? object.identity.name : object.kind;
}

function renamed(object: IndexObject): IndexObject {
  return {
    ...object,
    identity: {
      ...object.identity,
      name: "okm_scratch_idx",
      parent: { ...object.identity.parent, name: "okm_scratch" },
    },
  };
}

function functionSql(fn: FunctionObject): string {
  const args = fn.definition.arguments
    .map((arg) => `${quoteIdent(arg.name)} ${arg.type}`)
    .join(", ");
  const body = fn.definition.body.replaceAll("'", "''");
  return `create function ${qualify("public", fn.identity.name)}(${args}) returns ${fn.definition.returns} language ${fn.definition.language} ${fn.definition.volatility} as '${body}'`;
}
