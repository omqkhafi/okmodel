/**
 * Executes an {@link AgentsPlan}.
 *
 * Every path is checked against the plan's closed list, and an existing file
 * is read again right before it is replaced: when it is no longer what the
 * plan read, the run stops. Each write is a temporary file and a rename.
 */

import { OkmError } from "../../contracts/error.js";
import { SKILL_DIRS, agentPath, deleteFile, readAgentFile, writeAtomic } from "./files.js";
import { refuseChanged, refusePath } from "./guards.js";
import type { AgentAction, AgentsPlan } from "./plan.js";
import { withAgentsRecord } from "./record.js";

/** One write that happened. */
export type AgentsExecuted = {
  readonly path: string;
  readonly action: AgentAction;
};

/**
 * Checks every path in a plan. Call this before any other writer so a
 * refusal leaves the project untouched.
 *
 * @param plan - A plan from `planAgents` or `planDecline`
 * @throws OkmError OKM1886 when a path cannot be written
 */
export function assertAgentPaths(plan: AgentsPlan): void {
  for (const write of plan.writes) agentPath(plan.root, write.path, plan.allowed);
}

/**
 * Performs the writes of a plan, in plan order.
 *
 * @param plan - A plan from `planAgents` or `planDecline`
 * @returns The path and action of each write
 * @throws OkmError OKM1886 for a path outside the list, a file that is not
 * regular, or a write that failed, and OKM1887 when a file changed after the plan
 */
export function applyAgents(plan: AgentsPlan): readonly AgentsExecuted[] {
  assertAgentPaths(plan);
  const done: AgentsExecuted[] = [];
  for (let index = 0; index < plan.writes.length; index += 1) {
    const write = plan.writes[index];
    if (write === undefined) continue;
    try {
      const path = agentPath(plan.root, write.path, plan.allowed);
      if (write.kind === "record") {
        const current = readAgentFile(plan.root, write.path, plan.allowed);
        if (plan.record === undefined) refusePath(`${write.path} has no record to write.`);
        writeAtomic(path, withAgentsRecord(current, plan.record));
      } else {
        const current = readAgentFile(plan.root, write.path, plan.allowed);
        refuseChanged(write.path, current, write.before);
        if (write.after === null) {
          deleteFile(
            path,
            Object.values(SKILL_DIRS).some((dir) => write.path.startsWith(`${dir}/`)),
          );
        } else {
          writeAtomic(path, write.after);
        }
      }
      done.push({ path: write.path, action: write.action });
    } catch (error) {
      if (error instanceof OkmError) throw error;
      const left = plan.writes.slice(index).map((item) => item.path);
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      refusePath(
        `Could not write ${write.path}${code.length > 0 ? ` (${code})` : ""}. Still to write: ${left.join(", ")}.`,
      );
    }
  }
  return done;
}
