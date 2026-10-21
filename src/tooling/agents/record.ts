/**
 * The `agents` section of `.okm/init.json`.
 *
 * It records the choice, the facts the block prints, the skill targets, and
 * the SHA-256 of each skill file `okm` wrote. A hash that still matches is
 * what lets a later run replace or delete that file. Nothing else in the
 * record is read or changed here.
 */

import { AGENTS_FILE, AGENT_TARGETS, CLAUDE_FILE, skillPathOf, type AgentTarget } from "./files.js";
import { refuseRecord } from "./guards.js";

/** What `okm` remembers about the agent files in one project. */
export type AgentsRecord = {
  /** `yes` after a write. `no` after a decline or a removal. */
  readonly choice: "yes" | "no";
  /** Tenancy label the block prints. */
  readonly tenancy?: string;
  /** Whether the block says protected targets are configured. */
  readonly protected?: boolean;
  /** Skill targets in use. */
  readonly targets?: readonly AgentTarget[];
  /** SHA-256 of each file `okm` wrote and has not seen change. */
  readonly files?: Readonly<Record<string, string>>;
  /** Files `okm` created, as opposed to files it only added a block to. */
  readonly created?: readonly string[];
};

/**
 * Reads the agent record out of `.okm/init.json` text.
 *
 * Entries that name a path outside the skill directories are dropped, so a
 * hand-edited record cannot widen what a run may delete.
 *
 * @param text - File text, or `undefined` when the file is absent
 * @returns The record, or `undefined` when there is none
 */
export function readAgentsRecord(text: string | undefined): AgentsRecord | undefined {
  const parsed = parse(text);
  if (parsed === undefined) return undefined;
  const raw = parsed.agents;
  if (!isRecord(raw) || (raw.choice !== "yes" && raw.choice !== "no")) return undefined;
  const files: Record<string, string> = {};
  if (isRecord(raw.files)) {
    for (const [path, hash] of Object.entries(raw.files)) {
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) continue;
      if (path === CLAUDE_FILE || skillPathOf(path) !== undefined) files[path] = hash;
    }
  }
  const targets = Array.isArray(raw.targets)
    ? AGENT_TARGETS.filter((target) => (raw.targets as unknown[]).includes(target))
    : undefined;
  const created = Array.isArray(raw.created)
    ? [AGENTS_FILE, CLAUDE_FILE].filter((path) => (raw.created as unknown[]).includes(path))
    : [];
  return {
    choice: raw.choice,
    ...(typeof raw.tenancy === "string" && raw.tenancy.length <= 32
      ? { tenancy: raw.tenancy }
      : {}),
    ...(typeof raw.protected === "boolean" ? { protected: raw.protected } : {}),
    ...(targets === undefined ? {} : { targets }),
    files,
    created,
  };
}

/**
 * The record file text with the agent section set.
 *
 * Every other key is kept as it was read. A missing file becomes a record
 * with no init files.
 *
 * @param current - Current file text, or `undefined` when absent
 * @param next - The agent section to store
 * @returns New file text, ending in a newline
 * @throws OkmError OKM1888 when the current text is not a JSON object
 */
export function withAgentsRecord(current: string | undefined, next: AgentsRecord): string {
  const base = current === undefined ? { version: 1, files: {} } : parse(current);
  if (base === undefined)
    refuseRecord(".okm/init.json is not a JSON object, so okm cannot add to it.");
  return `${JSON.stringify({ ...base, agents: serialise(next) }, null, 2)}\n`;
}

function serialise(record: AgentsRecord): Record<string, unknown> {
  const files: Record<string, string> = {};
  for (const path of Object.keys(record.files ?? {}).sort()) {
    const hash = record.files?.[path];
    if (hash !== undefined) files[path] = hash;
  }
  return {
    choice: record.choice,
    ...(record.tenancy === undefined ? {} : { tenancy: record.tenancy }),
    ...(record.protected === undefined ? {} : { protected: record.protected }),
    ...(record.targets === undefined ? {} : { targets: record.targets }),
    ...(Object.keys(files).length === 0 ? {} : { files }),
    ...(record.created === undefined || record.created.length === 0
      ? {}
      : { created: record.created }),
  };
}

function parse(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
