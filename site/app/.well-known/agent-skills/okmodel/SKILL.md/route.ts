/**
 * `/.well-known/agent-skills/okmodel/SKILL.md`.
 */

import { readAgentSkillBytes } from "@/lib/agent-skills";

export const revalidate = false;

/**
 * The published skill. The bytes match the digest in the index.
 */
export function GET(): Response {
  const bytes = readAgentSkillBytes();
  return new Response(bytes, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
