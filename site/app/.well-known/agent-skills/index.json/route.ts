/**
 * `/.well-known/agent-skills/index.json`.
 */

import { buildAgentSkillsIndex } from "@/lib/agent-skills";

export const revalidate = false;

/**
 * Skill index. Open to browser agents on another origin.
 */
export function GET(): Response {
  return new Response(JSON.stringify(buildAgentSkillsIndex()), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
