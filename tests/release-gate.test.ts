/**
 * The Docker suite discovers every test file, and the release workflow waits for it.
 */

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { POSTGRES_VERSIONS } from "../packages/harness/src/version.js";
import { renderCompatibility } from "../scripts/compatibility.js";
import { changelogReleaseNotes } from "../scripts/github-release.js";
import { publishedPackageProblem } from "../scripts/npm-smoke.js";
import {
  POSTGRES_EXCLUSIONS,
  POSTGRES_KNOWN_FAILURES,
  discoverTestFiles,
  postgresSuitePlan,
} from "../scripts/postgres-suite.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("the postgres suite runs every test file except the named omissions", () => {
  const discovered = discoverTestFiles(root);
  expect(discovered.length).toBeGreaterThan(0);
  expect(discovered).toContain("tests/migrate-pg.test.ts");
  expect(discovered).toContain("tests/quickstart.test.ts");
  expect(discovered).toContain("scripts/bump-version.test.ts");
  for (const item of POSTGRES_EXCLUSIONS) {
    expect(item.reason.trim().length).toBeGreaterThan(0);
    expect(discovered, item.file).toContain(item.file);
  }
  for (const item of POSTGRES_KNOWN_FAILURES) {
    expect(item.reason.trim().length).toBeGreaterThan(0);
    expect(item.versions.length).toBeGreaterThan(0);
    expect(discovered, item.file).toContain(item.file);
    for (const version of item.versions) {
      expect(POSTGRES_VERSIONS).toContain(version);
    }
  }
  const excluded = new Set(POSTGRES_EXCLUSIONS.map((item) => item.file));
  for (const version of POSTGRES_VERSIONS) {
    const plan = postgresSuitePlan(root, version);
    const known = new Set(
      POSTGRES_KNOWN_FAILURES.filter((item) => item.versions.includes(version)).map(
        (item) => item.file,
      ),
    );
    expect(plan.known.map((item) => item.file)).toEqual([...known]);
    for (const file of discovered) {
      const runs = plan.run.includes(file);
      if (excluded.has(file) || known.has(file)) expect(runs).toBe(false);
      else expect(runs).toBe(true);
    }
  }
});

test("compatibility names the supported majors", () => {
  const sentence =
    "Supported majors are Postgres 13, 14, 15, 16, 17, and 18. Identity columns need Postgres 10. `gen_random_uuid()` is built in from Postgres 13, and that version is the floor because the portable UUID default uses it. `uuidv7()` needs Postgres 18.";
  const committed = readFileSync(join(root, "docs/compatibility.md"), "utf8");
  expect(committed).toContain(sentence);
  expect(renderCompatibility([])).toContain(sentence);
  expect([...POSTGRES_VERSIONS]).toEqual(["13", "14", "15", "16", "17", "18"]);
});

test("changelog release notes are the version section", () => {
  const notes = changelogReleaseNotes(
    "## Unreleased\n\n## v0.1.1 — 2026-10-03\n\n- One\n\n## v0.1.0 — 2026-10-03\n\n- Older\n",
    "0.1.1",
  );
  expect(notes).toBe("- One\n");
  const shipped = changelogReleaseNotes(readFileSync(join(root, "changelog.md"), "utf8"), "0.1.1");
  expect(shipped).toContain("postgres job runs every test file");
  expect(shipped.startsWith("## v")).toBe(false);
});

test("published package problem names a missing version and missing provenance", () => {
  expect(publishedPackageProblem({ version: "0.1.0" }, "0.1.1")).toContain("0.1.0");
  expect(publishedPackageProblem({ version: "0.1.1" }, "0.1.1")).toContain("provenance");
  expect(
    publishedPackageProblem(
      {
        version: "0.1.1",
        "dist.attestations": { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
      },
      "0.1.1",
    ),
  ).toBeUndefined();
  expect(
    publishedPackageProblem(
      {
        version: "0.1.1",
        dist: { attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } },
      },
      "0.1.1",
    ),
  ).toBeUndefined();
});

test("workflows pin third-party actions and release waits for the matrix", () => {
  const workflows = readdirSync(join(root, ".github/workflows")).filter((name) =>
    name.endsWith(".yml"),
  );
  expect(workflows).toContain("postgres.yml");
  expect(workflows).toContain("release.yml");
  for (const name of workflows) {
    const yaml = readFileSync(join(root, ".github/workflows", name), "utf8");
    expect(unpinnedActions(yaml), name).toEqual([]);
  }
  const postgres = readFileSync(join(root, ".github/workflows/postgres.yml"), "utf8");
  expect(postgres).toContain("bun ./scripts/postgres-suite.ts");
  expect(postgres).toContain("bun ./scripts/tarball-smoke.ts");
  expect(postgres).not.toContain("tests/harness.test.ts");
  expect(matrixVersions(postgres)).toEqual([[...POSTGRES_VERSIONS], [...POSTGRES_VERSIONS]]);
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  expect(release).toContain("group: release");
  expect(release).toContain("cancel-in-progress: false");
  expect(release).toContain("uses: ./.github/workflows/postgres.yml");
  expect(release).toContain("needs: gate");
  expect(release).toContain("needs: publish");
  expect(release).toContain("needs: smoke");
  expect(release).toContain("bun ./scripts/release-ref.ts");
  expect(release).toContain("npm publish --access public");
  expect(release).toContain('NPM_CONFIG_PROVENANCE: "true"');
  expect(release).toContain("bun ./scripts/npm-smoke.ts");
  expect(release).toContain("bun ./scripts/github-release.ts");
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain("uses: ./.github/workflows/postgres.yml");
  expect(ci).not.toContain("tests/harness.test.ts");
});

function unpinnedActions(yaml: string): readonly string[] {
  const problems: string[] = [];
  for (const match of yaml.matchAll(/^\s*uses:\s*(\S+)/gm)) {
    const uses = match[1];
    if (uses === undefined || uses.startsWith("./")) continue;
    if (/@[0-9a-f]{40}$/.test(uses)) continue;
    problems.push(uses);
  }
  return problems;
}

function matrixVersions(yaml: string): readonly (readonly string[])[] {
  const lists: string[][] = [];
  for (const match of yaml.matchAll(/version:\s*\[([^\]]+)\]/g)) {
    const body = match[1] ?? "";
    lists.push(
      body
        .split(",")
        .map((item) => item.trim().replaceAll('"', ""))
        .filter((item) => item.length > 0),
    );
  }
  return lists;
}
