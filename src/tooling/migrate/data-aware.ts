/**
 * Questions and fill steps for a migration that touches stored rows (D332, D334).
 *
 * The schema file is never edited. A rename is a {@link DeclaredRename} passed
 * into the planner for this run. A fill is two backfill steps around the
 * `NOT VALID` check: fill, check, fill, validate, set not null, drop the check.
 */

import { OkmError } from "../../contracts/error.js";
import type { Catalog, ColumnObject } from "../../contracts/catalog/types.js";
import type { DeclaredRename } from "../../contracts/catalog/rename.js";
import { ddlStep } from "../../dialects/ddl-step.js";
import { qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import { notNullSteps } from "../../dialects/pg/table-safe.js";
import { attachPartial } from "../cli/outcome.js";
import { keyRangePredicate, primaryKeyColumns, resolveBatchSize } from "./backfill.js";
import { strictestClass } from "./classify.js";
import {
  countPhrase,
  hasRows,
  probeTarget,
  readCommonValues,
  type CommonValue,
  type ProbeCount,
  type ProbeHit,
  type ProbeRequest,
} from "./data-probe.js";
import {
  columnSwaps,
  type ColumnSwap,
  type MigrationPlan,
  type PlanStep,
} from "./plan.js";

/** Flags and the terminal `okm generate` and `okm migrate plan` share. */
export type DataOptions = {
  readonly renames?: readonly string[];
  readonly dropAndAdd?: boolean;
  readonly fills?: readonly string[];
  readonly terminal?: boolean;
  readonly ask?: Ask;
  readonly write?: Write;
  /** Selected target. Absent when the command has no single target. */
  readonly url?: string;
};

/** One `--fill table.column=expression` value. */
export type Fill = {
  readonly table: string;
  readonly column: string;
  readonly expression: string;
};

/** `--json` object on an OKM1525 refusal that needs `--fill`. */
export type FillNeeds = {
  readonly flag: "--fill";
  readonly target: string;
  readonly emptyRows: number | string;
  readonly suggest: readonly string[];
};

/** A nullable column made required, or a new required column with no default. */
export type RequiredChange = {
  readonly table: string;
  readonly column: string;
  /** `add` when the column is new. `set` when it was nullable. */
  readonly kind: "add" | "set";
  readonly dataType: string;
  readonly defaultExpression?: string;
};

type Ask = (label: string) => Promise<string>;
type Write = (text: string) => void;

const RENAME_FLAG = /^([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)=([A-Za-z_][\w$]*)$/;
const FILL_FLAG = /^([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)=([\s\S]+)$/;
const CONSTANT =
  /^(?:-?\d+(?:\.\d+)?|true|false|null|'(?:''|[^'])*')(?:\s*::\s*[\w." ]+(?:\[\])?)?$/i;

/**
 * Parses `--rename table.old=new`.
 *
 * @param flag - The flag value
 * @returns The pair
 * @throws OkmError `invalid` when the shape is wrong
 */
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
export function requiredChanges(before: Catalog, after: Catalog): readonly RequiredChange[] {
  const tables = new Set(
    before.objects.filter((object) => object.kind === "table").map((object) => object.identity.name),
  );
  const previous = new Map<string, ColumnObject>();
  for (const object of before.objects) {
    if (object.kind !== "column") continue;
    previous.set(`${object.identity.parent.name}.${object.identity.name}`, object);
  }
  const changes: RequiredChange[] = [];
  for (const object of after.objects) {
    if (object.kind !== "column" || object.definition.nullable) continue;
    if (object.definition.identity !== undefined || object.definition.generated !== undefined) {
      continue;
    }
    const table = object.identity.parent.name;
    if (!tables.has(table)) continue;
    const prior = previous.get(`${table}.${object.identity.name}`);
    if (prior === undefined) {
      if (object.definition.defaultExpression !== undefined) continue;
      changes.push(changeOf(object, "add"));
      continue;
    }
    if (prior.definition.nullable) changes.push(changeOf(object, "set"));
  }
  return changes;
}

/**
 * Resolves rename questions into planner inputs.
 *
 * A terminal answer of 1 adds a rename. 2 accepts the drop and add. Without
 * a terminal and without a flag, OKM1530 names `--rename` and `--drop-and-add`.
 * A blocked group (casing, a table, or more than one pair) is left for the
 * planner's existing refusal.
 *
 * @param input - Catalogs, flags, and the optional terminal
 * @returns Renames to pass in and pairs to accept as a drop and add
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
      found.clear.map((swap) => ({ table: swap.table, column: swap.from, which: "notNull" as const })),
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
  readonly ask?: Ask;
  readonly write?: Write;
}): Promise<{
  readonly fills: readonly Fill[];
  readonly lines: readonly string[];
  readonly empty: ReadonlyMap<string, ProbeCount>;
  readonly note?: string;
}> {
  const changes = requiredChanges(input.before, input.after);
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
      requests.push({ table: change.table, column: change.column, which: "blank" });
    }
  }
  const probed = input.url === undefined ? "unreachable" : await probeTarget(input.url, input.schema, requests);
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
    if (input.mode === "plan" || !input.terminal || input.ask === undefined || input.write === undefined) {
      if (input.mode === "generate" && reached && hasRows(count)) {
        throw fillRefusal(change, count, suggestions(input.after, change));
      }
      if (input.mode === "generate") note = "note: Apply will stop before changing anything if rows are left.";
      continue;
    }
    const choice = await askFill(input, change, probed, reached, commons === "unreachable" ? [] : commons);
    if (choice === undefined) {
      note = "note: Apply will stop before changing anything if rows are left.";
      continue;
    }
    fills.push({ table: change.table, column: change.column, expression: choice });
  }
  if (input.mode === "generate" && input.url !== undefined && reached) {
    for (const fill of fills) {
      const change = changes.find((item) => item.table === fill.table && item.column === fill.column);
      if (change === undefined) continue;
      lines.push(...(await checkExpression(input.url, input.schema, input.after, change, fill.expression)));
    }
  }
  return { fills, lines, empty, ...(note === undefined ? {} : { note }) };
}

/**
 * Inserts the fill steps. A table with no primary key is OKM1546.
 *
 * @param plan - Plan the catalogs produced
 * @param fills - Expressions to write
 * @param catalogs - Before and after, for the primary key and constraint names
 * @param schema - Concrete schema
 * @param batchSize - Rows per batch. Omitted uses 1,000
 * @returns The plan, with its class recomputed
 */
export function spliceFills(
  plan: MigrationPlan,
  fills: readonly Fill[],
  catalogs: readonly Catalog[],
  schema: string,
  batchSize?: number,
): MigrationPlan {
  const batch = resolveBatchSize(batchSize);
  let steps = [...plan.steps];
  for (const fill of fills) steps = spliceOne(steps, fill, catalogs, schema, batch);
  return { ...plan, steps, class: strictestClass(steps.map((step) => step.class)) };
}

/**
 * Lock-line phrase for one column.
 *
 * @param count - Empty rows
 * @param fill - Expression, when the plan fills them
 * @returns The phrase after the lock
 */
export function lockPhrase(count: ProbeCount, fill?: string): string {
  const rows =
    count.kind === "exact"
      ? `${countPhrase(count)} rows have no value`
      : count.kind === "least"
        ? "10,000 or more rows have no value"
        : "I could not count in 2 s";
  return fill === undefined ? rows : `${rows}, filled with ${fill}`;
}

/**
 * Appends {@link lockPhrase} when `step` is about a probed column.
 *
 * @param step - Plan step
 * @param base - Lock text without the probe
 * @param empty - Empty-row counts keyed `table.column`
 * @param fills - Fills in the plan
 * @returns The lock text
 */
export function annotateProbe(
  step: PlanStep,
  base: string,
  empty: ReadonlyMap<string, ProbeCount>,
  fills: readonly Fill[],
): string {
  for (const [key, count] of empty) {
    const dot = key.indexOf(".");
    const table = key.slice(0, dot);
    const column = key.slice(dot + 1);
    if (!step.sql.includes(quoteIdent(table)) || !step.sql.includes(quoteIdent(column))) continue;
    const fill = fills.find((item) => item.table === table && item.column === column);
    return `${base}; ${lockPhrase(count, fill?.expression)}`;
  }
  return base;
}

/**
 * Sentence for the drop question, including the trailing space.
 *
 * @param column - Column name
 * @param count - Non-null rows, when the target answered
 * @returns `""` when there is no count
 */
export function dropHolds(column: string, count: ProbeCount | undefined): string {
  if (count === undefined) return "";
  if (count.kind === "unknown") return `I could not count ${column} in 2 s. `;
  return `${column} holds ${countPhrase(count)} values. `;
}

/**
 * Columns a migration makes required without a fill step.
 *
 * @param steps - Migration steps
 * @returns Columns whose `SET NOT NULL` or required add has no null-fill
 */
export function unfilledRequired(
  steps: readonly { readonly sql: string }[],
): readonly { readonly table: string; readonly column: string; readonly added: boolean }[] {
  const found: { table: string; column: string; added: boolean }[] = [];
  for (const step of steps) {
    const set = /^alter table\s+(\S+)\s+alter column\s+(\S+)\s+set not null\b/.exec(step.sql);
    const add = /^alter table\s+(\S+)\s+add column\s+(\S+)\s+(?!generated\b).+\bnot null\b/.exec(step.sql);
    const match = set ?? add;
    if (match === null) continue;
    if (add !== null && /\bdefault\b/.test(step.sql)) continue;
    const table = lastIdent(match[1] ?? "");
    const column = unquote(match[2] ?? "");
    if (filled(steps, table, column)) continue;
    if (found.some((item) => item.table === table && item.column === column)) continue;
    found.push({ table, column, added: add !== null && set === null });
  }
  return found;
}

/**
 * OKM1525 before apply changes anything.
 *
 * @param table - Table name
 * @param column - Column name
 * @param count - Empty rows
 * @returns The error. The fix names both next steps
 */
export function unfilledError(table: string, column: string, count: ProbeCount): OkmError {
  const how =
    count.kind === "exact"
      ? `${countPhrase(count)} rows with no value`
      : count.kind === "least"
        ? "10,000 or more rows with no value"
        : "rows with no value (I could not count in 2 s)";
  return new OkmError(
    "OKM1525",
    `${table}.${column} has ${how}, and this migration does not fill them.\nNothing was changed.`,
    {
      fix: {
        summary: `Regenerate it with --fill ${table}.${column}=<expression> if it has not run anywhere shared. Otherwise add a data migration that fills ${table}.${column} before the constraint.`,
      },
    },
  );
}

/**
 * JSON `data` for one probed step. Absent when the step has no probe.
 *
 * @param step - Plan step
 * @param empty - Empty-row counts
 * @param fills - Fills in the plan
 * @returns The additive field, or `undefined`
 */
export function stepData(
  step: PlanStep,
  empty: ReadonlyMap<string, ProbeCount>,
  fills: readonly Fill[],
): { readonly emptyRows: number | string; readonly fill?: string } | undefined {
  for (const [key, count] of empty) {
    const dot = key.indexOf(".");
    const table = key.slice(0, dot);
    const column = key.slice(dot + 1);
    if (!step.sql.includes(quoteIdent(table)) || !step.sql.includes(quoteIdent(column))) continue;
    const fill = fills.find((item) => item.table === table && item.column === column);
    const emptyRows =
      count.kind === "exact" ? count.n : count.kind === "least" ? "10,000 or more" : "unknown";
    return fill === undefined ? { emptyRows } : { emptyRows, fill: fill.expression };
  }
  return undefined;
}

function changeOf(column: ColumnObject, kind: "add" | "set"): RequiredChange {
  return {
    table: column.identity.parent.name,
    column: column.identity.name,
    kind,
    dataType: column.definition.dataType,
    ...(column.definition.defaultExpression === undefined
      ? {}
      : { defaultExpression: column.definition.defaultExpression }),
  };
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
  const number = reached && held !== undefined && held.kind !== "unknown" ? countPhrase(held) : undefined;
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
  return hits.find((item) => item.table === table && item.column === column && item.which === which)?.count;
}

function emptyCount(change: RequiredChange, probed: readonly ProbeHit[] | "unreachable"): ProbeCount | undefined {
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
  const present = change.kind === "set" ? hit(probed, change.table, change.column, "notNull") : undefined;
  const blank = change.kind === "set" ? hit(probed, change.table, change.column, "blank") : undefined;
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
    empty?.kind === "exact" ? `What should the ${countPhrase(empty)} rows get?` : "What should the empty rows get?";
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
    if (!picked.columns.includes(which)) throw fillRefusal(change, empty, suggestions(input.after, change));
    return quoteIdent(which);
  }
  const typed = await ask(picked.kind === "constant" ? "Type the constant: " : "Type the SQL expression: ");
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
    items.push({ kind: "sql", sql: change.defaultExpression, label: `${change.defaultExpression}  the schema default` });
  }
  const typed = typeSuggestion(change.dataType);
  if (typed !== undefined && typed !== change.defaultExpression) {
    items.push({ kind: "sql", sql: typed, label: pad(typed, `suggested for ${change.dataType}`) });
  }
  const siblings = siblingColumns(after, change);
  if (siblings.length === 1) {
    items.push({ kind: "columns", columns: siblings, label: `the value of ${siblings[0] ?? ""}` });
  } else if (siblings.length > 1) {
    items.push({ kind: "columns", columns: siblings, label: `the value of ${siblings.join(" or ")}` });
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
      label: "nothing: I will fill them myself. Apply stops before changing anything if rows are left.",
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
  if (/^(smallint|int2|int4|int8|integer|bigint|numeric|decimal|real|float|double)/.test(name)) return "0";
  return undefined;
}

function siblingColumns(after: Catalog, change: RequiredChange): readonly string[] {
  const names: string[] = [];
  for (const object of after.objects) {
    if (object.kind !== "column") continue;
    if (object.identity.parent.name !== change.table || object.identity.name === change.column) continue;
    if (object.definition.dataType !== change.dataType || object.definition.generated !== undefined) continue;
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
    return [...expression.matchAll(/'((?:''|[^'])*)'/g)].map((match) => (match[1] ?? "").replaceAll("''", "'"));
  }
  return [];
}

