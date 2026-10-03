/**
 * The tag the Release workflow may publish.
 *
 * The tag is `v` plus the `package.json` version. Any other ref is refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/**
 * Refuses a workflow ref that is not `refs/tags/v` plus `version`.
 *
 * @param ref - `GITHUB_REF`, such as `refs/tags/v0.1.1`
 * @param version - `package.json` version, such as `0.1.1`
 * @returns The refusal, or undefined when the ref is that tag
 */
export function releaseRefProblem(ref: string | undefined, version: string): string | undefined {
  const expected = `refs/tags/v${version}`;
  if (ref === expected) return undefined;
  const shown = ref === undefined || ref.length === 0 ? "(unset)" : ref;
  return `Refusing to publish from ${shown}. package.json is ${version}, so the tag must be v${version}. Run: gh workflow run release.yml --ref v${version}`;
}

function readVersion(root: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("package.json has no version");
  }
  const version = parsed.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json version is not a string");
  }
  return version;
}

if (import.meta.main) {
  const version = readVersion(repoRoot());
  const problem = releaseRefProblem(process.env.GITHUB_REF, version);
  exitOnProblems(problem === undefined ? [] : [problem]);
}
