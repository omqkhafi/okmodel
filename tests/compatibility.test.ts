/**
 * The compatibility table matches a fresh conformance run.
 *
 * Prose comes from `site/content/docs/reference/compatibility.mdx` via
 * `docs:pack`. This test compares the Case table only. The cheap case-list
 * sync is `compatibility-sync.test.ts`. PGlite always runs. postgres.js runs
 * when the topology is up, which the postgres CI job provides.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { collectCompatibility, renderCompatibility } from "../scripts/compatibility.js";
import { ensurePackedDocs } from "../scripts/docs-pack.js";
import { repoRoot } from "../scripts/root.js";

test("compatibility table matches the conformance run", async () => {
  const root = repoRoot();
  ensurePackedDocs(root);
  const cells = await collectCompatibility();
  const committed = readFileSync(join(root, "docs/compatibility.md"), "utf8");
  const fresh = renderCompatibility(cells);
  const drivers = ["postgres.js", "node-postgres", "Bun.sql", "PGlite"] as const;
  expect(column(committed, "PGlite")).toEqual(column(fresh, "PGlite"));
  if (cells.some((cell) => cell.driver === "postgres.js")) {
    for (const driver of drivers) {
      expect(column(committed, driver)).toEqual(column(fresh, driver));
    }
  }
}, 120_000);

function column(markdown: string, driver: string): ReadonlyMap<string, string> {
  const rows = markdown
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
  const index = header.indexOf(driver);
  if (index === -1) throw new Error(`compatibility table has no ${driver} column`);
  const result = new Map<string, string>();
  for (const row of rows.slice(2)) {
    const name = row[0];
    const cell = row[index];
    if (name === undefined || cell === undefined || name === "---") continue;
    result.set(name, cell);
  }
  return result;
}
