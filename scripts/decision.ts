/**
 * Prints one decision, or the next free number.
 *
 *   bun ./scripts/decision.ts D91
 *   bun ./scripts/decision.ts --next
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DECISIONS_DIR, loadDecisionRecords, nextDecisionId } from "./decisions.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

if (import.meta.main) {
  const root = repoRoot();
  const [argument] = process.argv.slice(2);
  const loaded = loadDecisionRecords(root);
  if (loaded.problems.length > 0) exitOnProblems(loaded.problems);
  if (argument === "--next") {
    console.log(nextDecisionId(loaded.records.map((record) => record.id)));
  } else if (argument !== undefined && /^D\d+[a-z]?$/.test(argument)) {
    const found = loaded.records.some((record) => record.id === argument);
    if (!found) exitOnProblems([`decision: no file for ${argument}`]);
    process.stdout.write(readFileSync(join(root, DECISIONS_DIR, `${argument}.md`), "utf8"));
  } else {
    exitOnProblems(["decision: usage is D### or --next"]);
  }
}
