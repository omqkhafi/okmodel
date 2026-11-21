/**
 * Terminal questions for a rename and for a column that becomes required.
 *
 * Loaded only when generate has a pair to resolve or a column to fill.
 * Expression checks load from here only after an expression is chosen.
 */

import { OkmError } from "../../contracts/error.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import type { DeclaredRename } from "../../contracts/catalog/rename.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import { attachPartial } from "../cli/outcome.js";
import {
  countPhrase,
  hasRows,
  probeTarget,
  readCommonValues,
  type CommonValue,
  type Fill,
  type FillNeeds,
  type ProbeCount,
  type ProbeHit,
  type ProbeRequest,
} from "./data-probe.js";
import { columnSwaps, requiredChanges, type ColumnSwap, type RequiredChange } from "./plan.js";

type Ask = (label: string) => Promise<string>;
type Write = (text: string) => void;

const RENAME_FLAG = /^([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)=([A-Za-z_][\w$]*)$/;
const FILL_FLAG = /^([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)=([\s\S]+)$/;
const CONSTANT =
  /^(?:-?\d+(?:\.\d+)?|true|false|null|'(?:''|[^'])*')(?:\s*::\s*[\w." ]+(?:\[\])?)?$/i;

export function parseRenameFlag(flag: string): ColumnSwap {
  const match = RENAME_FLAG.exec(flag);
  if (match === null) {
    throw new OkmError("invalid", "--rename needs table.old=new.", {
      fix: { summary: "Pass --rename <table>.<old>=<new>." },
    });
  }
  return { table: match[1] ?? "", from: match[2] ?? "", to: match[3] ?? "" };
}

/**
 * Parses `--fill table.column=<sql>`.
 *
 * @param flag - The flag value
 * @returns The column and the expression
 * @throws OkmError `invalid` when the shape is wrong
 */
export function parseFillFlag(flag: string): Fill {
  const match = FILL_FLAG.exec(flag.trim());
  if (match === null || (match[3] ?? "").trim().length === 0) {
    throw new OkmError("invalid", "--fill needs table.column=<sql expression>.", {
      fix: { summary: "Pass --fill <table>.<column>=<sql expression>." },
    });
  }
  return { table: match[1] ?? "", column: match[2] ?? "", expression: (match[3] ?? "").trim() };
}

/**
 * Columns that become required on a table that already exists.
 *
 * A table created in this plan is exempt. A new column with a default is not
 * this case: the planner already fills a volatile default.
 *
 * @param before - Previous catalog
 * @param after - Schema catalog
 * @returns One entry per column, in catalog order
 */
export async function decideSwaps(input: {
  readonly before: Catalog;
  readonly after: Catalog;
  readonly renames: readonly DeclaredRename[];
  readonly schema: string;
  readonly url?: string;
  readonly terminal: boolean;
  readonly renameFlags: readonly string[];
  readonly dropAndAdd: boolean;
  readonly ask?: Ask;
  readonly write?: Write;
}): Promise<{ readonly extra: readonly DeclaredRename[]; readonly accept: readonly ColumnSwap[] }> {
  const found = columnSwaps(input.before, input.after, input.renames);
  if (found.blocked || found.clear.length === 0) return { extra: [], accept: [] };
  const flagged = input.renameFlags.map(parseRenameFlag);
  for (const flag of flagged) {
    if (!found.clear.some((swap) => sameSwap(swap, flag))) {
      throw new OkmError(
        "invalid",
        `--rename ${flag.table}.${flag.from}=${flag.to} does not match a removed column and an added column.`,
        { fix: { summary: "Name a column that was removed and the column that replaced it." } },
      );
    }
  }
  const extra: DeclaredRename[] = [];
  const accept: ColumnSwap[] = [];
  const open = found.clear.filter((swap) => !flagged.some((flag) => sameSwap(swap, flag)));
  extra.push(...flagged.map((swap) => ({ kind: "column" as const, ...swap })));
  let counts: readonly ProbeHit[] | "unreachable" = "unreachable";
  if (input.url !== undefined && (open.length > 0 || input.terminal)) {
    counts = await probeTarget(
      input.url,
      input.schema,
      found.clear.map((swap) => ({
        table: swap.table,
        column: swap.from,
        which: "notNull" as const,
      })),
    );
  }
  const reached = counts !== "unreachable";
  for (const swap of open) {
    if (input.dropAndAdd) {
      accept.push(swap);
      continue;
    }
    if (!input.terminal || input.ask === undefined || input.write === undefined) {
      throw renameRefusal(swap);
    }
    const held = reached ? hit(counts, swap.table, swap.from, "notNull") : undefined;
    input.write(`${renameText(swap, held, reached)}\n`);
    const answer = await input.ask("Choose [1/2]: ");
    if (answer === "1") extra.push({ kind: "column", ...swap });
    else if (answer === "2") accept.push(swap);
    else throw renameRefusal(swap);
  }
  return { extra, accept };
}

/**
 * Resolves fill questions. `plan` does not ask and does not refuse.
 *
 * @param input - Changes, flags, and whether this is generate
 * @returns Fills to splice, lines to print, and empty-row counts
 */
export async function decideFills(input: {
  readonly before: Catalog;
  readonly after: Catalog;
  readonly schema: string;
  readonly url?: string;
  readonly mode: "generate" | "plan";
  readonly terminal: boolean;
  readonly fillFlags: readonly string[];
  readonly renames?: readonly DeclaredRename[];
  readonly ask?: Ask;
  readonly write?: Write;
}): Promise<{
  readonly fills: readonly Fill[];
  readonly lines: readonly string[];
  readonly empty: ReadonlyMap<string, ProbeCount>;
  readonly note?: string;
}> {
  const changes = requiredChanges(input.before, input.after, input.renames ?? []);
  const flagged = input.fillFlags.map(parseFillFlag);
  for (const fill of flagged) {
    if (!changes.some((change) => change.table === fill.table && change.column === fill.column)) {
      throw new OkmError(
        "invalid",
        `--fill ${fill.table}.${fill.column} is not a column that becomes required.`,
        { fix: { summary: "Name a column this migration makes required." } },
      );
    }
  }
  if (changes.length === 0) return { fills: flagged, lines: [], empty: new Map() };
  const requests: ProbeRequest[] = [];
  for (const change of changes) {
    if (change.kind === "add") requests.push({ table: change.table, which: "rows" });
    else {
      requests.push({ table: change.table, column: change.column, which: "null" });
      requests.push({ table: change.table, column: change.column, which: "notNull" });
      if (/^(text|varchar|character varying|char|character|citext)\b/i.test(change.dataType)) {
        requests.push({ table: change.table, column: change.column, which: "blank" });
      }
    }
  }
  const probed =
    input.url === undefined ? "unreachable" : await probeTarget(input.url, input.schema, requests);
  const reached = probed !== "unreachable";
  const commons =
    input.mode === "generate" && input.terminal && input.url !== undefined && reached
      ? await readCommonValues(input.url, input.schema, changes)
      : [];
  const empty = new Map<string, ProbeCount>();
  const lines: string[] = [];
  const fills: Fill[] = [...flagged];
  let note: string | undefined;
  for (const change of changes) {
    const key = `${change.table}.${change.column}`;
    const count = emptyCount(change, probed);
    if (count !== undefined) empty.set(key, count);
    if (flagged.some((fill) => fill.table === change.table && fill.column === change.column)) {
      continue;
    }
    if (
      input.mode === "plan" ||
      !input.terminal ||
      input.ask === undefined ||
      input.write === undefined
    ) {
      if (input.mode === "generate" && reached && hasRows(count)) {
        throw fillRefusal(change, count, suggestions(input.after, change));
      }
      if (input.mode === "generate")
        note = "note: Apply will stop before changing anything if rows are left.";
      continue;
    }
    const choice = await askFill(
      input,
      change,
      probed,
      reached,
      commons === "unreachable" ? [] : commons,
    );
    if (choice === undefined) {
      note = "note: Apply will stop before changing anything if rows are left.";
      continue;
    }
    fills.push({ table: change.table, column: change.column, expression: choice });
  }
  if (input.mode === "generate" && input.url !== undefined && reached && fills.length > 0) {
    const { checkExpression } = await import("./data-check.js");
    for (const fill of fills) {
      const change = changes.find(
        (item) => item.table === fill.table && item.column === fill.column,
      );
      if (change === undefined) continue;
      lines.push(
        ...(await checkExpression(input.url, input.schema, input.after, change, fill.expression)),
      );
    }
  }
  return { fills, lines, empty, ...(note === undefined ? {} : { note }) };
}
function sameSwap(left: ColumnSwap, right: ColumnSwap): boolean {
  return left.table === right.table && left.from === right.from && left.to === right.to;
}

function renameRefusal(swap: ColumnSwap): OkmError {
  const flag = `--rename ${swap.table}.${swap.from}=${swap.to}`;
  return new OkmError("OKM1530", `Drop ${swap.from} and add ${swap.to} could be a rename.`, {
    fix: { summary: `Pass ${flag} or --drop-and-add.` },
  });
}

function renameText(swap: ColumnSwap, held: ProbeCount | undefined, reached: boolean): string {
  const number =
    reached && held !== undefined && held.kind !== "unknown" ? countPhrase(held) : undefined;
  const keep = number === undefined ? "It keeps its values." : `It keeps its ${number} values.`;
  const lost =
    held?.kind === "unknown"
      ? `I could not count ${swap.from} in 2 s.`
      : number === undefined
        ? `${swap.from}'s values are lost.`
        : `${swap.from}'s ${number} values are lost.`;
  return [
    `I see "${swap.from}" removed and "${swap.to}" added on ${swap.table}. Is this a rename?`,
    `  1) Yes, rename ${swap.from} to ${swap.to}. ${keep}`,
    `  2) No, drop ${swap.from} and add ${swap.to}. ${lost}`,
  ].join("\n");
}

function hit(
  hits: readonly ProbeHit[] | "unreachable",
  table: string,
  column: string | undefined,
  which: ProbeHit["which"],
): ProbeCount | undefined {
  if (hits === "unreachable") return undefined;
  return hits.find((item) => item.table === table && item.column === column && item.which === which)
    ?.count;
}

function emptyCount(
  change: RequiredChange,
  probed: readonly ProbeHit[] | "unreachable",
): ProbeCount | undefined {
  if (change.kind === "add") return hit(probed, change.table, undefined, "rows");
  return hit(probed, change.table, change.column, "null");
}

async function askFill(
  input: { readonly after: Catalog; readonly ask?: Ask; readonly write?: Write },
  change: RequiredChange,
  probed: readonly ProbeHit[] | "unreachable",
  reached: boolean,
  commons: readonly CommonValue[],
): Promise<string | undefined> {
  const ask = input.ask;
  const write = input.write;
  if (ask === undefined || write === undefined) return undefined;
  const empty = emptyCount(change, probed);
  const present =
    change.kind === "set" ? hit(probed, change.table, change.column, "notNull") : undefined;
  const blank =
    change.kind === "set" ? hit(probed, change.table, change.column, "blank") : undefined;
  const menu = menuOf(
    input.after,
    change,
    commons.find((item) => item.table === change.table && item.column === change.column),
  );
  const lines = [intro(change, empty, present, reached), ""];
  if (blank !== undefined && blank.kind === "exact" && blank.n > 0) {
    lines.push(`${countPhrase(blank)} rows hold an empty string. Those rows stay.`, "");
  }
  const who =
    empty?.kind === "exact"
      ? `What should the ${countPhrase(empty)} rows get?`
      : "What should the empty rows get?";
  lines.push(who);
  menu.forEach((item, index) => lines.push(`  ${String(index + 1)}) ${item.label}`));
  write(`${lines.join("\n")}\n`);
  const answer = await ask(`Choose [1-${String(menu.length)}]: `);
  const picked = menu[Number(answer) - 1];
  if (picked === undefined) throw fillRefusal(change, empty, suggestions(input.after, change));
  if (picked.kind === "nothing") return undefined;
  if (picked.kind === "sql") return picked.sql;
  if (picked.kind === "columns") {
    if (picked.columns.length === 1) return quoteIdent(picked.columns[0] ?? "");
    const which = await ask(`Which column? [${picked.columns.join("/")}]: `);
    if (!picked.columns.includes(which))
      throw fillRefusal(change, empty, suggestions(input.after, change));
    return quoteIdent(which);
  }
  const typed = await ask(
    picked.kind === "constant" ? "Type the constant: " : "Type the SQL expression: ",
  );
  if (typed.length === 0) throw fillRefusal(change, empty, suggestions(input.after, change));
  return picked.kind === "constant" ? constantSql(typed, change.dataType) : typed;
}

type MenuItem =
  | { readonly kind: "sql"; readonly sql: string; readonly label: string }
  | { readonly kind: "columns"; readonly columns: readonly string[]; readonly label: string }
  | { readonly kind: "constant" | "expression" | "nothing"; readonly label: string };

function menuOf(
  after: Catalog,
  change: RequiredChange,
  common: CommonValue | undefined,
): readonly MenuItem[] {
  const items: MenuItem[] = [];
  if (change.defaultExpression !== undefined) {
    items.push({
      kind: "sql",
      sql: change.defaultExpression,
      label: `${change.defaultExpression}  the schema default`,
    });
  }
  const typed = typeSuggestion(change.dataType);
  if (typed !== undefined && typed !== change.defaultExpression) {
    items.push({ kind: "sql", sql: typed, label: pad(typed, `suggested for ${change.dataType}`) });
  }
  const siblings = siblingColumns(after, change);
  if (siblings.length === 1) {
    items.push({ kind: "columns", columns: siblings, label: `the value of ${siblings[0] ?? ""}` });
  } else if (siblings.length > 1) {
    items.push({
      kind: "columns",
      columns: siblings,
      label: `the value of ${siblings.join(" or ")}`,
    });
  }
  for (const value of picklistValues(after, change).slice(0, 5)) {
    items.push({ kind: "sql", sql: quoteLiteral(value), label: quoteLiteral(value) });
  }
  if (common !== undefined) {
    const literal = quoteLiteral(common.value);
    items.push({
      kind: "sql",
      sql: literal,
      label: `most common here: ${literal} (${String(common.percent)}%)`,
    });
  }
  items.push(
    { kind: "constant", label: "a constant I type" },
    { kind: "expression", label: "an SQL expression I type" },
    {
      kind: "nothing",
      label:
        "nothing: I will fill them myself. Apply stops before changing anything if rows are left.",
    },
  );
  return items;
}

function suggestions(after: Catalog, change: RequiredChange): readonly string[] {
  const list: string[] = [];
  if (change.defaultExpression !== undefined) list.push(change.defaultExpression);
  const typed = typeSuggestion(change.dataType);
  if (typed !== undefined) list.push(typed);
  for (const name of siblingColumns(after, change)) list.push(quoteIdent(name));
  for (const value of picklistValues(after, change).slice(0, 5)) list.push(quoteLiteral(value));
  return [...new Set(list)];
}

function intro(
  change: RequiredChange,
  empty: ProbeCount | undefined,
  present: ProbeCount | undefined,
  reached: boolean,
): string {
  const head = `${change.table}.${change.column} becomes required.`;
  if (!reached || empty === undefined) return head;
  if (empty.kind === "unknown") return `${head} I could not count in 2 s.`;
  const emptyText = `${countPhrase(empty)} rows have no value`;
  if (present?.kind === "exact" && empty.kind === "exact") {
    return `${head} ${emptyText}; the other ${countPhrase(present)} keep theirs.`;
  }
  return `${head} ${emptyText}.`;
}

function pad(label: string, hint: string): string {
  return `${label}${" ".repeat(Math.max(2, 34 - label.length))}${hint}`;
}

function typeSuggestion(dataType: string): string | undefined {
  const name = dataType.toLowerCase();
  if (name === "timestamptz" || name.startsWith("timestamp")) return "now()";
  if (name === "bool" || name === "boolean") return "false";
  if (/^(smallint|int2|int4|int8|integer|bigint|numeric|decimal|real|float|double)/.test(name))
    return "0";
  return undefined;
}

function siblingColumns(after: Catalog, change: RequiredChange): readonly string[] {
  const names: string[] = [];
  for (const object of after.objects) {
    if (object.kind !== "column") continue;
    if (object.identity.parent.name !== change.table || object.identity.name === change.column)
      continue;
    if (object.definition.dataType !== change.dataType || object.definition.generated !== undefined)
      continue;
    names.push(object.identity.name);
  }
  return names.slice(0, 4);
}

function picklistValues(after: Catalog, change: RequiredChange): readonly string[] {
  const quoted = quoteIdent(change.column);
  for (const object of after.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "check") continue;
    if (object.identity.parent.name !== change.table) continue;
    const expression = object.definition.expression ?? "";
    if (!expression.includes(quoted) || !expression.includes(" IN (")) continue;
    return [...expression.matchAll(/'((?:''|[^'])*)'/g)].map((match) =>
      (match[1] ?? "").replaceAll("''", "'"),
    );
  }
  return [];
}

function constantSql(typed: string, dataType: string): string {
  if (CONSTANT.test(typed)) return typed;
  const name = dataType.toLowerCase();
  if (
    /^(smallint|int|integer|bigint|numeric|decimal|real|float|double)/.test(name) &&
    /^-?\d+(\.\d+)?$/.test(typed)
  ) {
    return typed;
  }
  if ((name === "bool" || name === "boolean") && /^(true|false)$/i.test(typed))
    return typed.toLowerCase();
  return quoteLiteral(typed);
}

function fillRefusal(
  change: RequiredChange,
  count: ProbeCount | undefined,
  suggest: readonly string[],
): OkmError {
  const target = `${change.table}.${change.column}`;
  const emptyRows =
    count?.kind === "exact" ? count.n : count?.kind === "least" ? "10,000 or more" : "unknown";
  const how =
    count?.kind === "exact" ? `${countPhrase(count)} rows have no value` : "rows with no value";
  const needs: FillNeeds = { flag: "--fill", target, emptyRows, suggest };
  return attachPartial(
    new OkmError("OKM1525", `${target} has ${how}.`, {
      fix: { summary: `Pass --fill ${target}=<sql expression>.` },
    }),
    { data: { path: null, needs }, warnings: [], outFile: null },
  );
}
