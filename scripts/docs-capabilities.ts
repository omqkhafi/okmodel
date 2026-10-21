/**
 * Writes `docs/capabilities.md` from the Postgres feature registry, and
 * checks support blocks and the migration step table.
 *
 * Proof status is `registryProblems` against the literal test titles in
 * `tests/` and `packages/harness`. A feature whose proof does not pass that
 * check is `unverified`. The page does not call it native.
 *
 *   bun ./scripts/docs-capabilities.ts
 *   bun ./scripts/docs-capabilities.ts --check
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  POSTGRES_FEATURES,
  collectTestTitles,
  registryProblems,
  type FeatureEntry,
  type Registry,
} from "../src/tooling/capabilities/index.js";
import { STEP_KINDS, classOf, isStepKind, type StepKind } from "../src/tooling/migrate/classify.js";
import { postgresHasProbe } from "../src/tooling/migrate/pg-probe.js";
import { statementOutsideTransaction } from "../src/tooling/migrate/runner.js";
import { unitMode } from "../src/tooling/migrate/step-engine.js";
import { committedDocVersion } from "./docs-pack.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Planner sources that pass `transactional: false` into a step. */
const EMISSION_FILES = [
  "src/dialects/pg/lower.ts",
  "src/dialects/pg/table-safe.ts",
  "src/tooling/migrate/safe.ts",
] as const;

const STEP_OPEN = "<!-- steps -->";
const STEP_CLOSE = "<!-- /steps -->";

/** One generated row of the migration step table. */
export type StepDocRow = {
  readonly kind: string;
  readonly transactional: string;
  readonly probe: string;
  readonly resume: string;
  readonly code: string;
};

/**
 * Literal test titles the registry proof check reads.
 *
 * Same roots as `tests/capability-registry.test.ts`.
 *
 * @param root - Repository root
 * @returns Titles
 */
export function proofTitles(root: string): ReadonlySet<string> {
  return collectTestTitles([join(root, "tests"), join(root, "packages/harness")]);
}

/**
 * Whether `registryProblems` accepts this one entry.
 *
 * @param key - Registry key
 * @param entry - The entry
 * @param titles - Literal test titles
 * @returns `true` when the proof title passes the existing check
 */
export function proofPasses(
  key: string,
  entry: FeatureEntry,
  titles: ReadonlySet<string>,
): boolean {
  return registryProblems({ [key]: entry }, titles).length === 0;
}

/**
 * Support cell. Unproved entries are `unverified`, never `native`.
 *
 * @param entry - Registry entry
 * @param proved - Result of {@link proofPasses}
 * @returns The cell text
 */
export function supportLabel(entry: FeatureEntry, proved: boolean): string {
  if (!proved) return "unverified";
  if (entry.support === "native") return "native";
  if (entry.support === "emulated") {
    if (entry.cost === undefined || entry.cost.length === 0) return "emulated";
    return `emulated. ${trimPeriod(entry.cost)}`;
  }
  const alternative = trimPeriod(entry.alternative ?? "");
  const code = entry.code ?? "";
  return `refused. ${alternative} (${code})`;
}

/**
 * One-line support block placed between markers.
 *
 * @param entry - Registry entry
 * @param titles - Literal test titles
 * @param key - Registry key, for the proof check
 * @returns The line, without a trailing newline
 */
export function renderSupportLine(
  key: string,
  entry: FeatureEntry,
  titles: ReadonlySet<string>,
): string {
  const proved = proofPasses(key, entry, titles);
  if (!proved) {
    return `Postgres: unverified. Proof \`${entry.proof}\` is not a passing title.`;
  }
  const parts = [supportLabel(entry, true)];
  if (entry.support === "native" && entry.cost !== undefined && entry.cost.length > 0) {
    parts.push(`Cost: ${entry.cost}`);
  }
  if (entry.since !== undefined && entry.since.length > 0) parts.push(`Since ${entry.since}`);
  return `Postgres: ${parts.join(". ")}. Proof passes (\`${entry.proof}\`).`;
}

