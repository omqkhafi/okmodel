/**
 * Runs the migration linter.
 *
 * The linter reads a plan and the two catalogs. It does not connect.
 * An override is a `-- okm-allow` line on the statement. It silences only
 * the code it names, and only with a reason.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { catalog } from "../../contracts/catalog/build.js";
import { parseCatalog } from "../../contracts/catalog/document.js";
import type { Catalog, ColumnObject } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import { errorDoc } from "../errors/registry.js";
import { COLUMN_RULES, STEP_RULES, type LintSeverity } from "./lint-rules.js";
import { parsePlan, type MigrationPlan, type PlanStep } from "./plan.js";

/** One finding. `place` is `step N` or `table.column`, optionally prefixed with the file. */
export type Finding = {
  readonly severity: LintSeverity;
  readonly code: string;
  readonly place: string;
  readonly reason: string;
  readonly fix: string;
};

/**
 * Lints every step. Type preferences are {@link lintCatalog}, not here.
 *
 * @param plan - Parsed or planned steps, including `-- okm-allow` lines
 * @param before - Catalog the statements start from
 * @param after - Catalog the statements end on
 * @returns Findings in step order, then code order
 */
export function lintPlan(plan: MigrationPlan, before: Catalog, after: Catalog): readonly Finding[] {
  const existingTables = tableNames(before);
  const findings: Finding[] = [];
  plan.steps.forEach((step, index) => {
    findings.push(
      ...lintStep(
        step,
        index + 1,
        before,
        after,
        existingTables,
        plan.steps.slice(0, index),
        plan.steps.slice(index + 1),
      ),
    );
  });
  return findings;
}

/**
 * Lints type preferences on the author catalog.
 *
 * @param source - Schema catalog `okm check` loaded
 * @returns One warning per column that prefers another type
 */
export function lintCatalog(source: Catalog): readonly Finding[] {
  const findings: Finding[] = [];
  for (const object of source.objects) {
    if (object.kind !== "column") continue;
    for (const rule of COLUMN_RULES) {
      const reason = rule.check(object);
      if (reason === undefined) continue;
      findings.push(finding(rule.severity, rule.code, columnPlace(object), reason));
    }
  }
  return findings;
}

/**
 * Lints each SQL file against the previous file's catalog.
 *
 * The walk starts at the first file, against an empty catalog, so a later
 * file sees the catalog the file before it left. The sibling `.catalog.json`
 * is the catalog after that file. When `pending` is passed, only those
 * migration ids contribute findings. The earlier files are still read.
 *
 * @param directory - Migrations directory. Missing means there are none
 * @param pending - Migration ids still to run. Omit to lint every file
 * @returns Findings, each place prefixed with the migration id
 */
export function lintMigrationDirectory(
  directory: string,
  pending?: ReadonlySet<string>,
): readonly Finding[] {
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  let before = catalog([]);
  const findings: Finding[] = [];
  for (const file of names) {
    const id = file.slice(0, -".sql".length);
    const plan = parsePlan(readFileSync(join(directory, file), "utf8"));
    const after = parseCatalog(readFileSync(join(directory, `${id}.catalog.json`), "utf8"));
    if (pending === undefined || pending.has(id)) {
      for (const item of lintPlan(plan, before, after)) {
        findings.push({ ...item, place: `${id} ${item.place}` });
      }
    }
    before = after;
  }
  return findings;
}

/**
 * Prints findings one per line, in a form CI can grep.
 *
 * @param findings - Findings from {@link lintPlan} or {@link lintCatalog}
 * @returns The text, or `""` when there are none. A non-empty result ends in a newline
 */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "";
  return `${findings.map(formatFinding).join("\n")}\n`;
}

/**
 * Reports whether any finding is an error.
 *
 * @param findings - Findings to scan
 * @returns `true` when plan, check, or apply must fail
 */
export function hasError(findings: readonly Finding[]): boolean {
  return findings.some((item) => item.severity === "error");
}

/**
 * OKM1510 for an unresolved error finding.
 *
 * The message is the finding lines, so the failure text stays greppable.
 *
 * @param findings - Findings that include at least one error
 * @returns The error apply, plan, and check throw before continuing
 */
export function lintRefusal(findings: readonly Finding[]): OkmError {
  const doc = errorDoc("OKM1510");
  return new OkmError("OKM1510", formatFindings(findings).trim(), {
    fix: { summary: doc?.fix ?? "Allow the finding with a reason, or change the statement." },
  });
}

function lintStep(
  step: PlanStep,
  number: number,
  before: Catalog,
  after: Catalog,
  existingTables: ReadonlySet<string>,
  earlier: readonly PlanStep[],
  later: readonly PlanStep[],
): readonly Finding[] {
  const hits: {
    readonly code: string;
    readonly severity: LintSeverity;
    readonly reason: string;
  }[] = [];
  for (const rule of STEP_RULES) {
    for (const reason of rule.check({ step, before, after, existingTables, earlier, later })) {
      hits.push({ code: rule.code, severity: rule.severity, reason });
    }
  }
  const triggered = new Set(hits.map((item) => item.code));
  const silenced = new Set<string>();
  const findings: Finding[] = [];
  const place = `step ${String(number)}`;
  for (const allow of step.allows ?? []) {
    if (allow.reason.trim().length === 0 || allow.code.length === 0) {
      findings.push(finding("error", "OKM1510", place, "override needs a reason"));
      continue;
    }
    if (!triggered.has(allow.code)) {
      findings.push(
        finding("error", "OKM1510", place, `override ${allow.code} does not match this statement`),
      );
      continue;
    }
    silenced.add(allow.code);
  }
  for (const hit of hits) {
    if (silenced.has(hit.code)) continue;
    findings.push(finding(hit.severity, hit.code, place, hit.reason));
  }
  return findings;
}

function finding(severity: LintSeverity, code: string, place: string, reason: string): Finding {
  const doc = errorDoc(code);
  if (doc === undefined) throw new Error(`${code} missing from the error registry.`);
  return { severity, code, place, reason, fix: doc.fix };
}

function formatFinding(item: Finding): string {
  return `${item.severity} ${item.code} ${item.place}: ${item.reason} -- fix: ${item.fix}`;
}

function tableNames(source: Catalog): ReadonlySet<string> {
  const names = new Set<string>();
  for (const object of source.objects) {
    if (object.kind === "table") names.add(object.identity.name);
  }
  return names;
}

function columnPlace(column: ColumnObject): string {
  return `${column.identity.parent.name}.${column.identity.name}`;
}
