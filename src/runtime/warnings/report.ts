/**
 * Delivers one warning.
 *
 * The console path keeps one line per rule and call site for the process.
 * `error` does not come through here: the slot throws on every evaluation.
 */

import { OkmError } from "../../contracts/error.js";
import type { WarningLevel, WarningRule, WarningSeverity } from "./catalog.js";

/** X2 error object plus the warning level, severity, and rule id. */
export type WarningNotice = {
  readonly code: string;
  readonly kind: "invalid";
  readonly category: "input";
  readonly summary: string;
  readonly fix: { readonly summary: string };
  readonly retryable: false;
  readonly docs: string;
  readonly safeAlternatives: WarningRule["safeAlternatives"];
  readonly escapeHatches: WarningRule["escapeHatches"];
  readonly location?: { readonly file: string; readonly line: number };
  /** The default limit the read reached, such as `limits.find = 100`. Set on OKM2011. */
  readonly limit?: string;
  readonly level: Exclude<WarningLevel, "off" | "error">;
  readonly severity: WarningSeverity;
  readonly rule: string;
};

const seen = new Set<string>();

/**
 * Throws the rule as an `OkmError`. Not deduplicated.
 *
 * @param rule - Registered rule
 */
export function throwWarning(rule: WarningRule): never {
  throw new OkmError(rule.code, rule.summary, {
    kind: "invalid",
    fix: { summary: rule.fix },
  });
}

/**
 * Reports one hint or warning. A repeated rule and call site is dropped.
 *
 * @param rule - Registered rule
 * @param level - `hint` or `warn`
 * @param onWarning - Replaces the console when set
 * @param stack - Stack captured where the read was written
 * @param limit - What the read reached, when the rule names it
 */
export function reportWarning(
  rule: WarningRule,
  level: WarningNotice["level"],
  onWarning: ((notice: WarningNotice) => void) | undefined,
  stack?: string,
  limit?: string,
): void {
  const location = callerLocation(stack);
  const key = `${rule.code}\0${location?.file ?? ""}:${String(location?.line ?? 0)}\0${limit ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  const notice = noticeOf(rule, level, location, limit);
  if (onWarning !== undefined) {
    onWarning(notice);
    return;
  }
  console.warn(formatNotice(notice));
}

function noticeOf(
  rule: WarningRule,
  level: WarningNotice["level"],
  location: WarningNotice["location"],
  limit: string | undefined,
): WarningNotice {
  return {
    code: rule.code,
    kind: "invalid",
    category: "input",
    summary: rule.summary,
    fix: { summary: rule.fix },
    retryable: false,
    docs: `docs/errors/${rule.code}.md`,
    safeAlternatives: rule.safeAlternatives,
    escapeHatches: rule.escapeHatches,
    ...(location !== undefined ? { location } : {}),
    ...(limit !== undefined ? { limit } : {}),
    level,
    severity: rule.severity,
    rule: rule.rule,
  };
}

function formatNotice(notice: WarningNotice): string {
  const lines = [`${notice.code} ${notice.level}: ${notice.summary}`];
  if (notice.location !== undefined)
    lines.push(`  at ${notice.location.file}:${String(notice.location.line)}`);
  if (notice.limit !== undefined)
    lines.push(`  Limit: ${notice.limit}. Or call .all(reason) when every row is needed.`);
  lines.push(`  Fix: ${notice.fix.summary}`, `  ${notice.docs}`);
  return lines.join("\n");
}

function callerLocation(
  captured?: string,
): { readonly file: string; readonly line: number } | undefined {
  const stack = captured ?? new Error().stack;
  if (stack === undefined) return undefined;
  for (const line of stack.split("\n")) {
    const found = frameLocation(line);
    if (found === undefined || skipFrame(found.file)) continue;
    return found;
  }
  return undefined;
}

function frameLocation(line: string): { readonly file: string; readonly line: number } | undefined {
  const match = /(?:\()?(.*):(\d+):\d+\)?$/.exec(line.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  let file = match[1];
  const open = file.lastIndexOf("(");
  if (open !== -1) file = file.slice(open + 1);
  else {
    const at = file.lastIndexOf(" ");
    if (at !== -1) file = file.slice(at + 1);
  }
  if (file.startsWith("file://")) file = file.slice("file://".length);
  const lineNo = Number(match[2]);
  if (!Number.isInteger(lineNo)) return undefined;
  return { file, line: lineNo };
}

function skipFrame(file: string): boolean {
  return (
    file.includes("/src/runtime/") ||
    file.includes("/dist/runtime/") ||
    file.includes("node_modules") ||
    file.includes("node:") ||
    file.includes("bun:")
  );
}