/**
 * Marker plus the generated line for one feature.
 *
 * @param key - Registry key
 * @param root - Repository root
 * @returns The block, ending in a newline
 */
export function supportRegion(key: string, root: string): string {
  const entry = featureEntry(key);
  if (entry === undefined) throw new Error(`docs-capabilities: unknown feature ${key}`);
  const line = renderSupportLine(key, entry, proofTitles(root));
  return `<!-- support: ${key} -->\n${line}\n<!-- /support -->\n`;
}

/**
 * Renders `docs/capabilities.md`.
 *
 * @param input - Version, registry, and the suite titles
 * @returns The page, ending in a newline
 */
export function renderCapabilitiesPage(input: {
  readonly version: string;
  readonly registry: Registry;
  readonly titles: ReadonlySet<string>;
}): string {
  const train = committedDocVersion(input.version);
  const codes = provedCodes(input.registry, input.titles);
  const lines: string[] = [
    "---",
    `okmVersion: "${train}"`,
    'since: "0.10"',
    "dialects: [postgres]",
    codes.length === 0 ? "codes: []" : `codes: [${codes.join(", ")}]`,
    "---",
    "# Capabilities",
    "",
    "Postgres feature support, generated from `POSTGRES_FEATURES`. One dialect. There is no dialect switcher.",
    "",
    "A row is `native`, `emulated` (with its cost), or `refused` (with the alternative and the code) only when `registryProblems` finds that entry's proof title in the suite. A feature with no passing proof is `unverified`. It is not called native.",
    "",
    "Committed step kinds are in [When a migration fails](migration-failure.md).",
    "",
    "Do not edit this file. Run `bun run docs:capabilities`.",
    "",
  ];
  for (const group of groupsOf(input.registry)) {
    lines.push(`## ${group.name}`, "");
    lines.push("| Key | Support | Since | Proof |", "| --- | --- | --- | --- |");
    for (const key of group.keys) {
      const entry = input.registry[key];
      if (entry === undefined) continue;
      const proved = proofPasses(key, entry, input.titles);
      const since = entry.since === undefined || entry.since.length === 0 ? "—" : entry.since;
      const proof = proved ? `passes (\`${entry.proof}\`)` : `unverified (\`${entry.proof}\`)`;
      lines.push(
        `| \`${key}\` | ${cell(supportLabel(entry, proved))} | ${cell(since)} | ${cell(proof)} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * One row per planner kind, in `STEP_KINDS` order.
 *
 * Transactional flags come from the statements the planner emits.
 * Probes come from `postgresHasProbe`. Resume comes from `unitMode`.
 *
 * @param root - Repository root
 * @returns The rows
 */
export function stepRows(root: string): readonly StepDocRow[] {
  const emitted = collectEmissions(root);
  const outside = statementCanLeaveTransaction();
  return STEP_KINDS.map((kind) => rowFor(kind, emitted, outside));
}

/**
 * Generated body of the step-kind table, without the marker lines.
 *
 * @param root - Repository root
 * @returns Markdown, ending in a newline
 */
export function renderStepBody(root: string): string {
  const lines = [
    "Generated from `STEP_KINDS`, `postgresHasProbe`, and `unitMode`. Do not edit by hand.",
    "",
    "| Kind | Transactional | Built-in probe | Resume | Code |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of stepRows(root)) {
    lines.push(
      `| \`${row.kind}\` | ${cell(row.transactional)} | ${cell(row.probe)} | ${cell(row.resume)} | ${cell(row.code)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Problems when a support marker does not match the registry.
 *
 * @param text - Page source
 * @param file - Path printed in each problem
 * @param registry - Dialect table
 * @param titles - Literal test titles
 * @returns Problem lines
 */
export function supportMarkerProblems(
  text: string,
  file: string,
  registry: Registry,
  titles: ReadonlySet<string>,
): readonly string[] {
  const problems: string[] = [];
  const spans = fenceSpans(text);
  const tokens = markerTokens(text, spans);
  let open: { readonly key: string; readonly bodyFrom: number } | undefined;
  for (const token of tokens) {
    if (token.kind === "start") {
      if (open !== undefined) {
        problems.push(
          `docs-capabilities: ${file} support marker for ${open.key} has no closing marker`,
        );
      }
      open = { key: token.key, bodyFrom: token.end };
      continue;
    }
    if (open === undefined) {
      problems.push(`docs-capabilities: ${file} has a closing support marker without a feature`);
      continue;
    }
    const key = open.key;
    const body = text.slice(open.bodyFrom, token.start);
    open = undefined;
    const entry = registry[key];
    if (entry === undefined) {
      problems.push(`docs-capabilities: ${file} names unknown feature ${key}`);
      continue;
    }
    const expected = `\n${renderSupportLine(key, entry, titles)}\n`;
    if (body !== expected) {
      problems.push(
        `docs-capabilities: ${file} support block for ${key} does not match the registry. Run bun ./scripts/docs-capabilities.ts`,
      );
    }
  }
  if (open !== undefined) {
    problems.push(
      `docs-capabilities: ${file} support marker for ${open.key} has no closing marker`,
    );
  }
  return problems;
}

/**
 * Stale capabilities page, support blocks, and the step table.
 *
 * @param root - Repository root
 * @returns Problem lines
 */
export function capabilityDocProblems(root: string): readonly string[] {
  const problems: string[] = [];
  const version = packageVersion(root);
  const titles = proofTitles(root);
  const page = join(root, "docs/capabilities.md");
  let actual: string;
  try {
    actual = readFileSync(page, "utf8");
  } catch {
    actual = "";
  }
  const expected = renderCapabilitiesPage({ version, registry: POSTGRES_FEATURES, titles });
  if (actual !== expected) {
    problems.push(
      "docs-capabilities: docs/capabilities.md is stale. Run bun ./scripts/docs-capabilities.ts",
    );
  }
  problems.push(...stepTableProblems(root));
  for (const file of markdownFiles(join(root, "docs"))) {
    const text = readFileSync(file, "utf8");
    const where = relative(root, file).split("\\").join("/");
    problems.push(...supportMarkerProblems(text, where, POSTGRES_FEATURES, titles));
  }
  return problems;
}

/**
 * Writes the capabilities page and refreshes generated blocks.
 *
 * @param root - Repository root
 */
export function writeCapabilityDocs(root: string): void {
  const titles = proofTitles(root);
  const version = packageVersion(root);
  const page = renderCapabilitiesPage({ version, registry: POSTGRES_FEATURES, titles });
  writeFileSync(join(root, "docs/capabilities.md"), page);
  const stepBody = renderStepBody(root);
  for (const file of markdownFiles(join(root, "docs"))) {
    const text = readFileSync(file, "utf8");
    const next = fillGenerated(text, titles, stepBody);
    if (next !== text) writeFileSync(file, next);
  }
}

function fillGenerated(text: string, titles: ReadonlySet<string>, stepBody: string): string {
  const spans = fenceSpans(text);
  let next = text;
  const tokens = markerTokens(text, spans);
  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] =
    [];
  let open: { readonly key: string; readonly from: number } | undefined;
  for (const token of tokens) {
    if (token.kind === "start") {
      open = { key: token.key, from: token.start };
      continue;
    }
    if (open === undefined) continue;
    const entry = featureEntry(open.key);
    if (entry !== undefined) {
      const line = renderSupportLine(open.key, entry, titles);
      replacements.push({
        start: open.from,
        end: token.end,
        text: `<!-- support: ${open.key} -->\n${line}\n<!-- /support -->`,
      });
    }
    open = undefined;
  }
  for (const replacement of replacements.reverse()) {
    next = `${next.slice(0, replacement.start)}${replacement.text}${next.slice(replacement.end)}`;
  }
  const stepAt = next.indexOf(STEP_OPEN);
  const stepEnd = next.indexOf(STEP_CLOSE);
  if (stepAt !== -1 && stepEnd !== -1 && stepEnd > stepAt) {
    const closeAt = stepEnd + STEP_CLOSE.length;
    const block = `${STEP_OPEN}\n${stepBody}${STEP_CLOSE}`;
    next = `${next.slice(0, stepAt)}${block}${next.slice(closeAt)}`;
  }
  return next;
}

function stepTableProblems(root: string): readonly string[] {
  const path = join(root, "docs/migration-failure.md");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return ["docs-capabilities: docs/migration-failure.md is missing"];
  }
  const open = text.indexOf(STEP_OPEN);
  const close = text.indexOf(STEP_CLOSE);
  if (open === -1 || close === -1 || close < open) {
    return [
      "docs-capabilities: docs/migration-failure.md has no step table. Run bun ./scripts/docs-capabilities.ts",
    ];
  }
  const body = text.slice(open + STEP_OPEN.length, close);
  const expected = `\n${renderStepBody(root)}`;
  if (body !== expected) {
    return [
      "docs-capabilities: docs/migration-failure.md step table is stale. Run bun ./scripts/docs-capabilities.ts",
    ];
  }
  return [];
}

function rowFor(kind: StepKind, emitted: Emissions, outside: boolean): StepDocRow {
  const seen = emitted.kinds.get(kind);
  const backfill = kind.startsWith("backfill-") && (emitted.dynamicBackfill || seen?.no === true);
  const unclassified = classOf(kind) === "unclassified";
  const transactional = transactionalOf(seen, backfill, unclassified, outside);
  const probe = probeOf(kind);
  return {
    kind,
    transactional,
    probe,
    resume: resumeOf(kind, transactional, probe, backfill),
    code: codesOf(transactional, probe, backfill),
  };
}

function transactionalOf(
  seen: KindEmission | undefined,
  backfill: boolean,
  unclassified: boolean,
  outside: boolean,
): string {
  if (backfill) return "no";
  if (unclassified) {
    return outside ? "yes, unless the statement cannot share a transaction" : "yes";
  }
  if (seen === undefined || (!seen.yes && !seen.no)) return "yes";
  if (seen.no && seen.concurrentNo && !seen.plainNo) return "no when CONCURRENTLY";
  if (seen.no && !seen.yes) return "no";
  if (seen.no && seen.yes) return "no for the non-transactional form";
  return "yes";
}

function probeOf(kind: string): string {
  if (postgresHasProbe(kind, "select 1")) return "yes";
  const concurrent =
    postgresHasProbe(kind, "create index concurrently i on t (id)") ||
    postgresHasProbe(kind, "drop index concurrently i");
  return concurrent ? "when CONCURRENTLY" : "no";
}

function resumeOf(kind: string, transactional: string, probe: string, backfill: boolean): string {
  if (backfill) return backfillResume();
  if (transactional.startsWith("yes, unless")) {
    return "rolls back when the statement can share a transaction; a concurrent index follows the probe; any other committed statement stops until a declared probe or a person marks retry";
  }
  if (transactional === "no when CONCURRENTLY") {
    if (kind === "create-index") {
      return "a plain statement rolls back; CONCURRENTLY follows the probe, and partial drops the index and rebuilds";
    }
    return "a plain statement rolls back; CONCURRENTLY follows the probe";
  }
  if (transactional === "yes" && probe === "no") {
    return "rolls back with the history row; the next apply runs the step again";
  }
  if (transactional === "yes" && probe === "yes") {
    return "rolls back with the history row; a committed copy follows the probe";
  }
  if (probe === "yes") {
    return "follows the probe: applied writes history, absent runs the statement, unknown stops";
  }
  if (transactional === "no") return "stops until a declared probe or a person marks retry";
  return "rolls back with the history row; the next apply runs the step again";
}

function codesOf(transactional: string, probe: string, backfill: boolean): string {
  if (backfill) return "—";
  if (transactional === "yes" && probe === "no") return "—";
  if (transactional === "yes" && probe === "yes") return "OKM1553";
  if (transactional === "no when CONCURRENTLY") return "OKM1553, OKM1556";
  if (transactional.startsWith("yes, unless")) return "OKM1553, OKM1556, OKM1557";
  if (transactional === "no" && probe === "yes") return "OKM1553, OKM1556";
  if (transactional === "no") return "OKM1553, OKM1556, OKM1557";
  return "—";
}

function backfillResume(): string {
  const mode = unitMode({
    transactional: false,
    steps: [{ step: { backfill: {} } }],
  });
  if (mode === "transactional")
    return "continues from the last key in okm_backfill; no okm_steps row";
  return "continues from the last key in okm_backfill";
}

function statementCanLeaveTransaction(): boolean {
  return (
    statementOutsideTransaction("vacuum analyze t") ||
    statementOutsideTransaction("alter type t add value 'a'") ||
    statementOutsideTransaction("create index concurrently i on t (id)") ||
    statementOutsideTransaction("drop index concurrently i")
  );
}

type KindEmission = {
  yes: boolean;
  no: boolean;
  concurrentNo: boolean;
  plainNo: boolean;
};

type Emissions = {
  readonly kinds: ReadonlyMap<string, KindEmission>;
  readonly dynamicBackfill: boolean;
};

function collectEmissions(root: string): Emissions {
  const kinds = new Map<string, KindEmission>();
  let dynamicBackfill = false;
  for (const rel of EMISSION_FILES) {
    const source = readFileSync(join(root, rel), "utf8");
    for (const call of findCalls(source, "ddlStep")) {
      const args = splitArgs(call);
      const kindArg = args[1] ?? "";
      const transactional = (args[4] ?? "true").trim();
      const named = /^"([a-z0-9-]+)"$/.exec(kindArg.trim());
      const isFalse = transactional === "false";
      const concurrent = call.includes("concurrent");
      if (named !== null && named[1] !== undefined && isStepKind(named[1])) {
        note(kinds, named[1], !isFalse, isFalse, concurrent);
      } else if (isFalse && (args[2] ?? "").includes("backfill")) {
        dynamicBackfill = true;
      }
    }
    for (const found of objectFlags(source)) {
      if (!isStepKind(found.kind)) continue;
      note(kinds, found.kind, found.transactional, !found.transactional, found.concurrent);
    }
  }
  return { kinds, dynamicBackfill };
}

function note(
  kinds: Map<string, KindEmission>,
  kind: string,
  yes: boolean,
  no: boolean,
  concurrent: boolean,
): void {
  const current = kinds.get(kind) ?? { yes: false, no: false, concurrentNo: false, plainNo: false };
  kinds.set(kind, {
    yes: current.yes || yes,
    no: current.no || no,
    concurrentNo: current.concurrentNo || (no && concurrent),
    plainNo: current.plainNo || (no && !concurrent),
  });
}

function objectFlags(source: string): readonly {
  readonly kind: string;
  readonly transactional: boolean;
  readonly concurrent: boolean;
}[] {
  const found: { kind: string; transactional: boolean; concurrent: boolean }[] = [];
  const pattern = /transactional:\s*(true|false)/g;
  for (const match of source.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) continue;
    const window = source.slice(Math.max(0, index - 500), index);
    const kinds = [...window.matchAll(/kind:\s*"([a-z0-9-]+)"/g)];
    const last = kinds.at(-1);
    const kind = last?.[1];
    if (kind === undefined) continue;
    const flag = match[1] === "true";
    found.push({ kind, transactional: flag, concurrent: window.includes("concurrent") });
  }
  return found;
}

function findCalls(source: string, name: string): readonly string[] {
  const calls: string[] = [];
  const needle = `${name}(`;
  let index = 0;
  while (index < source.length) {
    const at = source.indexOf(needle, index);
    if (at === -1) break;
    const before = at === 0 ? " " : (source[at - 1] ?? " ");
    if (/[A-Za-z0-9_]/.test(before)) {
      index = at + needle.length;
      continue;
    }
    const call = readCall(source, at + name.length);
    if (call === undefined) break;
    calls.push(call);
    index = at + name.length + call.length;
  }
  return calls;
}

function readCall(source: string, openParen: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== undefined) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, index + 1);
    }
  }
  return undefined;
}

function splitArgs(call: string): readonly string[] {
  const inner = call.slice(1, -1);
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? "";
    if (quote !== undefined) {
      current += char;
      if (char === "\\") {
        current += inner[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

type MarkerToken = {
  readonly kind: "start" | "close";
  readonly key: string;
  readonly start: number;
  readonly end: number;
};

function markerTokens(
  text: string,
  spans: readonly (readonly [number, number])[],
): readonly MarkerToken[] {
  const tokens: MarkerToken[] = [];
  const pattern = /<!-- support: ([A-Za-z][\w.]*) -->|<!-- \/support -->/g;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined || enclosed(spans, index)) continue;
    const key = match[1];
    tokens.push({
      kind: key === undefined ? "close" : "start",
      key: key ?? "",
      start: index,
      end: index + match[0].length,
    });
  }
  return tokens;
}

function fenceSpans(text: string): readonly (readonly [number, number])[] {
  const spans: [number, number][] = [];
  for (const match of text.matchAll(/^```[\s\S]*?^```/gm)) {
    const index = match.index;
    if (index === undefined) continue;
    spans.push([index, index + match[0].length]);
  }
  return spans;
}

function enclosed(spans: readonly (readonly [number, number])[], index: number): boolean {
  for (const [start, end] of spans) {
    if (index >= start && index < end) return true;
  }
  return false;
}

function groupsOf(
  registry: Registry,
): readonly { readonly name: string; readonly keys: readonly string[] }[] {
  const order: string[] = [];
  const keys = new Map<string, string[]>();
  for (const key of Object.keys(registry)) {
    const name = groupName(key);
    const list = keys.get(name);
    if (list === undefined) {
      order.push(name);
      keys.set(name, [key]);
    } else {
      list.push(key);
    }
  }
  return order.map((name) => ({ name, keys: keys.get(name) ?? [] }));
}

function groupName(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

function provedCodes(registry: Registry, titles: ReadonlySet<string>): readonly string[] {
  const codes = new Set<string>();
  for (const [key, entry] of Object.entries(registry)) {
    if (!proofPasses(key, entry, titles)) continue;
    if (entry.support !== "refused" || entry.code === undefined) continue;
    if (/^OKM\d{4}$/.test(entry.code)) codes.add(entry.code);
  }
  return [...codes].sort();
}

function featureEntry(key: string): FeatureEntry | undefined {
  if (!Object.hasOwn(POSTGRES_FEATURES, key)) return undefined;
  return POSTGRES_FEATURES[key as keyof typeof POSTGRES_FEATURES];
}

function cell(value: string): string {
  return value.replaceAll("|", "/");
}

function trimPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function markdownFiles(dir: string): readonly string[] {
  const files: string[] = [];
  walk(dir, files);
  return files;
}

function walk(dir: string, files: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, files);
      continue;
    }
    if (name.endsWith(".md")) files.push(path);
  }
}

function packageVersion(root: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("docs-capabilities: package.json has no version");
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error("docs-capabilities: package.json version is not a string");
  }
  return version;
}

if (import.meta.main) {
  const root = repoRoot();
  const check = process.argv.includes("--check");
  if (check) exitOnProblems(capabilityDocProblems(root));
  else {
    writeCapabilityDocs(root);
    const problems = capabilityDocProblems(root);
    if (problems.length === 0) console.log("docs-capabilities: wrote docs/capabilities.md");
    exitOnProblems(problems);
  }
}
