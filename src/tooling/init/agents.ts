/**
 * The agent files part of `okm init`.
 *
 * `--agents` names what to write. `--no-agents` records that the project
 * wants none. With neither flag a terminal is asked once, and the answer is
 * recorded in `.okm/init.json` so a later run does not ask again. A run with
 * `--yes` or `--json` and no flag writes no agent file.
 */

import { AGENT_TARGETS, RECORD_FILE, readAgentFile, type AgentTarget } from "../agents/files.js";
import { planAgents, planDecline, type AgentsPlan } from "../agents/plan.js";
import { readAgentsRecord } from "../agents/record.js";
import { canonicalHash } from "../canonical-json.js";
import type { ParsedCli } from "../cli/parse.js";
import { ask } from "../prompt.js";
import type { InitPlan } from "./engine.js";
import { initUsage, type InitSupportedTenancy } from "./guards.js";

const ACCEPTED = ["block", "claude", "agents", "all"] as const;

/**
 * Skill targets named by `--agents`.
 *
 * `block` names none: it writes the `AGENTS.md` block and the `CLAUDE.md`
 * import only. `all` is every target.
 *
 * @param values - Flag values. Each may hold several names separated by commas
 * @returns The targets, in listing order
 */
export function agentTargetsFlag(values: readonly string[]): readonly AgentTarget[] {
  const named = new Set<AgentTarget>();
  for (const value of values) {
    for (const part of value.split(",")) {
      const name = part.trim();
      if (!(ACCEPTED as readonly string[]).includes(name)) {
        initUsage(
          `Unknown agent target ${name.length === 0 ? "(empty)" : name}.`,
          "Pass --agents block, claude, agents, or all.",
        );
      }
      if (name === "all") for (const target of AGENT_TARGETS) named.add(target);
      else if (name === "claude" || name === "agents") named.add(name);
    }
  }
  return AGENT_TARGETS.filter((target) => named.has(target));
}

/**
 * Plans the agent files for one init run, or `undefined` when init leaves them alone.
 *
 * @param input - Flags, the directory the files go in, the tenancy label, and
 * whether this run may ask a question
 * @returns The plan
 */
export async function planInitAgents(input: {
  readonly parsed: ParsedCli;
  readonly root: string;
  readonly tenancy: InitSupportedTenancy;
  readonly version: string;
  readonly tty: boolean;
}): Promise<AgentsPlan | undefined> {
  const { parsed, root, version } = input;
  if (parsed.noAgents && parsed.agents.length > 0) {
    initUsage("Pass either --agents or --no-agents.", "Drop one of them.");
  }
  const facts = { tenancy: input.tenancy };
  const record = readAgentsRecord(readAgentFile(root, RECORD_FILE, new Set([RECORD_FILE])));
  if (parsed.noAgents) {
    if (record?.choice === "yes") {
      initUsage(
        "Agent files are installed in this project.",
        "Run okm agents remove first, then okm init --no-agents.",
      );
    }
    return planDecline(root);
  }
  if (parsed.agents.length > 0) {
    const targets = agentTargetsFlag(parsed.agents);
    return planAgents({ root, mode: "install", version, targets, facts });
  }
  if (record !== undefined) return undefined;
  if (!input.tty || parsed.yes || parsed.json) return undefined;
  const offer = planAgents({ root, mode: "install", version, facts });
  process.stderr.write(`${offer.lines.join("\n")}\n`);
  const answer = (await ask("Write these agent files? [Y/n] ")).toLowerCase();
  return answer === "n" || answer === "no" ? planDecline(root) : offer;
}

/**
 * Adds the agent files plan to an init plan.
 *
 * The plan hash covers both parts, so one `--plan-hash` guards the whole run.
 * A project whose init files are all current is no longer `unchanged` when
 * an agent file would change.
 *
 * @param plan - The init plan. A monorepo plan keeps its extra fields
 * @param agents - The agent files plan, or `undefined` for none
 * @returns The merged plan
 */
export function mergeAgents<T extends InitPlan>(plan: T, agents: AgentsPlan | undefined): T {
  if (agents === undefined) return plan;
  const pending = agents.writes.length > 0;
  const lines = plan.human.split("\n").filter((line) => !(pending && line === "nothing to do"));
  const first = plan.data.nextSteps[0];
  const at = lines.lastIndexOf(first);
  const section =
    agents.lines.length === 0 ? [] : ["agent files:", ...agents.lines.join("\n").split("\n")];
  lines.splice(at === -1 ? Math.max(lines.length - 1, 0) : at, 0, ...section);
  return {
    ...plan,
    data: {
      ...plan.data,
      status: plan.data.status === "unchanged" && pending ? "planned" : plan.data.status,
      agents: agents.data,
      planHash: canonicalHash({ init: plan.data.planHash, agents: agents.data.planHash }),
    },
    human: lines.join("\n"),
    warnings: [...plan.warnings, ...agents.warnings],
  };
}
