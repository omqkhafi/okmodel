/**
 * Audit of `-- okm-allow` overrides in committed migration files.
 *
 * An override silences one lint code on one step, and the file is the
 * acknowledgement. This module lists those lines and flags a reason that
 * says nothing. It reads files only, never connects, and never refuses:
 * the lint stays where it is, and a weak reason is a warning.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { OkmError } from "../../contracts/error.js";
import { errorDoc } from "../errors/registry.js";
import { renderUntrusted, untrustedText, type UntrustedText } from "../untrusted.js";
import { readMigrationPlan } from "./files.js";
import type { Finding } from "./lint.js";
import { STEP_RULES, type LintCategory } from "./lint-rules.js";
import { REPRINT_CODE } from "./reprint.js";

/** Code raised for an override whose reason is too weak to audit. */
export const WEAK_ALLOW_CODE = "OKM2300";

/** Shortest reason, in characters, that is not flagged. */
export const MIN_ALLOW_REASON = 12;

/** Reasons that carry no information. Compared without case or trailing punctuation. */
export const ALLOW_REASON_STOP_LIST: readonly string[] = [
  "ok",
  "fix",
  "test",
  "todo",
  "needed",
  "temp",
  "tmp",
  "none",
  "na",
];

/** Class of the rule an override silences. */
export type AllowRuleClass = LintCategory | "reprint" | "unknown";

/** One `-- okm-allow` line in a migration file. */
export type AllowEntry = {
  /** Migration id, the file name without `.sql`. */
  readonly migration: string;
  /** One-based step number, the same number a lint finding prints. */
  readonly step: number;
  /** Silenced code. Empty when the line is not `-- okm-allow OKMxxxx: reason`. */
  readonly code: string;
  /** Category of that code's lint rule. */
  readonly ruleClass: AllowRuleClass;
  /** The rule destroys data or rejects existing values. */
  readonly destructive: boolean;
  /** Text after the colon, trimmed. The file author wrote it. */
  readonly reason: string;
};

/** One entry as `--json` prints it. The reason is marked untrusted. */
export type AllowRecord = Omit<AllowEntry, "reason"> & { readonly reason: UntrustedText };

const NARROWING_CODES: ReadonlySet<string> = new Set(["OKM1527", "OKM1533"]);

/**
 * Lists every override in a migrations directory.
 *
 * A file the parser refuses is skipped: `okm migrate check`, plan, and
 * apply already refuse it with their own code.
 *
 * @param directory - Migrations directory. Missing means there are none
 * @returns Entries in migration, then step order
 */
export function listAllows(directory: string): readonly AllowEntry[] {
  if (!existsSync(directory)) return [];
  const entries: AllowEntry[] = [];
  const names = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of names) {
    const migration = file.slice(0, -".sql".length);
    let steps;
    try {
      steps = readMigrationPlan(join(directory, file)).steps;
    } catch (error) {
      if (error instanceof OkmError) continue;
      throw error;
    }
    steps.forEach((step, index) => {
      for (const allow of step.allows ?? []) {
        const ruleClass = ruleClassOf(allow.code);
        entries.push({
          migration,
          step: index + 1,
          code: allow.code,
          ruleClass,
          destructive: ruleClass === "destructive" || NARROWING_CODES.has(allow.code),
          reason: allow.reason,
        });
      }
    });
  }
  return entries;
}

/**
 * Why a reason is too weak, or `undefined` when it is not.
 *
 * @param reason - Text after the colon
 * @param code - The silenced code, so a reason that only repeats it is caught
 * @returns A short phrase that never repeats the reason, or `undefined`
 */
export function weakAllowReason(reason: string, code: string): string | undefined {
  const text = reason.trim();
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  if (words.length > 0 && words.every((word) => ALLOW_REASON_STOP_LIST.includes(word))) {
    return "is only stop-list words";
  }
  const lowered = code.toLowerCase();
  if (lowered.length > 0 && words.length > 0 && words.every((word) => word === lowered)) {
    return "only repeats the code";
  }
  if (text.length < MIN_ALLOW_REASON) {
    return `is shorter than ${String(MIN_ALLOW_REASON)} characters`;
  }
  if (words.length === 0) return "has no words";
  return undefined;
}

/**
 * Warnings for overrides whose reason is too weak. Nothing here is an error.
 *
 * @param entries - Entries from {@link listAllows}
 * @returns One {@link WEAK_ALLOW_CODE} warning per weak reason
 */
export function allowFindings(entries: readonly AllowEntry[]): readonly Finding[] {
  const doc = errorDoc(WEAK_ALLOW_CODE);
  if (doc === undefined) throw new Error(`${WEAK_ALLOW_CODE} missing from the error registry.`);
  const findings: Finding[] = [];
  for (const entry of entries) {
    const weak = weakAllowReason(entry.reason, entry.code);
    if (weak === undefined) continue;
    const label = entry.code.length === 0 ? "override" : `override ${entry.code}`;
    findings.push({
      severity: "warning",
      code: WEAK_ALLOW_CODE,
      place: `${entry.migration} step ${String(entry.step)}`,
      reason: `${label}${entry.destructive ? " (destructive)" : ""} reason ${weak}`,
      fix: doc.fix,
    });
  }
  return findings;
}

/**
 * Prints the listing, one line per override, in a form CI can grep.
 *
 * @param entries - Entries from {@link listAllows}
 * @returns The text, or `""` when there are none. A non-empty result ends in a newline
 */
export function formatAllows(entries: readonly AllowEntry[]): string {
  let text = "";
  for (const entry of entries) {
    const code = entry.code.length === 0 ? "(unreadable)" : entry.code;
    const mark = entry.destructive ? " DESTRUCTIVE" : "";
    const reason = renderUntrusted(untrustedText(entry.reason, "migration.comment"));
    text += `allow ${entry.migration} step ${String(entry.step)} ${code} ${entry.ruleClass}${mark}: ${reason}\n`;
  }
  return text;
}

/**
 * Entries as the `allows` array of `okm.cli/1` data.
 *
 * @param entries - Entries from {@link listAllows}
 * @returns Records with the reason marked untrusted
 */
export function allowRecords(entries: readonly AllowEntry[]): readonly AllowRecord[] {
  return entries.map((entry) => ({
    migration: entry.migration,
    step: entry.step,
    code: entry.code,
    ruleClass: entry.ruleClass,
    destructive: entry.destructive,
    reason: untrustedText(entry.reason, "migration.comment"),
  }));
}

function ruleClassOf(code: string): AllowRuleClass {
  if (code === REPRINT_CODE) return "reprint";
  return STEP_RULES.find((rule) => rule.code === code)?.category ?? "unknown";
}
