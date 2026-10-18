/**
 * Cheap check that `docs/compatibility.md` matches the suite case list.
 *
 * The live conformance comparison is `compatibility.test.ts` (full tier).
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listCompatibilityCaseNames, supportSentence } from "../scripts/compatibility.js";
import { repoRoot } from "../scripts/root.js";

test("compatibility table file is in sync", () => {
  const committed = readFileSync(join(repoRoot(), "docs/compatibility.md"), "utf8");
  expect(committed).toContain(supportSentence());
  expect(committed).toContain("| Case |");
  expect(committed).toContain("| PGlite |");
  const names = listCompatibilityCaseNames();
  expect(names.length).toBeGreaterThan(0);
  const rows = committed
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const header = rows[0];
  if (header === undefined) throw new Error("compatibility table has no header");
  expect(header[0]).toBe("Case");
  const body = rows.slice(2).filter((row) => (row[0] ?? "") !== "---" && (row[0] ?? "").length > 0);
  const committedNames = body.map((row) => row[0] ?? "");
  expect(committedNames).toEqual([...names]);
  for (const row of body) {
    for (const cell of row.slice(1)) {
      expect(["pass", "skip", "fail", "not-run"]).toContain(cell);
    }
  }
});
