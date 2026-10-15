/**
 * Agent Skills discovery index. The artifact bytes and the digest are the
 * same read, so the index cannot advertise a hash the file does not have.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Discovery schema the index names. */
export const AGENT_SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** Skill name. Lowercase, and it matches the frontmatter `name`. */
export const AGENT_SKILL_NAME = "okmodel";

/** Path-absolute URL of the skill file. */
export const AGENT_SKILL_URL = `/.well-known/agent-skills/${AGENT_SKILL_NAME}/SKILL.md`;

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../content/agent-skills/okmodel/SKILL.md",
);

/** One published skill, pinned to the bytes on disk. */
export interface AgentSkillEntry {
  readonly name: string;
  readonly type: "skill-md";
  readonly description: string;
  readonly url: string;
  readonly digest: string;
}

/**
 * Raw skill file. The route serves these bytes unchanged.
 */
export function readAgentSkillBytes(): Uint8Array {
  return readFileSync(SKILL_PATH);
}

/**
 * `description` from the skill frontmatter. One line, after `description:`.
 */
export function agentSkillDescription(bytes: Uint8Array = readAgentSkillBytes()): string {
  const text = new TextDecoder().decode(bytes);
  const line = text.split("\n").find((entry) => entry.startsWith("description:"));
  if (line === undefined) throw new Error("okmodel skill is missing description");
  const value = line.slice("description:".length).trim();
  if (value.length === 0 || value.length > 1024) {
    throw new Error("okmodel skill description must be 1 to 1024 characters");
  }
  return value;
}

/**
 * SHA-256 of the skill bytes, as `sha256:` plus 64 lowercase hex digits.
 *
 * @param bytes - Exact artifact bytes
 */
export function agentSkillDigest(bytes: Uint8Array = readAgentSkillBytes()): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Discovery index document.
 */
export function buildAgentSkillsIndex(): {
  readonly $schema: string;
  readonly skills: readonly AgentSkillEntry[];
} {
  const bytes = readAgentSkillBytes();
  return {
    $schema: AGENT_SKILLS_SCHEMA,
    skills: [
      {
        name: AGENT_SKILL_NAME,
        type: "skill-md",
        description: agentSkillDescription(bytes),
        url: AGENT_SKILL_URL,
        digest: agentSkillDigest(bytes),
      },
    ],
  };
}
