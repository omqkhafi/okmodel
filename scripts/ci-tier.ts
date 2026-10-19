/**
 * Decides whether the full CI tier is required for this event.
 *
 * Full tier: push to `main`, the `full-ci` label, a release pull request
 * title (`chore(release)…`), or a change under `.github/workflows`.
 *
 *   bun ./scripts/ci-tier.ts --event pull_request --full-ci 0 --workflows 1
 *
 * Reads the pull request title from `OKM_PR_TITLE` when set. Writes
 * `full=true` or `full=false` to `GITHUB_OUTPUT` when that file is set.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** Inputs that decide whether tier 2 must run and pass. */
export type FullTierInput = {
  /** `push` or `pull_request`. */
  readonly eventName: string;
  /** True when the pull request has the `full-ci` label. */
  readonly fullCiLabel: boolean;
  /** True when the diff touches `.github/workflows`. */
  readonly workflowsChanged: boolean;
  /** Pull request title, or empty on a push. */
  readonly title: string;
};

/**
 * Whether the full tier is required.
 *
 * @param input - Event, labels, path signal, and title
 * @returns True when tier 2 must run and `gate / check` must require it
 */
export function fullTierRequested(input: FullTierInput): boolean {
  if (input.eventName === "push") return true;
  if (input.fullCiLabel) return true;
  if (input.workflowsChanged) return true;
  if (input.title.startsWith("chore(release)")) return true;
  return false;
}

function flag01(value: string | undefined): boolean {
  if (value !== "0" && value !== "1") {
    throw new Error(
      `usage: bun ./scripts/ci-tier.ts --event <name> --full-ci <0|1> --workflows <0|1>`,
    );
  }
  return value === "1";
}

function writeFull(full: boolean): void {
  const line = `full=${full ? "true" : "false"}\n`;
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined && output.length > 0) appendFileSync(output, line);
  process.stdout.write(line);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        event: { type: "string" },
        "full-ci": { type: "string" },
        workflows: { type: "string" },
      },
      args: process.argv.slice(2),
      strict: true,
    });
    if (values.event === undefined) {
      throw new Error(
        "usage: bun ./scripts/ci-tier.ts --event <name> --full-ci <0|1> --workflows <0|1>",
      );
    }
    writeFull(
      fullTierRequested({
        eventName: values.event,
        fullCiLabel: flag01(values["full-ci"]),
        workflowsChanged: flag01(values.workflows),
        title: process.env.OKM_PR_TITLE ?? "",
      }),
    );
  } catch (error: unknown) {
    console.error("[ci-tier]", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
