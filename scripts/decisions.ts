/**
 * Decision records: one file per decision under `docs/decisions/`.
 *
 * `scripts/split-decisions.ts` reads `docs/okmodel-decisions.md` and writes
 * the files. On a rebase that brings the old file back, check out main's
 * copy, run the split again, and delete the old file. The script overwrites
 * only ids present in that file. Hand-added ids stay.
 *
 * `scripts/decisions-index.ts` rewrites `INDEX.md` from the files on disk.
 * `scripts/decision.ts` prints one record, or the next free number.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Directory of decision files, relative to the repository root. */
export const DECISIONS_DIR = "docs/decisions";

/** Generated index, relative to the repository root. */
export const DECISIONS_INDEX = "docs/decisions/INDEX.md";

/** Hand-kept template. The split does not overwrite it. */
export const DECISIONS_TEMPLATE = "docs/decisions/_template.md";

/** Notes tail copied out of the old file. */
export const DECISIONS_NOTES = "docs/decisions/notes.md";

/** Old single file. The split reads it. Nothing else should. */
export const LEGACY_DECISIONS = "docs/okmodel-decisions.md";

/** Closed set of area tags the index prints. */
export const DECISION_AREAS = [
  "contracts",
  "dialects",
  "adapters",
  "runtime",
  "tooling",
  "ci",
  "docs",
  "product",
] as const;

export type DecisionArea = (typeof DECISION_AREAS)[number];

/** Status stored in the header. The body is not edited to say this. */
export type DecisionStatus =
  | { readonly kind: "accepted" }
  | { readonly kind: "historical" }
  | { readonly kind: "superseded"; readonly by: string };

/** One decision record, header plus the original decision cell. */
export type DecisionRecord = {
  readonly id: string;
  readonly title: string;
  readonly status: DecisionStatus;
  readonly areas: readonly DecisionArea[];
  readonly supersedes: readonly string[];
  readonly body: string;
};

/**
 * Pairs the prose does not state as `Superseded by`, but the record is.
 *
 * D120 says `Supersedes the D25`. The parser reads that. This map is the
 * check that those two pairs stay visible if the wording shifts.
 */
export const SUPERSEDED_BY: Readonly<Record<string, string>> = {
  D25: "D120",
  D67: "D91",
};

/**
 * Records that are no longer the rule and have no successor id.
 *
 * D151, D212, and D213 are the CI records whose later status replaced them.
 * The other eight are unreferenced train logs: a step's byte count and a
 * gate move, cited from nowhere outside the old file.
 */
export const HISTORICAL_IDS: readonly string[] = [
  "D136",
  "D151",
  "D157",
  "D162",
  "D163",
  "D164",
  "D166",
  "D175",
  "D177",
  "D212",
  "D213",
];

const ID_FILE = /^(D\d+[a-z]?)\.md$/;
const ID_TEXT = /^D(\d+)([a-z]?)$/;
const SUPERSEDED_PROSE = /Superseded by (D\d+[a-z]?)/g;
const SUPERSEDES_PROSE = /Supersedes (?:the )?(D\d+[a-z]?)/g;

const AREA_RULES: readonly (readonly [DecisionArea, RegExp])[] = [
  ["ci", /\b(CI|GitHub|workflow|pull request|release run|Actions)\b/],
  ["docs", /\b(docs?|spec|README|decision)\b/i],
  ["adapters", /\b(driver|adapter|postgres\.js|PGlite|Neon)\b/],
  ["tooling", /\b(okm\b|migrate|doctor|lint|CLI|seed|provision|generate)\b/i],
  ["runtime", /\b(query|connect|transaction|replica|routing|client|batch|tenancy)\b/i],
  ["dialects", /\b(column|type|extension|enum|view|function|trigger|policy|index|SQL|DDL)\b/],
  ["contracts", /\b(catalog|error|hash)\b/i],
];

/**
 * One row of the old decisions table.
 */
export type LegacyRow = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
};

/**
 * Splits a markdown table row on unescaped `|`. `\|` stays in the cell.
 *
 * @param line - One physical line
 * @returns Cells, including the empty cells from the leading and trailing pipes
 */