function constantSql(typed: string, dataType: string): string {
  if (CONSTANT.test(typed)) return typed;
  const name = dataType.toLowerCase();
  if (/^(smallint|int|integer|bigint|numeric|decimal|real|float|double)/.test(name) && /^-?\d+(\.\d+)?$/.test(typed)) {
    return typed;
  }
  if ((name === "bool" || name === "boolean") && /^(true|false)$/i.test(typed)) return typed.toLowerCase();
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
  const how = count?.kind === "exact" ? `${countPhrase(count)} rows have no value` : "rows with no value";
  const needs: FillNeeds = { flag: "--fill", target, emptyRows, suggest };
  return attachPartial(
    new OkmError("OKM1525", `${target} has ${how}.`, {
      fix: { summary: `Pass --fill ${target}=<sql expression>.` },
    }),
    { data: { path: null, needs }, warnings: [], outFile: null },
  );
}

function spliceOne(
  steps: readonly PlanStep[],
  fill: Fill,
  catalogs: readonly Catalog[],
  schema: string,
  batch: number,
): PlanStep[] {
  const backfill = backfillStep(fill, catalogs, schema, batch);
  const quoted = quoteIdent(fill.column);
  const check = steps.findIndex(
    (step) => step.sql.includes(`check (${quoted} is not null) not valid`) && step.sql.includes(quoteIdent(fill.table)),
  );
  if (check >= 0) {
    const next = [...steps];
    next.splice(check, 0, backfill);
    next.splice(check + 2, 0, backfill);
    return next;
  }
  const add = steps.findIndex(
    (step) => step.kind === "add-column-required" && step.sql.includes(quoted) && step.sql.includes(quoteIdent(fill.table)),
  );
  if (add < 0) {
    throw new OkmError("invalid", `No required-column step for ${fill.table}.${fill.column}.`, {
      fix: { summary: "Generate the migration again. The column has to become required in this plan." },
    });
  }
  const column = columnObject(catalogs, fill.table, fill.column);
  const added = steps[add];
  if (added === undefined) return [...steps];
  const nullable: PlanStep = {
    ...added,
    sql: added.sql.replace(/ not null$/, ""),
    kind: "add-column",
    class: "expand",
  };
  const rewritten = notNullSteps(column, schema, "add-column", catalogs).map((item) =>
    ddlStep(item.sql, item.kind, item.action, item.lock, item.transactional),
  );
  const sequence = [backfill, rewritten[0], backfill, ...rewritten.slice(1)].filter(
    (step): step is PlanStep => step !== undefined,
  );
  return [...steps.slice(0, add), nullable, ...sequence, ...steps.slice(add + 1)];
}

