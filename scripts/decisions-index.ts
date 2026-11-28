/**
 * Rewrites `docs/decisions/INDEX.md` from the decision files on disk.
 *
 *   bun ./scripts/decisions-index.ts
 */

import { writeDecisionIndex } from "./decisions.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

if (import.meta.main) {
  exitOnProblems([...writeDecisionIndex(repoRoot())]);
  console.log("decisions-index: wrote docs/decisions/INDEX.md");
}
