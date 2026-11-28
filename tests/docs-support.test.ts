/**
 * Generated support data matches the registry, the quoted sentences, and the
 * frontmatter lint.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { POSTGRES_FEATURES } from "../src/tooling/capabilities/postgres.js";
import { FRONTMATTER_EXEMPT, FRONTMATTER_EXEMPT_CEILING } from "../scripts/frontmatter-exempt.js";
import {
  frontmatterFieldProblems,
  handbookProblems,
  isOneSentence,
  unmappedFeatures,
} from "../scripts/docs-frontmatter.js";
import { checkReadmeSupport } from "../scripts/readme-check.js";
import {
  TESTED_MATRIX_NOTE,
  docsConstants,
  docsOnlyRule,
  docsSupportProblems,
  engineRule,
  engines,
  featureRules,
  readmeConstantsBlock,
  readmeSupportTable,
} from "../scripts/docs-support.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("the generated modules equal the registry", () => {
  expect(docsSupportProblems(root)).toEqual([]);
  expect(Object.keys(featureRules())).toEqual(Object.keys(POSTGRES_FEATURES));
  expect(featureRules()["temporal.keys"]?.label).toBe("18+");
  expect(featureRules()["temporal.keys"]?.line).toBe(
    "PostgreSQL 18+, tested 15 to 19, native since 18",
  );
  expect(featureRules()["column.generated"]?.kind).toBe("any");
  expect(featureRules()["constraint.exclusion"]?.label).toBe("any");
  expect(docsConstants(root).featureCount).toBe(Object.keys(POSTGRES_FEATURES).length);
  expect(docsConstants(root).supportPhrase).toBe("PostgreSQL 15 and later; tested on 15 to 19");
});

test("a since and a max are a range, and a refusal is none", () => {
  const engine = engines().postgres;
  if (engine === undefined) throw new Error("postgres missing");
  const range = engineRule(engine, { support: "native", since: "16", max: "18" });
  expect(range.kind).toBe("range");
  expect(range.label).toBe("16–18");
  expect(range.versions.find((row) => row.version === 15)?.available).toBe(false);
  expect(range.versions.find((row) => row.version === 16)?.available).toBe(true);
  expect(range.versions.find((row) => row.version === 19)?.available).toBe(false);
  const refused = engineRule(engine, { support: "refused" });
  expect(refused.kind).toBe("none");
  expect(refused.line).toBe("PostgreSQL none");
  const emulated = engineRule(engine, { support: "emulated" });
  expect(emulated.kind).toBe("bundled");
  expect(emulated.label).toBe("bundled");
  const docsOnly = docsOnlyRule(engine);
  expect(docsOnly.docsOnly).toBe(true);
  expect(docsOnly.line).toBe("PostgreSQL 15+, tested 15 to 19, docs only, no proof");
  expect(TESTED_MATRIX_NOTE).toBe("CI ran on 18, full matrix at release");
});

test("the README blocks match the generator", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  expect(checkReadmeSupport(readme)).toEqual([]);
  expect(readme).toContain(readmeConstantsBlock());
  expect(readme).toContain(readmeSupportTable());
});

test("the exemption list only shrinks and the pilots are not on it", () => {
  expect(FRONTMATTER_EXEMPT.length).toBeLessThanOrEqual(FRONTMATTER_EXEMPT_CEILING);
  expect(FRONTMATTER_EXEMPT.length).toBe(115);
  expect(FRONTMATTER_EXEMPT).not.toContain("schema/defaults.mdx");
  expect(FRONTMATTER_EXEMPT).not.toContain("schema/range-types.mdx");
  expect(handbookProblems(root)).toEqual([]);
});

test("a page off the exemption list fails a broken summary or an unknown key", () => {
  const keys = new Set(Object.keys(POSTGRES_FEATURES));
  expect(
    isOneSentence("A missing value is filled from nullable through a generated expression."),
  ).toBe(true);
  expect(isOneSentence("Two sentences. Here.")).toBe(false);
  const valid = frontmatterFieldProblems(
    {
      title: "Defaults",
      summary: "A missing value is filled from nullable through a generated expression.",
      since: "0.10",
      status: "stable",
    },
    "schema/defaults.mdx",
    keys,
  );
  expect(valid).toEqual([]);
  const broken = frontmatterFieldProblems(
    { title: "Defaults", summary: "Not one sentence. Really.", since: "soon", status: "nope" },
    "new.mdx",
    keys,
  );
  expect(broken.length).toBeGreaterThan(0);
  const unknown = frontmatterFieldProblems(
    {
      title: "Defaults",
      summary: "A missing value is filled from nullable through a generated expression.",
      since: "0.10",
      status: "stable",
      feature: "no.such",
    },
    "new.mdx",
    keys,
  );
  expect(unknown).toContain("new.mdx: feature no.such is not a registry key");
});

test("unmapped registry keys are a list and the pilot keys are mapped", () => {
  const unmapped = unmappedFeatures(root);
  expect(unmapped.length).toBeGreaterThan(0);
  expect(unmapped).not.toContain("column.generated");
  expect(unmapped).not.toContain("constraint.exclusion");
  expect(unmapped).not.toContain("temporal.keys");
  expect(unmapped.length).toBe(Object.keys(POSTGRES_FEATURES).length - 3);
});