function backfillStep(fill: Fill, catalogs: readonly Catalog[], schema: string, batch: number): PlanStep {
  const key = primaryKeyColumns(catalogs, fill.table);
  const table = qualify(schema, fill.table);
  const name = quoteIdent(fill.column);
  const sql = `update ${table} set ${name} = ${fill.expression} where ${name} is null and ${keyRangePredicate(key)}`;
  return {
    ...ddlStep(sql, "backfill-contract", "backfill", "ROW EXCLUSIVE", false),
    backfill: { table, key: key.map((item) => item.quoted), batch },
  };
}

function columnObject(catalogs: readonly Catalog[], table: string, column: string): ColumnObject {
  for (const source of catalogs) {
    for (const object of source.objects) {
      if (object.kind === "column" && object.identity.parent.name === table && object.identity.name === column) {
        return object;
      }
    }
  }
  throw new OkmError("invalid", `Column ${table}.${column} is not in the catalog.`, {
    fix: { summary: "Keep the column on the table this migration changes." },
  });
}

function filled(steps: readonly { readonly sql: string }[], table: string, column: string): boolean {
  const name = quoteIdent(column);
  return steps.some(
    (step) =>
      step.sql.startsWith("update ") &&
      step.sql.includes(quoteIdent(table)) &&
      step.sql.includes(`set ${name} =`) &&
      step.sql.includes(`${name} is null`),
  );
}

