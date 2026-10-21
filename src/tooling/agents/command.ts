/**
 * `okm agents status | update | remove`.
 *
 * These commands read and write the agent files in one project directory.
 * They do not connect, do not load `okmodel.config.ts`, and copy content
 * only from the installed package. A plan is printed with its diff first.
 * `--dry-run` stops there. A change to an existing file then needs `--yes`
 * or a yes typed on a terminal.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";

import { OkmError } from "../../contracts/error.js";
import { attachPartial } from "../cli/outcome.js";
import type { ParsedCli } from "../cli/parse.js";
import { readPackageVersion } from "../cli/version.js";
import { initUsage, isInitTenancy, refusePlanHash } from "../init/guards.js";
import { ask } from "../prompt.js";
import { applyAgents } from "./apply.js";
import { refuseConsent, refuseDrift } from "./guards.js";
import {
  planAgents,
  statusAgents,
  type AgentsData,
  type AgentsFacts,
  type AgentsPlan,
  type AgentsStatusData,
} from "./plan.js";

/** What `okm` dispatch returns for one agents command. */
export type AgentsProduced = {
  readonly text: string;
  readonly data: AgentsData | AgentsStatusData;
  readonly warnings: readonly { readonly summary: string }[];
  readonly outFile: null;
};

/**
 * Runs one `okm agents` command.
 *
 * @param parsed - Parsed flags. The operand is the project directory
 * @param cwd - Working directory
 * @param human - Receives the text when `--json` is off
 * @returns The report or plan document
 */
export async function agentsCommand(
  parsed: ParsedCli,
  cwd: string,
  human: (text: string) => void,
): Promise<AgentsProduced> {
  const root = projectDirectory(parsed.operands[0], cwd);
  const version = readPackageVersion();
  if (parsed.command === "agents status") return status(root, version, human);
  const mode = parsed.command === "agents update" ? "update" : "remove";
  const plan = planAgents({ root, mode, version, facts: factsOf(parsed) });
  return runPlan(parsed, plan, human);
}

/**
 * Prints a plan, asks for a yes when an existing file changes, and applies it.
 *
 * `okm init` uses the same steps for the agent files it writes.
 *
 * @param parsed - Parsed flags
 * @param plan - The plan to run
 * @param human - Receives the text when `--json` is off
 * @returns The plan document, `applied` after a write
 */
export async function runPlan(
  parsed: ParsedCli,
  plan: AgentsPlan,
  human: (text: string) => void,
): Promise<AgentsProduced> {
  const text = `${plan.lines.join("\n")}${plan.lines.length > 0 ? "\n" : ""}`;
  human(text);
  const produced = (data: AgentsData): AgentsProduced => ({
    text,
    data,
    warnings: plan.warnings,
    outFile: null,
  });
  if (plan.writes.length === 0 || parsed.dryRun) return produced(plan.data);
  try {
    if (parsed.planHash !== undefined) refusePlanHash(parsed.planHash, plan.data.planHash);
    if (!(await consented(parsed, plan))) {
      human("nothing written\n");
      return produced(plan.data);
    }
    applyAgents(plan);
  } catch (error) {
    throw partial(error, plan.data, plan.warnings);
  }
  return produced({ ...plan.data, status: "applied" });
}

/**
 * Whether the plan may be applied.
 *
 * A plan that only creates files needs no yes. One that changes an existing
 * file needs `--yes` or an answer typed on a terminal.
 *
 * @param parsed - Parsed flags
 * @param plan - The plan to apply
 * @returns `false` when the person answered no
 * @throws OkmError OKM1884 when a yes is needed and this run cannot ask
 */
export async function consented(parsed: ParsedCli, plan: AgentsPlan): Promise<boolean> {
  if (plan.consent.length === 0 || parsed.yes) return true;
  if (process.stdin.isTTY !== true || parsed.json) refuseConsent(plan.consent);
  const answer = (await ask("Apply these changes? [y/N] ")).toLowerCase();
  return answer === "y" || answer === "yes";
}

function status(root: string, version: string, human: (text: string) => void): AgentsProduced {
  const report = statusAgents(root, version);
  const text = `${report.lines.join("\n")}\n`;
  human(text);
  try {
    refuseDrift(report.data.files);
  } catch (error) {
    throw partial(error, report.data, report.warnings);
  }
  return { text, data: report.data, warnings: report.warnings, outFile: null };
}

function factsOf(parsed: ParsedCli): AgentsFacts {
  const facts: { tenancy?: string; protectedConfigured?: boolean } = {};
  if (parsed.tenancy !== undefined) {
    if (!isInitTenancy(parsed.tenancy)) {
      initUsage(
        `Unknown tenancy ${parsed.tenancy}.`,
        "Pass --tenancy none, column, schema, or database.",
      );
    }
    facts.tenancy = parsed.tenancy;
  }
  if (parsed.protectedFlag !== undefined) {
    if (parsed.protectedFlag !== "yes" && parsed.protectedFlag !== "no") {
      initUsage(
        `--protected needs yes or no, not ${parsed.protectedFlag}.`,
        "Pass --protected yes or --protected no.",
      );
    }
    facts.protectedConfigured = parsed.protectedFlag === "yes";
  }
  return facts;
}

function projectDirectory(operand: string | undefined, cwd: string): string {
  const root = resolve(cwd, operand ?? ".");
  try {
    if (statSync(root).isDirectory()) return root;
  } catch {
    // Reported below.
  }
  return initUsage(
    `${operand ?? "."} is not a directory.`,
    "Pass the project directory, or run from it.",
  );
}

function partial(
  error: unknown,
  data: AgentsData | AgentsStatusData,
  warnings: readonly { readonly summary: string }[],
): unknown {
  if (error instanceof OkmError) return attachPartial(error, { data, warnings, outFile: null });
  return error;
}
