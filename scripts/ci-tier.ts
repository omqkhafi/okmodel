/**
 * Heavy jobs run after merge: a push to `main`, and the nightly schedule.
 *
 * A pull request does not request them. `full-ci` and `needs: postgres` do
 * not add jobs.
 *
 *   bun ./scripts/ci-tier.ts --event pull_request
 *
 * Writes `heavy=true` or `heavy=false` to `GITHUB_OUTPUT` when that file is set.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

/**
 * Whether the heavy tier runs for this event.
 *
 * @param eventName - `pull_request`, `push`, or `schedule`
 * @returns True for a push or a schedule
 */
export function heavyTierRequested(eventName: string): boolean {
  return eventName === "push" || eventName === "schedule";
}

function writeHeavy(heavy: boolean): void {
  const line = `heavy=${heavy ? "true" : "false"}\n`;
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined && output.length > 0) appendFileSync(output, line);
  process.stdout.write(line);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { event: { type: "string" } },
      args: process.argv.slice(2),
      strict: true,
    });
    if (values.event === undefined) {
      throw new Error("usage: bun ./scripts/ci-tier.ts --event <name>");
    }
    writeHeavy(heavyTierRequested(values.event));
  } catch (error: unknown) {
    console.error("[ci-tier]", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