function lastIdent(token: string): string {
  const names = [...token.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => (match[1] ?? "").replaceAll('""', '"'));
  return names.at(-1) ?? token;
}

function unquote(token: string): string {
  const match = /^"((?:[^"]|"")*)"$/.exec(token);
  return match === null ? token : (match[1] ?? "").replaceAll('""', '"');
}

async function checkExpression(
  url: string,
  schema: string,
  after: Catalog,
  change: RequiredChange,
  expression: string,
): Promise<readonly string[]> {
  refuseShape(expression);
  const postgres = (await import("postgres")).default;
  const { driverUrl } = await import("./driver-url.js");
  const { OPTIONAL_CONNECT_SECONDS } = await import("./optional-read.js");
  const sql = postgres(driverUrl(url), {
    max: 1,
    connect_timeout: OPTIONAL_CONNECT_SECONDS,
    idle_timeout: 1,
    onnotice: () => {},
  });
  const table = qualify(schema, change.table);
  const column = quoteIdent(change.column);
  const cast = typeSql(change.dataType);
  try {
    await sql.unsafe("begin read only");
    await sql.unsafe("set local statement_timeout = '2s'");
    const lines: string[] = [];
    const trigger = await sql.unsafe<{ tgname: string }[]>(
      `select t.tgname from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and not t.tgisinternal
       limit 1`,
      [schema, change.table],
    );
    const name = trigger[0]?.tgname;
    if (name !== undefined) {
      lines.push(
        `${change.table} has a trigger ${name}. A fill is an UPDATE, so it runs on the rows that were empty.`,
      );
    }
    try {
      await sql.unsafe(
        `select (${expression})::${cast} from (select 1) as okm_one left join ${table} on true limit 1`,
      );
    } catch (error) {
      throw expressionError(change, castMessage(error, change.dataType));
    }
    const run = (text: string): Promise<readonly Record<string, string | null>[]> => sql.unsafe(text);
    if (isConstant(expression)) {
      refuseConstant(after, change);
      await assertForeignKey(run, schema, after, change, expression);
    }
    await assertChecks(run, table, column, after, change, expression);
    const nulls = await sql.unsafe<{ c: string }[]>(
      `select count(*)::text as c from (select 1 from ${table} where ${column} is null and (${expression}) is null limit 10001) as okm_n`,
    );
    const nullCount = Number(nulls[0]?.c ?? "0");
    if (nullCount > 0) {
      const how = nullCount > 10_000 ? "10,000 or more" : nullCount.toLocaleString("en-US");
      throw expressionError(change, `${expression} is null for ${how} rows`);
    }
    const key = primaryKeyName(after, change.table);
    if (key !== undefined) {
      const sample = await sql.unsafe<{ id: string | null; v: string | null }[]>(
        `select ${quoteIdent(key)}::text as id, (${expression})::text as v from ${table} where ${column} is null limit 1`,
      );
      const row = sample[0];
      lines.push(`I checked ${expression} against the target: it returns ${change.dataType} and is not null.`);
      if (row?.id !== undefined && row.id !== null) {
        lines.push(`Example: ${change.table} ${row.id} would get ${row.v ?? ""}.`);
      }
    } else {
      lines.push(`I checked ${expression} against the target: it returns ${change.dataType} and is not null.`);
    }
    await sql.unsafe("commit");
    return lines;
  } catch (error) {
    await sql.unsafe("rollback").catch(() => undefined);
    throw error;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

function refuseShape(expression: string): void {
  if (/[;]|--|\/\*|\*\//.test(expression)) {
    throw new OkmError("invalid", "The expression has a comment or a semicolon.", {
      fix: { summary: "Pass one expression. A statement is refused." },
    });
  }
  if (/^\s*(select|insert|update|delete|with|alter|drop|create|grant|revoke|copy|do|begin|commit)\b/i.test(expression)) {
    throw new OkmError("invalid", "The expression is a statement.", {
      fix: { summary: "Pass one expression, such as now() or a quoted column." },
    });
  }
}

function isConstant(expression: string): boolean {
  return CONSTANT.test(expression.trim());
}

function refuseConstant(after: Catalog, change: RequiredChange): void {
  const unique = after.objects.some(
    (object) =>
      object.kind === "constraint" &&
      (object.definition.constraintKind === "unique" || object.definition.constraintKind === "primaryKey") &&
      object.identity.parent.name === change.table &&
      object.definition.columns.includes(change.column),
  );
  if (!unique) return;
  const key = primaryKeyName(after, change.table) ?? "id";
  throw new OkmError(
    "invalid",
    `A constant on unique ${change.table}.${change.column} would collide.`,
    { fix: { summary: `Use an expression such as 'tmp-' || ${key}.` } },
  );
}

async function assertForeignKey(
  sql: (text: string) => Promise<readonly Record<string, string | null>[]>,
  schema: string,
  after: Catalog,
  change: RequiredChange,
  expression: string,
): Promise<void> {
  for (const object of after.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") continue;
    if (object.identity.parent.name !== change.table) continue;
    const index = object.definition.columns.indexOf(change.column);
    if (index < 0 || object.definition.references === undefined) continue;
    const parent = object.definition.references.parent.name;
    const parentColumn = object.definition.references.columns[index];
    if (parentColumn === undefined) continue;
    const rows = await sql(
      `select exists(select 1 from ${qualify(schema, parent)} where ${quoteIdent(parentColumn)} = (${expression}))::text as ok`,
    );
    if (rows[0]?.ok === "true") continue;
    throw expressionError(change, `${expression} is not in ${parent}.${parentColumn}`);
  }
}

async function assertChecks(
  sql: (text: string) => Promise<readonly Record<string, string | null>[]>,
  table: string,
  column: string,
  after: Catalog,
  change: RequiredChange,
  expression: string,
): Promise<void> {
  for (const object of after.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "check") continue;
    if (object.identity.parent.name !== change.table || object.definition.enforced === false) continue;
    const body = object.definition.expression ?? "";
    if (!body.includes(column)) continue;
    const substituted = body.split(column).join(`(${expression})`);
    const rows = await sql(
      `select count(*)::text as c from (select 1 from ${table} where ${column} is null and not (${substituted}) limit 10001) as okm_n`,
    );
    const n = Number(rows[0]?.c ?? "0");
    if (n > 0) throw expressionError(change, `${expression} does not pass ${object.identity.name}`);
  }
}

function primaryKeyName(after: Catalog, table: string): string | undefined {
  for (const object of after.objects) {
    if (
      object.kind === "constraint" &&
      object.definition.constraintKind === "primaryKey" &&
      object.identity.parent.name === table
    ) {
      return object.definition.columns[0];
    }
  }
  return undefined;
}

function typeSql(dataType: string): string {
  if (/^[a-z_][\w$]*(\([^)]*\))?(\[\])*$/.test(dataType)) return dataType;
  return quoteIdent(dataType);
}

function expressionError(change: RequiredChange, reason: string): OkmError {
  return new OkmError("invalid", `${change.table}.${change.column}: ${reason}.`, {
    fix: { summary: "Pass an expression that yields a non-null value of the column's type." },
  });
}

function castMessage(error: unknown, dataType: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("22001") || message.includes("value too long")) return `the value is longer than ${dataType}`;
  if (message.includes("23514") || message.includes("check constraint")) return "the value does not pass a check";
  return `it does not return ${dataType}`;
}
