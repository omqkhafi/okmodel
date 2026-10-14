import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { applyEdits, HERO_BASE_SCHEMA, HERO_CONTRACT, HERO_GROUPS, HERO_SCENARIOS, heroSpecs } from "./hero";
import { HERO_QUERIES } from "./hero-queries";
import { repoRoot } from "./repo";

test("every scenario edit matches its base schema exactly once", () => {
  for (const spec of HERO_SCENARIOS) {
    const edited = applyEdits(spec);
    expect(edited, spec.id).not.toBe(spec.base ?? HERO_BASE_SCHEMA);
  }
});

test("scenario ids and migration names are unique", () => {
  const specs = heroSpecs();
  expect(new Set(specs.map((spec) => spec.id)).size).toBe(specs.length);
  expect(new Set(HERO_SCENARIOS.map((spec) => spec.name)).size).toBe(HERO_SCENARIOS.length);
});

test("every group has scenarios and every scenario names a group", () => {
  const known = new Set(HERO_GROUPS.map((group) => group.id));
  for (const spec of heroSpecs()) expect(known.has(spec.group), spec.id).toBe(true);
  for (const group of HERO_GROUPS) {
    expect(heroSpecs().some((spec) => spec.group === group.id), group.id).toBe(true);
  }
});

test("a query scenario shows lines that are in the schema it runs", () => {
  for (const spec of HERO_QUERIES) {
    expect(spec.schema.includes(spec.model), spec.id).toBe(true);
    expect(spec.schema, spec.id).toContain("const app =");
  }
});

test("the base schema is a default-exported schema", () => {
  expect(HERO_BASE_SCHEMA).toContain("export default schema(");
});

test("the contract cells repeat claims the README makes", () => {
  const readme = readFileSync(join(repoRoot(), "README.md"), "utf8");
  expect(HERO_CONTRACT).toContain("PostgreSQL 15–18");
  expect(readme).toContain("PostgreSQL 15 to 18");
  expect(readme).toContain("Apache-2.0");
});