export function splitTableRow(line: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") {
      current += "\\|";
      index += 1;
      continue;
    }
    if (char === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Drops the single space a markdown table puts inside each cell.
 *
 * @param cell - Raw cell, including the padding space
 */
function unpad(cell: string): string {
  let text = cell;
  if (text.startsWith(" ")) text = text.slice(1);
  if (text.endsWith(" ")) text = text.slice(0, -1);
  return text;
}

/**
 * Topic cell as a heading. Table escapes become the character they stand for.
 *
 * @param cell - Raw topic cell
 */
function titleFromCell(cell: string): string {
  return unpad(cell).replaceAll("\\|", "|");
}

/**
 * Reads decision rows from the old single file.
 *
 * @param text - `docs/okmodel-decisions.md`
 * @returns Rows in file order, and problem lines for rows that do not parse
 */
export function parseLegacyDecisions(text: string): {
  readonly rows: readonly LegacyRow[];
  readonly problems: readonly string[];
} {
  const rows: LegacyRow[] = [];
  const problems: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("|")) continue;
    const parts = splitTableRow(line);
    if ((parts[0] ?? "") !== "" || (parts[parts.length - 1] ?? "") !== "") continue;
    const id = unpad(parts[1] ?? "");
    if (!ID_TEXT.test(id)) continue;
    if (parts.length < 5) {
      problems.push(`line ${String(index + 1)}: ${id} does not have three cells`);
      continue;
    }
    rows.push({
      id,
      title: titleFromCell(parts[2] ?? ""),
      body: unpad(parts.slice(3, -1).join("|")),
    });
  }
  return { rows, problems };
}

/**
 * Area tags for a topic. The first matching rules win. None means `product`.
 *
 * @param topic - Decision title
 */
export function areasForTopic(topic: string): readonly DecisionArea[] {
  const found: DecisionArea[] = [];
  for (const [area, pattern] of AREA_RULES) {
    if (pattern.test(topic)) found.push(area);
  }
  return found.length > 0 ? found : ["product"];
}

/**
 * Who supersedes whom, from the explicit pairs and from the decision text.
 *
 * @param rows - Parsed legacy rows
 * @returns Problems when a pair is claimed twice with different successors
 */
export function supersessionMap(rows: readonly LegacyRow[]): {
  readonly bySuccessor: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
} {
  const bySuccessor = new Map<string, string>();
  const problems: string[] = [];
  const present = new Set(rows.map((row) => row.id));
  const claim = (id: string, successor: string, where: string): void => {
    const existing = bySuccessor.get(id);
    if (existing !== undefined && existing !== successor) {
      problems.push(`${id} is superseded by ${existing} and by ${successor} (${where})`);
      return;
    }
    bySuccessor.set(id, successor);
  };
  for (const [id, successor] of Object.entries(SUPERSEDED_BY)) {
    if (present.has(id) || present.has(successor)) claim(id, successor, "inventory");
  }
  for (const row of rows) {
    SUPERSEDED_PROSE.lastIndex = 0;
    for (const match of row.body.matchAll(SUPERSEDED_PROSE)) {
      const successor = match[1];
      if (successor !== undefined) claim(row.id, successor, row.id);
    }
    SUPERSEDES_PROSE.lastIndex = 0;
    for (const match of row.body.matchAll(SUPERSEDES_PROSE)) {
      const prior = match[1];
      if (prior !== undefined) claim(prior, row.id, row.id);
    }
  }
  return { bySuccessor, problems };
}

/**
 * Header status line.
 *
 * @param status - Parsed or assigned status
 */
export function statusText(status: DecisionStatus): string {
  if (status.kind === "superseded") return `superseded by ${status.by}`;
  return status.kind;
}

/**
 * Assigns status and supersedes links for one parsed table.
 *
 * @param rows - Legacy rows
 */
export function recordsFromLegacy(rows: readonly LegacyRow[]): {
  readonly records: readonly DecisionRecord[];
  readonly problems: readonly string[];
} {
  const { bySuccessor, problems } = supersessionMap(rows);
  const historical = new Set(HISTORICAL_IDS);
  const present = new Set(rows.map((row) => row.id));
  const next = [...problems];
  for (const [id, successor] of bySuccessor) {
    if (!present.has(id)) next.push(`${id} is superseded by ${successor} but is not in the table`);
    if (!present.has(successor))
      next.push(`${id} is superseded by ${successor}, which is not in the table`);
  }
  const supersedes = new Map<string, string[]>();
  for (const [id, successor] of bySuccessor) {
    const list = supersedes.get(successor) ?? [];
    list.push(id);
    supersedes.set(successor, list);
  }
  const records: DecisionRecord[] = rows.map((row) => {
    const successor = bySuccessor.get(row.id);
    const status: DecisionStatus =
      successor !== undefined
        ? { kind: "superseded", by: successor }
        : historical.has(row.id)
          ? { kind: "historical" }
          : { kind: "accepted" };
    const prior = supersedes.get(row.id) ?? [];
    return {
      id: row.id,
      title: row.title,
      status,
      areas: areasForTopic(row.title),
      supersedes: [...prior].sort(compareDecisionIds),
      body: rebaseRelativeLinks(row.body),
    };
  });
  return { records, problems: next };
}

