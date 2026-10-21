/**
 * One page per registry code, `docs/errors/<code>.md`.
 *
 * `okm doctor <code>` prints the file. The generator and `docs:check` share
 * {@link renderErrorPage}, so a hand edit that drifts from the registry fails.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "../cli/version.js";
import { ERROR_DOCS, type ErrorDoc } from "./registry.js";

/** Executable bad/fixed pair, or a code that needs a server. */
export type PageExample =
  | { readonly kind: "pair"; readonly bad: string; readonly fixed: string }
  | { readonly kind: "database" };

const IMPERATIVE = /\b(?:you must|run|ignore previous)\b/i;
const URL = /(?:https?:\/\/|www\.)/i;

/**
 * Markdown for one code.
 *
 * @param doc - Registry entry
 * @param example - Bad/fixed pair, the database sentence, or none
 * @returns The page, ending in a newline
 */
export function renderErrorPage(doc: ErrorDoc, example?: PageExample): string {
  const lines: string[] = [
    "---",
    'okmVersion: "0.10.0"',
    'since: "0.9"',
    "dialects: [postgres]",
    `codes: [${doc.code}]`,
    "---",
    `# ${doc.code}`,
    "",
    doc.title,
    "",
    "## What happened",
    "",
    doc.summary,
    "",
    "## Fix",
    "",
    doc.fix,
    "",
  ];
  if (doc.safeAlternatives !== undefined && doc.safeAlternatives.length > 0) {
    lines.push("## Safe alternatives", "");
    for (const item of doc.safeAlternatives) lines.push(`- ${item.text}`, "");
    lines.push("## page", "");
    for (const item of doc.safeAlternatives) lines.push(item.text, "");
  }
  if (doc.escapeHatches !== undefined && doc.escapeHatches.length > 0) {
    lines.push("## Escape hatches", "", "Each hatch requires a human-written reason.", "");
    for (const item of doc.escapeHatches) lines.push(`- ${item.name}`, "");
    lines.push("## escape", "", "A human-written reason is required.", "");
    for (const item of doc.escapeHatches) lines.push(item.name, "");
  }
  const related = relatedDocs(doc.code);
  lines.push("## Related", "");
  if (related.length === 0) lines.push("None.", "");
  else {
    for (const item of related) lines.push(`- ${item.code} ${item.title}`);
    lines.push("");
  }
  if (example?.kind === "database") {
    lines.push("Example: needs a database", "");
  } else if (example?.kind === "pair") {
    lines.push(
      "## Examples",
      "",
      "### bad",
      "",
      "```ts",
      example.bad,
      "```",
      "",
      "### fixed",
      "",
      "```ts",
      example.fixed,
      "```",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Absolute path of `docs/errors/<code>.md` inside this package.
 *
 * @param code - Spec code
 * @returns The path
 */
export function errorPageFile(code: string): string {
  return join(packageRoot(), "docs/errors", `${code}.md`);
}

/**
 * Page text on disk.
 *
 * @param code - Spec code
 * @returns The file, or `undefined` when this build has no pages
 */
export function readErrorPage(code: string): string | undefined {
  const path = errorPageFile(code);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Problems in one page: missing file, drift, a URL, or an imperative
 * outside a code fence.
 *
 * @param doc - Registry entry
 * @param example - Example the generator would write
 * @returns Problem lines
 */
export function errorPageProblems(doc: ErrorDoc, example?: PageExample): readonly string[] {
  const path = errorPageFile(doc.code);
  if (!existsSync(path)) return [`${doc.code}: missing ${path}`];
  const text = readFileSync(path, "utf8");
  const expected = renderErrorPage(doc, example);
  const problems: string[] = [];
  if (text !== expected) problems.push(`${doc.code}: page does not match the registry`);
  problems.push(...proseProblems(doc.code, text));
  return problems;
}

/**
 * Imperatives and URLs outside code fences.
 *
 * @param code - Spec code, for the message
 * @param text - Page markdown
 * @returns Problem lines
 */
export function proseProblems(code: string, text: string): readonly string[] {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const problems: string[] = [];
  if (IMPERATIVE.test(prose))
    problems.push(`${code}: page addresses an agent outside a code fence`);
  if (URL.test(prose)) problems.push(`${code}: page contains a URL`);
  return problems;
}

function relatedDocs(code: string): readonly ErrorDoc[] {
  const number = Number(code.slice(3));
  if (!Number.isFinite(number)) return [];
  const band = Math.floor(number / 10) * 10;
  return ERROR_DOCS.filter((doc) => {
    if (doc.code === code) return false;
    const value = Number(doc.code.slice(3));
    return value >= band && value < band + 10;
  });
}
