/**
 * `search` on `find` and `count`.
 *
 * Loaded on the first call that passes `search`. It rewrites the call into
 * `matches` and, when `find` has no `orderBy`, `relevance` plus the primary
 * key. The SQL compiler is the one those helpers already use.
 */

import { throwNamed } from "../contracts/error.js";
import type { ColumnModel, QuerySchema } from "../dialects/pg/model.js";
import { assertNoControl } from "../dialects/pg/operator-fit.js";
import {
  isOperator,
  operatorName,
  operatorValue,
  tag,
  type SearchMatch,
} from "../dialects/pg/operators.js";
import { searchValue, type SearchOptions } from "../dialects/pg/ops/search-query.js";
import {
  fail,
  indexes,
  isRecord,
  list,
  refuseHidden,
  type Indexed,
  type ReadCall,
} from "./plan.js";

const MATCHES: readonly SearchMatch[] = ["natural", "all-words", "phrase", "advanced"];

const SEARCH_KEYS = ["for", "in", "match", "language"] as const;

/**
 * Rewrites `search` into `matches` and `relevance`.
 *
 * `count` keeps the caller's order, which it does not emit. An explicit
 * `orderBy` on `find` replaces the automatic ranking.
 *
 * @param schema - Connected schema
 * @param call - The read, with `search` set
 * @returns The same read, without `search`
 */
export function applyTextSearch(schema: QuerySchema, call: ReadCall): ReadCall {
  const table = indexes(schema).get(call.table);
  if (table === undefined) fail("OKM1120", `Table ${call.table} is not in the schema.`);
  const spec = parseSearch(table, call.search);
  const options = { match: spec.match, language: spec.language };
  const where = withMatch(call.where, spec.column.field, spec.text, options);
  const orderBy =
    call.op === "find" && call.orderBy === undefined
      ? ranked(table, spec.column.field, spec.text, options)
      : call.orderBy;
  const { search: dropped, ...rest } = call;
  void dropped;
  return {
    ...rest,
    where,
    ...(orderBy !== undefined ? { orderBy } : {}),
  };
}

type Spec = {
  readonly text: string;
  readonly column: ColumnModel;
  readonly match: SearchMatch;
  readonly language: string | undefined;
};

function parseSearch(table: Indexed, search: unknown): Spec {
  if (typeof search === "string") {
    return { text: textOf(search), column: columnFor(table, undefined), ...natural() };
  }
  if (!isRecord(search)) {
    fail(
      "OKM1120",
      "search needs the text to look for, or { for, in, match, language }.",
      "Pass a string, or search: { for, in }.",
    );
  }
  for (const key of Object.keys(search)) {
    if (SEARCH_KEYS.includes(key as (typeof SEARCH_KEYS)[number])) continue;
    fail(
      "OKM1120",
      `search does not take ${key}. Accepted: for, in, match, language.`,
      "Pass for, in, match, and language.",
    );
  }
  if (typeof search.for !== "string") {
    fail("OKM1120", "search.for needs text to look for.", "Set for to the text you want to find.");
  }
  const named = search.in;
  if (named !== undefined && typeof named !== "string") {
    fail("OKM1120", "search.in names the column to search.", "Set in to a column name.");
  }
  return {
    text: textOf(search.for),
    column: columnFor(table, named),
    match: matchOf(search.match),
    language: languageOf(search.language),
  };
}

function natural(): { readonly match: SearchMatch; readonly language: undefined } {
  return { match: "natural", language: undefined };
}

function textOf(text: string): string {
  if (text.length === 0) {
    fail("OKM1120", "search needs text to look for.", "Pass the words you want to find.");
  }
  assertNoControl(text, "search");
  return text;
}

function matchOf(value: unknown): SearchMatch {
  if (value === undefined) return "natural";
  if (typeof value === "string" && isMatch(value)) return value;
  fail(
    "OKM1120",
    "search.match must be natural, all-words, phrase, or advanced.",
    "Use natural, all-words, phrase, or advanced.",
  );
}

function isMatch(value: string): value is SearchMatch {
  return (MATCHES as readonly string[]).includes(value);
}

function languageOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    fail(
      "OKM1120",
      "search.language must be a text search language such as english.",
      "Pass a language name such as english, or leave it out.",
    );
  }
  return value;
}

function columnFor(table: Indexed, name: string | undefined): ColumnModel {
  const columns = searchable(table);
  const names = columns.map((column) => column.field);
  if (name === undefined) {
    const only = columns[0];
    if (columns.length === 1 && only !== undefined) return only;
    if (columns.length === 0) {
      fail(
        "OKM1120",
        `Table ${table.model.name} has no column you can search.`,
        "Add a column built for search.",
      );
    }
    fail(
      "OKM1120",
      `Table ${table.model.name} has more than one column you can search. Name one with search: { for, in }. Columns: ${list(names)}.`,
      `Set in to one of: ${list(names)}.`,
    );
  }
  const column = table.columns.get(name);
  if (column === undefined) {
    throwNamed(
      "OKM1120",
      name,
      names,
      `Column ${name} is not on ${table.model.name}. Columns you can search: ${list(names)}.`,
    );
  }
  if (column.dataType !== "tsvector") {
    fail(
      "OKM1120",
      `Column ${name} cannot be searched. Columns you can search: ${list(names)}.`,
      names.length === 0
        ? "This table has no column you can search."
        : `Search one of: ${list(names)}.`,
    );
  }
  if (column.hidden === true) refuseHidden(column);
  return column;
}

function searchable(table: Indexed): ColumnModel[] {
  const found: ColumnModel[] = [];
  for (const column of table.model.columns) {
    if (column.dataType === "tsvector" && column.hidden !== true) found.push(column);
  }
  return found;
}

function withMatch(
  where: unknown,
  field: string,
  text: string,
  options: { readonly match: SearchMatch; readonly language: string | undefined },
): unknown {
  const filter = { [field]: tag("matches", searchValue(text, passed(options))) };
  if (where === undefined) return filter;
  if (isOperator(where) && operatorName(where) === "and") {
    const branches = operatorValue(where);
    if (Array.isArray(branches)) return tag("and", [...branches, filter]);
  }
  return tag("and", [where, filter]);
}

function ranked(
  table: Indexed,
  field: string,
  text: string,
  options: { readonly match: SearchMatch; readonly language: string | undefined },
): Record<string, unknown> {
  const order: Record<string, unknown> = {
    [field]: tag("relevance", searchValue(text, passed(options))),
  };
  for (const key of table.model.primary) {
    if (!Object.hasOwn(order, key)) order[key] = "asc";
  }
  return order;
}

function passed(options: {
  readonly match: SearchMatch;
  readonly language: string | undefined;
}): SearchOptions {
  if (options.language === undefined) return { match: options.match };
  return { match: options.match, language: options.language };
}