/**
 * Points a relative link one directory up.
 *
 * Decision files live in `docs/decisions/`. The old file lived in `docs/`.
 * The cell text is otherwise unchanged.
 *
 * @param body - Decision cell
 */
export function rebaseRelativeLinks(body: string): string {
  return body.replace(/\]\(([^)]+)\)/g, (full, url: string) => {
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(url) ||
      url.startsWith("#") ||
      url.startsWith("/") ||
      url.startsWith("../") ||
      url.startsWith("./")
    ) {
      return full;
    }
    return `](../${url})`;
  });
}

/**
 * Renders one decision file. The body is the original cell, plus the link rebase.
 *
 * @param record - Decision to write
 */
export function renderDecision(record: DecisionRecord): string {
  const supersedes = record.supersedes.length === 0 ? "none" : record.supersedes.join(", ");
  return [
    `# ${record.id} — ${record.title}`,
    "",
    `- **Status:** ${statusText(record.status)}`,
    `- **Area:** ${record.areas.join(", ")}`,
    `- **Supersedes:** ${supersedes}`,
    "",
    "---",
    "",
    record.body,
    "",
  ].join("\n");
}

/**
 * Parses a decision file written by {@link renderDecision}.
 *
 * @param text - File contents
 * @param where - Path printed in problems
 */
export function parseDecisionFile(
  text: string,
  where: string,
): { readonly record?: DecisionRecord; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const splitAt = text.indexOf("\n---\n");
  if (splitAt === -1) return { problems: [`${where}: missing header rule`] };
  const header = text.slice(0, splitAt);
  let body = text.slice(splitAt + "\n---\n".length);
  if (body.startsWith("\n")) body = body.slice(1);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  const lines = header.split("\n");
  const heading = lines[0] ?? "";
  const headingMatch = /^# (D\d+[a-z]?) — (.*)$/.exec(heading);
  if (headingMatch?.[1] === undefined || headingMatch[2] === undefined) {
    return { problems: [`${where}: heading is not '# D### — title'`] };
  }
  const id = headingMatch[1];
  const title = headingMatch[2];
  const statusLine = lines[2] ?? "";
  const areaLine = lines[3] ?? "";
  const supersedesLine = lines[4] ?? "";
  if (lines[1] !== "") problems.push(`${where}: header is not separated`);
  const statusMatch = /^- \*\*Status:\*\* (accepted|historical|superseded by (D\d+[a-z]?))$/.exec(
    statusLine,
  );
  if (statusMatch === null) problems.push(`${where}: status line does not parse`);
  const areaMatch = /^- \*\*Area:\*\* (\S.*)$/.exec(areaLine);
  if (areaMatch?.[1] === undefined) problems.push(`${where}: area line does not parse`);
  const supersedesMatch = /^- \*\*Supersedes:\*\* (\S.*)$/.exec(supersedesLine);
  if (supersedesMatch?.[1] === undefined) problems.push(`${where}: supersedes line does not parse`);
  if (problems.length > 0 || statusMatch === null || areaMatch?.[1] === undefined) {
    return { problems };
  }
  const areas = areaMatch[1].split(", ").filter((area) => area.length > 0);
  const known = new Set<string>(DECISION_AREAS);
  for (const area of areas) {
    if (!known.has(area)) problems.push(`${where}: unknown area ${area}`);
  }
  let status: DecisionStatus;
  if (statusMatch[1] === "accepted") status = { kind: "accepted" };
  else if (statusMatch[1] === "historical") status = { kind: "historical" };
  else if (statusMatch[2] !== undefined) status = { kind: "superseded", by: statusMatch[2] };
  else status = { kind: "accepted" };
  const supersedes =
    supersedesMatch?.[1] === "none"
      ? []
      : (supersedesMatch?.[1] ?? "").split(", ").filter((item) => item.length > 0);
  for (const prior of supersedes) {
    if (!ID_TEXT.test(prior)) problems.push(`${where}: supersedes ${prior} is not an id`);
  }
  if (problems.length > 0) return { problems };
  return {
    record: {
      id,
      title,
      status,
      areas: areas as DecisionArea[],
      supersedes,
      body,
    },
    problems,
  };
}

/**
 * Numeric order, then a letter suffix. `D16` comes before `D16a`.
 *
 * @param left - Decision id
 * @param right - Decision id
 */
