/**
 * Splits `docs/okmodel-decisions.md` into `docs/decisions/D###.md`.
 *
 * Re-runnable. On a rebase that brings the old file back from main:
 * check out main's copy, run this script, then delete the old file.
 * Ids that are only in the old file are overwritten. Other decision
 * files are left in place. The script does not delete the old file.
 *
 *   bun ./scripts/split-decisions.ts
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { DECISIONS_TEMPLATE, splitDecisions } from "./decisions.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

if (import.meta.main) {
  const root = repoRoot();
  const problems = [...splitDecisions(root)];
  if (!existsSync(join(root, DECISIONS_TEMPLATE))) {
    problems.push(`split-decisions: missing ${DECISIONS_TEMPLATE}`);
  }
  exitOnProblems(problems);
  console.log("split-decisions: wrote docs/decisions");
}
