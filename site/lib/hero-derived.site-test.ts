/**
 * The hero shows what the library produced for each schema edit, not prose.
 * This runs the real `okm generate` and `okm build` again and fails when
 * `hero-derived.json` is not what they print now.
 * Regenerate with `bun site/scripts/hero-derived.ts --write`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { generateHeroDerived } from "../scripts/hero-derived";
import { heroSpecs } from "./hero";
import { siteRoot } from "./repo";

const checkedIn: unknown = JSON.parse(
  readFileSync(join(siteRoot(), "lib/hero-derived.json"), "utf8"),
);

test("hero-derived.json is what the library produces now", () => {
  expect(generateHeroDerived()).toEqual(checkedIn as ReturnType<typeof generateHeroDerived>);
}, 180_000);

test("every scenario has the output its kind shows", () => {
  const { scenarios } = checkedIn as ReturnType<typeof generateHeroDerived>;
  expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(
    heroSpecs().map((spec) => spec.id).sort(),
  );
  for (const scenario of scenarios) {
    if (scenario.kind === "migrate") {
      expect(scenario.diff.some((row) => row.mark === "add" || row.mark === "del"), scenario.id).toBe(true);
      expect(scenario.plan.steps.length, scenario.id).toBeGreaterThan(0);
    } else {
      expect(scenario.code.some((row) => row.mark === "hot"), scenario.id).toBe(true);
      expect(scenario.sql.text.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.result.text.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.rules.length, scenario.id).toBeGreaterThan(0);
    }
  }
});