export function compareDecisionIds(left: string, right: string): number {
  const a = ID_TEXT.exec(left);
  const b = ID_TEXT.exec(right);
  const an = Number(a?.[1] ?? 0);
  const bn = Number(b?.[1] ?? 0);
  if (an !== bn) return an - bn;
  return (a?.[2] ?? "").localeCompare(b?.[2] ?? "");
}

/**
 * The smallest id that is not on disk. Letter suffixes do not consume a number.
 *
 * @param ids - Known decision ids
 */
export function nextDecisionId(ids: readonly string[]): string {
  let max = 0;
  for (const id of ids) {
    const match = ID_TEXT.exec(id);
    const value = Number(match?.[1] ?? 0);
    if (value > max) max = value;
  }
  return `D${String(max + 1)}`;
}

/**
 * Index page. One row per decision.
 *
 * @param records - Records to list
 */
export function renderIndex(records: readonly DecisionRecord[]): string {
  const lines = [
    "# Decision index",
    "",
    "Generated by `bun run decisions:index`. Do not edit.",
    "",
    "| # | Title | Status | Area |",
    "| --- | --- | --- | --- |",
  ];
  const ordered = [...records].sort((left, right) => compareDecisionIds(left.id, right.id));
  for (const record of ordered) {
    const title = record.title.replaceAll("|", "\\|");
    lines.push(
      `| [${record.id}](${record.id}.md) | ${title} | ${statusText(record.status)} | ${record.areas.join(", ")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Decision ids named by `D*.md` files in a directory.
 *
 * @param dir - Directory that holds the files. Missing means no set
 */
export function decisionIdsIn(dir: string): ReadonlySet<string> | undefined {
  if (!existsSync(dir)) return undefined;
  const ids = new Set<string>();
  for (const name of readdirSync(dir)) {
    const id = ID_FILE.exec(name)?.[1];
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/**
 * Loads every `D*.md` under `docs/decisions/`.
 *
 * @param root - Repository root
 */
export function loadDecisionRecords(root: string): {
  readonly records: readonly DecisionRecord[];
  readonly problems: readonly string[];
} {
  const dir = join(root, DECISIONS_DIR);
  const names = decisionIdsIn(dir);
  if (names === undefined) return { records: [], problems: [`missing ${DECISIONS_DIR}`] };
  const records: DecisionRecord[] = [];
  const problems: string[] = [];
  for (const id of names) {
    const where = `${DECISIONS_DIR}/${id}.md`;
    const parsed = parseDecisionFile(readFileSync(join(dir, `${id}.md`), "utf8"), where);
    problems.push(...parsed.problems);
    if (parsed.record === undefined) continue;
    if (parsed.record.id !== id) {
      problems.push(`${where}: heading ${parsed.record.id} does not match the file name`);
    }
    records.push(parsed.record);
  }
  return { records, problems };
}

/**
 * Ids are unique, numeric ids run from D1 with no gap, and supersedes links meet.
 *
 * @param records - Loaded records
 */
export function structureProblems(records: readonly DecisionRecord[]): readonly string[] {
  const problems: string[] = [];
  const byId = new Map<string, DecisionRecord>();
  const numbers: number[] = [];
  for (const record of records) {
    if (byId.has(record.id)) problems.push(`duplicate ${record.id}`);
    byId.set(record.id, record);
    const match = ID_TEXT.exec(record.id);
    if (match?.[1] === undefined) {
      problems.push(`bad id ${record.id}`);
      continue;
    }
    if ((match[2] ?? "") === "") numbers.push(Number(match[1]));
  }
  const unique = [...new Set(numbers)].sort((left, right) => left - right);
  if (unique.length !== numbers.length) problems.push("duplicate numeric decision ids");
  for (let index = 0; index < unique.length; index += 1) {
    if (unique[index] !== index + 1) {
      problems.push(`missing D${String(index + 1)}`);
      break;
    }
  }
  for (const record of records) {
    if (record.status.kind === "superseded") {
      const successor = byId.get(record.status.by);
      if (successor === undefined) {
        problems.push(`${record.id} is superseded by ${record.status.by}, which has no file`);
      } else if (!successor.supersedes.includes(record.id)) {
        problems.push(`${record.status.by} does not supersede ${record.id}`);
      }
    }
    for (const prior of record.supersedes) {
      const target = byId.get(prior);
      if (target === undefined) {
        problems.push(`${record.id} supersedes ${prior}, which has no file`);
        continue;
      }
      if (target.status.kind !== "superseded" || target.status.by !== record.id) {
        problems.push(`${prior} is not superseded by ${record.id}`);
      }
    }
  }
  return problems;
}

/**
 * The committed index matches {@link renderIndex}.
 *
 * @param root - Repository root
 * @param records - Loaded records
 */
export function indexProblems(root: string, records: readonly DecisionRecord[]): readonly string[] {
  const path = join(root, DECISIONS_INDEX);
  if (!existsSync(path)) return [`missing ${DECISIONS_INDEX}`];
  const committed = readFileSync(path, "utf8");
  const generated = renderIndex(records);
  if (committed !== generated) {
    return [`${DECISIONS_INDEX} is stale. Run bun run decisions:index.`];
  }
  return [];
}

/**
 * Every decision cited from `docs/rules.md` exists and is still in force.
 *
 * Superseded and historical records are not rules.
 *
 * @param root - Repository root
 * @param records - Loaded records
 */
export function rulesProblems(root: string, records: readonly DecisionRecord[]): readonly string[] {
  const path = join(root, "docs/rules.md");
  if (!existsSync(path)) return ["missing docs/rules.md"];
  const text = readFileSync(path, "utf8");
  const byId = new Map(records.map((record) => [record.id, record]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\b(D\d+[a-z]?)\b/g)) {
    const id = match[1];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const record = byId.get(id);
    if (record === undefined) {
      problems.push(`docs/rules.md cites ${id}, which has no decision file`);
      continue;
    }
    if (record.status.kind === "superseded") {
      problems.push(`docs/rules.md cites ${id}, superseded by ${record.status.by}`);
    } else if (record.status.kind === "historical") {
      problems.push(`docs/rules.md cites ${id}, which is historical`);
    }
  }
  return problems;
}

/**
 * Every `D###` cited under `src/` has a decision file.
 *
 * @param root - Repository root
 * @param records - Loaded records
 */
export function sourceCitationProblems(
  root: string,
  records: readonly DecisionRecord[],
): readonly string[] {
  const ids = new Set(records.map((record) => record.id));
  const problems: string[] = [];
  const files = walkTypeScript(join(root, "src"));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const seen = new Set<string>();
    for (const match of text.matchAll(/\b(D\d+[a-z]?)\b/g)) {
      const id = match[1];
      if (id === undefined || seen.has(id) || ids.has(id)) continue;
      seen.add(id);
      problems.push(`${file.slice(root.length + 1)} cites ${id}, which has no decision file`);
    }
  }
  return problems;
}

function walkTypeScript(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScript(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/**
 * Writes `INDEX.md` from the files on disk.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when the file was written
 */
export function writeDecisionIndex(root: string): readonly string[] {
  const loaded = loadDecisionRecords(root);
  if (loaded.problems.length > 0) return loaded.problems;
  writeFileSync(join(root, DECISIONS_INDEX), renderIndex(loaded.records));
  return [];
}

/**
 * Tail of the old file that is not a decision row: the Neon notes and the M0 appendix.
 *
 * @param text - Old file
 */
export function legacyNotes(text: string): string {
  const at = text.indexOf("\n## ");
  if (at === -1) return "";
  return text.slice(at + 1);
}

/**
 * Splits the old file into one file per decision and refreshes the index.
 *
 * Does not delete the old file. A rebase checks main's copy out, runs this,
 * then deletes it.
 *
 * @param root - Repository root
 */
export function splitDecisions(root: string): readonly string[] {
  const sourcePath = join(root, LEGACY_DECISIONS);
  if (!existsSync(sourcePath)) {
    return [`split-decisions: missing ${LEGACY_DECISIONS}`];
  }
  const text = readFileSync(sourcePath, "utf8");
  const parsed = parseLegacyDecisions(text);
  const built = recordsFromLegacy(parsed.rows);
  const present = new Set(parsed.rows.map((row) => row.id));
  const problems = [...parsed.problems, ...built.problems];
  for (const id of HISTORICAL_IDS) {
    if (!present.has(id))
      problems.push(`historical inventory names ${id}, which is not in the table`);
  }
  for (const [id, successor] of Object.entries(SUPERSEDED_BY)) {
    if (!present.has(id) || !present.has(successor)) {
      problems.push(`inventory pair ${id} superseded by ${successor} is not both in the table`);
    }
  }
  if (problems.length > 0) return problems;
  const dir = join(root, DECISIONS_DIR);
  mkdirSync(dir, { recursive: true });
  for (const record of built.records) {
    writeFileSync(join(dir, `${record.id}.md`), renderDecision(record));
  }
  const notes = legacyNotes(text);
  if (notes.length > 0) {
    writeFileSync(
      join(root, DECISIONS_NOTES),
      [
        "# Notes",
        "",
        "The sections below are the tail of `okmodel-decisions.md`, unchanged.",
        "",
        notes,
      ].join("\n"),
    );
  }
  return writeDecisionIndex(root);
}
