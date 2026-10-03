/**
 * The Docker suite discovers every test file, and the release workflow waits for it.
 */

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { POSTGRES_VERSIONS } from "../packages/harness/src/version.js";
import { renderCompatibility, supportSentence } from "../scripts/compatibility.js";
import { verifyVersions } from "../scripts/verify.js";
import { changelogReleaseNotes, milestoneTitle } from "../scripts/github-release.js";
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
  const sentence = supportSentence();
  expect(sentence).toContain("Supported majors are Postgres 15, 16, 17, and 18.");
  expect(sentence).toContain(
    "The floor is 15: Postgres 13 is past end of life, 14 ends in November 2026, and 15 gives us features we can use later.",
  );
  expect(sentence).toContain(
    "A pull request runs the suite on 15 and 18 and the tarball job on 18.",
  );
  const committed = readFileSync(join(root, "docs/compatibility.md"), "utf8");
  expect(committed).toContain(sentence);
  expect(renderCompatibility([])).toContain(sentence);
  expect([...POSTGRES_VERSIONS]).toEqual(["15", "16", "17", "18"]);
});

test("changelog release notes are the version section", () => {
  const notes = changelogReleaseNotes(
    "## Unreleased\n\n## v0.1.1 — 2026-10-03\n\n- One\n\n## v0.1.0 — 2026-10-03\n\n- Older\n",
    "0.1.1",
  );
  expect(notes).toBe("- One\n");
  const shipped = changelogReleaseNotes(readFileSync(join(root, "changelog.md"), "utf8"), "0.1.1");
  expect(shipped).toContain("Supported Postgres majors are 15, 16, 17, and 18.");
  expect(shipped.startsWith("## v")).toBe(false);
});

test("a release milestone drops a trailing .0", () => {
  expect(milestoneTitle("0.2.0")).toBe("0.2");
  expect(milestoneTitle("0.1.1")).toBe("0.1.1");
  expect(milestoneTitle("0.10.0")).toBe("0.10");
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
  expect(postgres).toContain("fromJSON(inputs.suite_versions)");
  expect(postgres).toContain("fromJSON(inputs.tarball_versions)");
  expect(postgres).toContain("OKMODEL_TARBALL");
  expect(postgres).toContain("inputs.tarball_artifact");
  expect(matrixVersions(postgres)).toEqual([]);
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  expect(release).toContain("group: release");
  expect(release).toContain("cancel-in-progress: false");
  expect(release).toContain("uses: ./.github/workflows/postgres.yml");
  expect(release).toContain("needs: tag");
  expect(release).toContain("needs: gate");
  expect(release).toContain("needs: publish");
  expect(release).toContain("needs: smoke");
  const releaseRef = release.indexOf("bun ./scripts/release-ref.ts");
  const gate = release.indexOf("uses: ./.github/workflows/postgres.yml");
  expect(releaseRef).toBeGreaterThan(-1);
  expect(releaseRef).toBeLessThan(gate);
  expect(release.indexOf("bun ./scripts/release-ref.ts", releaseRef + 1)).toBe(-1);
  expect(release).toContain("tarball_artifact: release-tarball");
  expect(release).toContain("npm publish packed/okmodel.tgz --access public");
  expect(release).toContain('NPM_CONFIG_PROVENANCE: "true"');
  expect(release).toContain("bun ./scripts/npm-smoke.ts");
  expect(release).toContain("bun ./scripts/github-release.ts");
  expect(jsonVersions(release, "suite_versions")).toEqual([...POSTGRES_VERSIONS]);
  expect(jsonVersions(release, "tarball_versions")).toEqual([...POSTGRES_VERSIONS]);
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain("uses: ./.github/workflows/postgres.yml");
  expect(ci).not.toContain("tests/harness.test.ts");
  expect(ci).toMatch(/push:\n {4}branches:\n {6}- main\n/);
  expect(ci).toContain("pull_request:");
  expect(ci).toContain("cancel-in-progress: true");
  expect(ci).toContain("${{ github.workflow }}-${{ github.ref }}");
  const floor = POSTGRES_VERSIONS[0];
  const newest = POSTGRES_VERSIONS[POSTGRES_VERSIONS.length - 1];
  if (floor === undefined || newest === undefined) throw new Error("no postgres versions");
  expect(jsonVersions(ci, "suite_versions")).toEqual([floor, newest]);
  expect(jsonVersions(ci, "tarball_versions")).toEqual([newest]);
  const weekly = readFileSync(join(root, ".github/workflows/weekly.yml"), "utf8");
  expect(weekly).toContain('cron: "0 6 * * 1"');
  expect(weekly).toContain("uses: ./.github/workflows/postgres.yml");
  expect(jsonVersions(weekly, "suite_versions")).toEqual([...POSTGRES_VERSIONS]);
  expect(jsonVersions(weekly, "tarball_versions")).toEqual([...POSTGRES_VERSIONS]);
});

test("verify runs one version unless --all", () => {
  expect(verifyVersions([], {})).toEqual(["17"]);
  expect(verifyVersions([], { POSTGRES_VERSION: "16" })).toEqual(["16"]);
  expect(verifyVersions(["--all"], { POSTGRES_VERSION: "16" })).toEqual([...POSTGRES_VERSIONS]);
  expect(verifyVersions(["--", "--all"], {})).toEqual([...POSTGRES_VERSIONS]);
  expect(() => verifyVersions(["--nope"], {})).toThrow(/Usage/);
  expect(() => verifyVersions([], { POSTGRES_VERSION: "14" })).toThrow(/outside 15/);
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

function jsonVersions(yaml: string, key: string): readonly string[] {
  const match = new RegExp(`${key}:\\s*'(\\[[^']*\\])'`).exec(yaml);
  const body = match?.[1];
  if (body === undefined) throw new Error(`missing ${key}`);
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${key} is not a string list`);
  }
  return parsed;
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
