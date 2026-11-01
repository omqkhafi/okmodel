/**
 * Refusals for `okm agents` and the agent files `okm init` writes.
 *
 * The codes are OKM1881–OKM1888. Retry is false. A refusal names a file and
 * a state, never a URL or the text of a file the user wrote.
 */

import { OkmError } from "../../contracts/error.js";
import { tagOutcome, type CliOutcomeName } from "../cli/outcome.js";

/** One file state `okm agents status` reports. */
export type AgentState = "current" | "stale" | "missing" | "modified";

/**
 * Throws an agent-files error with a fixed outcome and `retryable: false`.
 *
 * @param code - OKM1881–OKM1888
 * @param message - What failed
 * @param fix - What to change
 * @param outcome - Exit outcome
 * @returns Never
 */
function agentError(
  code: string,
  message: string,
  fix: string,
  outcome: CliOutcomeName,
): never {
  throw tagOutcome(
    new OkmError(code, message, {
      kind: "invalid",
      retryable: false,
      fix: { summary: fix },
    }),
    outcome,
  );
}

/**
 * Refuses a status check when a file is not current.
 *
 * @param files - Reported files. Every file `current` is not a refusal
 */
export function refuseDrift(
  files: readonly { readonly path: string; readonly state: AgentState }[],
): void {
  const drifted = files.filter((file) => file.state !== "current");
  if (drifted.length === 0) return;
  const listed = drifted.map((file) => `${file.path} (${file.state})`).join(", ");
  agentError(
    "OKM1881",
    `Agent files are not current: ${listed}.`,
    "Run okm agents update to rewrite the block and any unmodified skill, or okm init --agents when the files were never written.",
    "failed",
  );
}

/**
 * Refuses a file whose OKMODEL markers are damaged or repeated.
 *
 * @param kind - `damaged` or `duplicated`
 * @param path - Project-relative file
 * @param line - 1-based line of the first marker involved
 * @returns Never
 */
export function refuseMarkers(kind: "damaged" | "duplicated", path: string, line: number): never {
  const damaged = kind === "damaged";
  agentError(
    damaged ? "OKM1882" : "OKM1883",
    damaged
      ? `The OKMODEL markers in ${path} are damaged near line ${String(line)}.`
      : `${path} has more than one OKMODEL block, from line ${String(line)}.`,
    damaged
      ? `Restore one BEGIN OKMODEL line and one END OKMODEL line in ${path}, or delete both and the text between them, then run again. okm does not repair markers.`
      : `Keep one OKMODEL block in ${path} and delete the others, then run again. okm does not merge blocks.`,
    "guard",
  );
}

/**
 * Refuses to change existing files without consent.
 *
 * @param paths - Existing files the plan would change. Empty is not a refusal
 */
export function refuseConsent(paths: readonly string[]): void {
  if (paths.length === 0) return;
  agentError(
    "OKM1884",
    `Changing ${paths.join(", ")} needs a yes, and this run cannot ask.`,
    "Run okm agents update --dry-run to read the diff, then pass --yes. Or run on a terminal and answer the prompt.",
    "decision",
  );
}

/**
 * Refuses package content that is missing or unsafe to copy.
 *
 * @param reason - Why, naming the package path
 * @returns Never
 */
export function refuseContent(reason: string): never {
  agentError(
    "OKM1885",
    reason,
    "Reinstall okmodel from the registry. okm copies agent files only from its own package.",
    "failed",
  );
}

/**
 * Refuses a path outside the agent-file allowlist, or one that is not a file.
 *
 * @param reason - Why, naming the project-relative path
 * @returns Never
 */
export function refusePath(reason: string): never {
  agentError(
    "OKM1886",
    reason,
    "Keep the agent files as regular files inside the project directory.",
    "guard",
  );
}

/**
 * Refuses to write a file that changed after the plan was made.
 *
 * @param path - Project-relative file
 * @param current - The file text now, or `undefined` when absent
 * @param planned - The text the plan read, or `undefined` when it was absent
 */
export function refuseChanged(
  path: string,
  current: string | undefined,
  planned: string | undefined,
): void {
  if (current === planned) return;
  agentError(
    "OKM1887",
    `${path} changed after the plan was made. Nothing more was written.`,
    "Run the command again so the diff matches the file.",
    "guard",
  );
}

/**
 * Refuses an `.okm/init.json` that cannot hold the agent record.
 *
 * @param reason - Why
 * @returns Never
 */
export function refuseRecord(reason: string): never {
  agentError(
    "OKM1888",
    reason,
    "Restore .okm/init.json from version control, or delete it and run okm init again.",
    "guard",
  );
}
