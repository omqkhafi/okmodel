/**
 * The Docker suite discovers every test file, and the release workflow waits for it.
 */

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { POSTGRES_VERSIONS } from "../packages/harness/src/version.js";
import { renderCompatibility, supportSentence } from "../scripts/compatibility.js";
import { verifyVersions } from "../scripts/verify.js";
import {
  changelogReleaseNotes,
  closesMilestone,
  milestoneTitle,
} from "../scripts/github-release.js";
import {
  ATTEMPTS,
  WAIT_MS,
  provenanceCommitProblem,
  publishedInstallArgs,
  publishedPackageProblem,
} from "../scripts/npm-smoke.js";
import {
  POSTGRES_EXCLUSIONS,
  POSTGRES_KNOWN_FAILURES,
  discoverTestFiles,
  postgresSuitePlan,
} from "../scripts/postgres-suite.js";
import { releaseWorkflowProblems } from "../scripts/release-workflow.js";
import { repoRoot } from "../scripts/root.js";
import {
  NPM_FLOOR,
  NODE_FLOOR,
  stagePublishCommand,
  versionBelow,
} from "../scripts/stage-publish.js";

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
    "A pull request runs real Postgres only with the label `needs: postgres`: the suite on 15 and 18 and the tarball job on 18.",
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
  expect(closesMilestone("0.10.0")).toBe(true);
  expect(closesMilestone("0.10.0-next.1")).toBe(false);
});

test("stage publish uses an explicit path and the next tag for a prerelease", () => {
  expect(stagePublishCommand("./packed/okmodel.tgz", "0.10.0")).toEqual([
    "npm",
    "stage",
    "publish",
    "./packed/okmodel.tgz",
    "--access",
    "public",
    "--provenance",
  ]);
  expect(stagePublishCommand("./packed/okmodel.tgz", "0.10.0-next.1")).toEqual([
    "npm",
    "stage",
    "publish",
    "./packed/okmodel.tgz",
    "--access",
    "public",
    "--provenance",
    "--tag",
    "next",
  ]);
  expect(() => stagePublishCommand("packed/okmodel.tgz", "0.10.0")).toThrow(/git shorthand/);
  expect(versionBelow("11.14.9", NPM_FLOOR)).toBe(true);
  expect(versionBelow("11.15.0", NPM_FLOOR)).toBe(false);
  expect(versionBelow("22.13.1", NODE_FLOOR)).toBe(true);
  expect(versionBelow("22.14.0", NODE_FLOOR)).toBe(false);
  expect(versionBelow("24.0.0", NODE_FLOOR)).toBe(false);
});

test("the release workflow is SHA-pinned and scopes publish permissions", () => {
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  expect(releaseWorkflowProblems(release)).toEqual([]);
  const dependabot = readFileSync(join(root, ".github/dependabot.yml"), "utf8");
  expect(dependabot).toContain("package-ecosystem: github-actions");
});

test("npm smoke waits out registry processing and skips bun's manifest cache", () => {
  expect((ATTEMPTS - 1) * WAIT_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
  expect(publishedInstallArgs("0.8.0")).toEqual([
    "bun",
    "add",
    "--no-cache",
    "okmodel@0.8.0",
    "postgres",
  ]);
  expect(readFileSync(join(root, "docs/release.md"), "utf8")).toContain(
    "at most 31 times, 30 seconds apart",
  );
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

test("published provenance must record the QA'd commit", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  expect(provenanceCommitProblem(provenanceDocument([sha]), sha)).toBeUndefined();
  expect(provenanceCommitProblem(provenanceDocument([sha.toUpperCase()]), sha)).toBeUndefined();
  expect(provenanceCommitProblem(provenanceDocument([other]), sha)).toBe(
    `provenance records commit ${other}, not the QA'd commit ${sha}`,
  );
  expect(provenanceCommitProblem(provenanceDocument([sha, other]), sha)).toContain(other);
  expect(provenanceCommitProblem(provenanceDocument([]), sha)).toBe(
    "provenance does not record a git commit",
  );
  expect(provenanceCommitProblem({ attestations: [] }, sha)).toBe(
    "provenance attestation is missing",
  );
  expect(provenanceCommitProblem({}, sha)).toBe(
    "npm attestations response is not an attestations document",
  );
  expect(provenanceCommitProblem(provenanceDocument([sha]), "abc")).toContain("40-hex");
  expect(provenanceCommitProblem(provenanceDocument([sha], true), sha)).toBeUndefined();
});

test("the release workflow checks the tag before any build", () => {
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  expect(release).toContain("fetch-depth: 0");
  expect(release).toContain("fetch-tags: true");
  expect(release).toContain("git fetch origin main");
  expect(release).toContain("git merge-base --is-ancestor HEAD origin/main");
  expect(release).toContain("bun ./scripts/release-ref.ts");
  expect(release).not.toContain("inputs.commit");
  expect(release).not.toContain("pull_request_target");
  const guard = release.indexOf("git merge-base --is-ancestor");
  const build = release.indexOf("run: bun run build");
  expect(guard).toBeGreaterThan(-1);
  expect(build).toBeGreaterThan(guard);
});

test("the site deploys only after a successful release of a stable tag", () => {
  const yaml = readFileSync(join(root, ".github/workflows/deploy-vercel.yml"), "utf8");
  expect(yaml).toContain("workflows: [Release]");
  expect(yaml).toContain("types: [completed]");
  expect(yaml).toContain("workflow_dispatch:");
  expect(yaml).toContain("required: true");
  expect(yaml).toContain(
    "github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'",
  );
  expect(yaml).toContain("group: deploy-vercel");
  expect(yaml).toContain("cancel-in-progress: false");
  expect(yaml).toContain("contents: write");
  expect(yaml).not.toContain("contents: read");
  expect(yaml).not.toContain("secrets.");
  expect(yaml).toContain("bun ./scripts/deploy-ref.ts");
  expect(yaml).toContain("bun ./scripts/deploy-ref.ts --confirm");
  expect(yaml).toContain("bun-version: 1.4.3");
  expect(yaml).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1");
  expect(yaml).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2");
  expect(yaml).not.toContain("type: choice");
  expect(yaml).not.toContain("inputs.target");
  expect(yaml).not.toContain("--preview-url");
  expect(yaml).not.toContain("bunx vercel");
  expect(yaml).not.toContain("VERCEL_");
  expect(yaml).toContain('git push --force origin "$SHA:refs/heads/release"');
  expect(yaml).toContain("^[0-9a-f]{40}$");
  expect(yaml.split("\n").filter((line) => line.includes("permissions:"))).toEqual([
    "    permissions:",
  ]);
  expect(yaml).not.toMatch(/^environment:/m);
  const deployRef = readFileSync(join(root, "scripts/deploy-ref.ts"), "utf8");
  expect(deployRef).toContain("releaseRefProblem");
  expect(deployRef).toContain("site/lib/site-identity.ts");
  expect(deployRef).toContain("declaredSiteOrigin");
  expect(deployRef).not.toContain("preview-url");
  expect(deployRef).not.toContain("DEPLOY_JSON");
  const vercel = JSON.parse(readFileSync(join(root, "site/vercel.json"), "utf8")) as unknown;
  expect(vercel).toEqual({ git: { deploymentEnabled: { main: false } } });
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  expect(release).not.toContain("deploy-vercel");
});

test("workflows pin third-party actions and release waits for the matrix", () => {
  const workflows = readdirSync(join(root, ".github/workflows")).filter((name) =>
    name.endsWith(".yml"),
  );
  expect(workflows).toContain("postgres-suite.yml");
  expect(workflows).toContain("postgres-tarball.yml");
  expect(workflows).toContain("release.yml");
  for (const name of workflows) {
    const yaml = readFileSync(join(root, ".github/workflows", name), "utf8");
    expect(unpinnedActions(yaml), name).toEqual([]);
  }
  const suite = readFileSync(join(root, ".github/workflows/postgres-suite.yml"), "utf8");
  const tarball = readFileSync(join(root, ".github/workflows/postgres-tarball.yml"), "utf8");
  expect(suite).toContain("bun ./scripts/postgres-suite.ts");
  expect(suite).not.toContain("tests/harness.test.ts");
  expect(suite).toContain("fromJSON(inputs.versions)");
  expect(tarball).toContain("bun ./scripts/tarball-smoke.ts");
  expect(tarball).toContain("fromJSON(inputs.versions)");
  expect(tarball).toContain("OKMODEL_TARBALL");
  expect(tarball).toContain("inputs.tarball_artifact");
  expect(matrixVersions(suite)).toEqual([]);
  expect(matrixVersions(tarball)).toEqual([]);
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  expect(release).toContain("group: release");
  expect(release).toContain("cancel-in-progress: false");
  expect(release).toContain("uses: ./.github/workflows/postgres-suite.yml");
  expect(release).toContain("uses: ./.github/workflows/postgres-tarball.yml");
  expect(release).toContain("needs: tag");
  expect(release).toContain("needs: gate");
  expect(release).toContain("name: publish / npm");
  const releaseRef = release.indexOf("bun ./scripts/release-ref.ts");
  const gate = release.indexOf("uses: ./.github/workflows/postgres-suite.yml");
  expect(releaseRef).toBeGreaterThan(-1);
  expect(releaseRef).toBeLessThan(gate);
  expect(release.indexOf("bun ./scripts/release-ref.ts", releaseRef + 1)).toBe(-1);
  expect(release).toContain("tarball_artifact: release-tarball");
  expect(release).toContain("bun ./scripts/stage-publish.ts ./packed/okmodel.tgz");
  expect(release).toContain('NPM_CONFIG_PROVENANCE: "true"');
  expect(release).toContain("environment: release");
  expect(release).toContain("bun ./scripts/github-release.ts");
  expect(release).toContain("name: verify / published");
  expect(release).toContain("needs: publish");
  expect(release).toContain("bun ./scripts/verify-release.ts");
  const publishAt = release.indexOf("name: publish / npm");
  const verifyAt = release.indexOf("bun ./scripts/verify-release.ts");
  expect(publishAt).toBeGreaterThan(-1);
  expect(verifyAt).toBeGreaterThan(publishAt);
  expect(release).not.toContain("bun ./scripts/npm-smoke.ts");
  expect(jsonVersionLists(release, "versions")).toEqual([
    [...POSTGRES_VERSIONS],
    [...POSTGRES_VERSIONS],
  ]);
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain("uses: ./.github/workflows/postgres-suite.yml");
  expect(ci).toContain("uses: ./.github/workflows/postgres-tarball.yml");
  expect(ci).toContain("name: label / paths");
  expect(ci).toContain("name: lint / pull request");
  expect(ci).not.toContain("tests/harness.test.ts");
  expect(ci).toMatch(/push:\n {4}branches:\n {6}- main\n/);
  expect(ci).toContain("pull_request:");
  expect(ci).toContain(
    "cancel-in-progress: ${{ github.event_name == 'pull_request' && github.event.action != 'labeled' && github.event.action != 'unlabeled' }}",
  );
  expect(ci).toContain(
    "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
  );
  expect(ci).toMatch(/name: gate \/ check[\s\S]*?if: always\(\)/);
  expect(ci).toContain("bun ./scripts/ci-tier.ts");
  expect(ci).toContain("bun ./scripts/ci-gate-mirror.ts");
  expect(ci).toMatch(/name: package \/ checks\n\s+needs: \[build, changes\]/);
  const floor = POSTGRES_VERSIONS[0];
  const newest = POSTGRES_VERSIONS[POSTGRES_VERSIONS.length - 1];
  if (floor === undefined || newest === undefined) throw new Error("no postgres versions");
  const pullRequest = readFileSync(join(root, ".github/workflows/postgres-pr.yml"), "utf8");
  expect(pullRequest).toContain("uses: ./.github/workflows/postgres-suite.yml");
  expect(pullRequest).toContain("uses: ./.github/workflows/postgres-tarball.yml");
  expect(pullRequest).toContain("actions: read");
  expect(pullRequest).toContain("needs: postgres");
  expect(pullRequest).toContain("labeled");
  expect(pullRequest).not.toContain("synchronize");
  expect(pullRequest).toContain("types: [labeled, unlabeled]");
  const prMeta = readFileSync(join(root, ".github/workflows/pr-meta.yml"), "utf8");
  expect(prMeta).not.toContain("synchronize");
  expect(prMeta).not.toContain("opened");
  expect(jsonVersionLists(pullRequest, "versions")).toEqual([[floor, newest], [newest]]);
  const gateNeeds = ci.slice(
    ci.indexOf("name: gate / check"),
    ci.indexOf("name: attest / measure"),
  );
  for (const slice of [
    "changes",
    "lint",
    "types",
    "types-full",
    "test",
    "test-dist",
    "runtimes",
    "temporal",
    "size",
    "package",
    "attest",
    "windows",
    "suite",
    "tarball",
    "drivers-conformance",
  ]) {
    expect(gateNeeds).toContain(slice);
  }
  expect(ci).toContain("bun ./scripts/ci-gate.ts");
  expect(suite).toContain("fail-fast: false");
  expect(suite).toContain("bun ./scripts/postgres-suite.ts --shard");
  expect(suite).toContain("bun ./scripts/pooler-proof.ts");
  expect(suite).toContain("docker pull");
  const setupBun = readFileSync(join(root, ".github/actions/setup-bun/action.yml"), "utf8");
  expect(setupBun).toContain("actions/cache@caa296126883cff596d87d8935842f9db880ef25");
  expect(unpinnedActions(setupBun)).toEqual([]);
  for (const shard of ["isolation", "selection", "consistency", "tx"]) {
    expect(suite).toContain(`- ${shard}\n`);
  }
  expect(ci).toContain("name: test / ${{ matrix.group }}");
  expect(ci).toContain("bun ./scripts/ci-test-groups.ts --matrix");
  expect(ci).toContain("fromJSON(needs.changes.outputs.source || '[]')");
  expect(ci).toContain("fromJSON(needs.changes.outputs.built || '[]')");
  expect(ci).toContain("name: lint / static");
  expect(ci).toContain("name: types / compiler");
  expect(ci).toContain("name: runtimes / portable");
  expect(ci).toContain("name: temporal / node ${{ matrix.node }}");
  expect(ci).toContain("name: package / checks");
  expect(ci).toContain("name: gate / check");
  expect(ci).toContain("name: attest / measure");
  const checkScript = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: { check: string };
  };
  for (const part of checkScript.scripts.check.split(" && ")) {
    expect(ci, part).toContain(part);
  }
  const weekly = readFileSync(join(root, ".github/workflows/weekly.yml"), "utf8");
  expect(weekly).toContain('cron: "0 6 * * 1"');
  expect(weekly).toContain("uses: ./.github/workflows/postgres-suite.yml");
  expect(weekly).toContain("uses: ./.github/workflows/postgres-tarball.yml");
  expect(weekly).toContain("actions: read");
  expect(jsonVersionLists(weekly, "versions")).toEqual([
    [...POSTGRES_VERSIONS],
    [...POSTGRES_VERSIONS],
  ]);
});

/**
 * The first argument of every `npm publish <target>` in a workflow that is not a flag.
 *
 * npm reads a target such as `packed/okmodel.tgz` as the git shorthand `user/repo` and tries
 * to clone `github.com/packed/okmodel.tgz`. Only a target that starts with `./` or `/` is a file.
 *
 * @param yaml - Workflow text
 * @returns Targets that are neither an explicit relative path nor an absolute path
 */
function bareNpmPublishTargets(yaml: string): readonly string[] {
  const bare: string[] = [];
  for (const line of yaml.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    for (const match of line.matchAll(/\bnpm(?:[ \t]+stage)?[ \t]+publish[ \t]+([^\s]+)/g)) {
      const target = match[1] ?? "";
      if (target.startsWith("-") || target.startsWith("./") || target.startsWith("/")) continue;
      bare.push(target);
    }
  }
  return bare;
}

test("npm publish is given the tarball by explicit path, never a bare name", () => {
  for (const name of readdirSync(join(root, ".github/workflows")).filter((file) =>
    file.endsWith(".yml"),
  )) {
    const yaml = readFileSync(join(root, ".github/workflows", name), "utf8");
    expect(bareNpmPublishTargets(yaml), name).toEqual([]);
  }
  // The guard itself: the form that failed release run 37264007346 is caught.
  expect(bareNpmPublishTargets("run: npm publish packed/okmodel.tgz --access public")).toEqual([
    "packed/okmodel.tgz",
  ]);
  expect(bareNpmPublishTargets("run: npm publish ./packed/okmodel.tgz --access public")).toEqual(
    [],
  );
  expect(bareNpmPublishTargets("run: npm publish /tmp/okmodel.tgz")).toEqual([]);
  expect(bareNpmPublishTargets("run: npm publish --access public")).toEqual([]);
  expect(bareNpmPublishTargets("run: npm stage publish packed/okmodel.tgz")).toEqual([
    "packed/okmodel.tgz",
  ]);
  expect(bareNpmPublishTargets("run: npm stage publish ./packed/okmodel.tgz --provenance")).toEqual(
    [],
  );
});

test("every job that runs bun run check sets up Node the way ci.yml does", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  expect(checkSetupProblems(ci, ci)).toEqual([]);
  expect(checkSetupProblems(release, ci)).toEqual([]);
  expect(checkJobs(release)).toEqual([]);
});

test("the setup guard names a check job without Node, or with Node after Check", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const noNode = ["jobs:", "  publish:", "    steps:", "      - run: bun run check"].join("\n");
  expect(checkSetupProblems(noNode, ci)).toEqual([
    "publish: runs bun run check without setup-node 22 before it, as ci.yml has",
  ]);
  const late = [
    "jobs:",
    "  publish:",
    "    steps:",
    "      - run: bun run check",
    "      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0",
    "        with:",
    "          node-version: 22",
  ].join("\n");
  expect(checkSetupProblems(late, ci)).toEqual([
    "publish: runs bun run check without setup-node 22 before it, as ci.yml has",
  ]);
});

test("verify runs one version unless --all", () => {
  expect(verifyVersions([], {})).toEqual(["17"]);
  expect(verifyVersions([], { POSTGRES_VERSION: "16" })).toEqual(["16"]);
  expect(verifyVersions(["--all"], { POSTGRES_VERSION: "16" })).toEqual([...POSTGRES_VERSIONS]);
  expect(verifyVersions(["--", "--all"], {})).toEqual([...POSTGRES_VERSIONS]);
  expect(() => verifyVersions(["--nope"], {})).toThrow(/Usage/);
  expect(() => verifyVersions([], { POSTGRES_VERSION: "14" })).toThrow(/outside 15/);
});

/**
 * An attestations document whose SLSA statement records `commits`.
 *
 * @param commits - `gitCommit` digests to put in the statement
 * @param withPublish - Also include the npm publish attestation, which has no git commit
 * @returns The document `provenanceCommitProblem` reads
 */
function provenanceDocument(commits: readonly string[], withPublish = false): unknown {
  const statement = {
    predicate: {
      buildDefinition: {
        resolvedDependencies: commits.map((gitCommit) => ({ digest: { gitCommit } })),
      },
    },
  };
  const payload = Buffer.from(JSON.stringify(statement), "utf8").toString("base64");
  const attestations: unknown[] = [];
  if (withPublish) {
    attestations.push({
      predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    });
  }
  attestations.push({
    predicateType: "https://slsa.dev/provenance/v1",
    bundle: { dsseEnvelope: { payload } },
  });
  return { attestations };
}

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

function jsonVersionLists(yaml: string, key: string): readonly (readonly string[])[] {
  const found: string[][] = [];
  for (const match of yaml.matchAll(new RegExp(`${key}:\\s*'(\\[[^']*\\])'`, "g"))) {
    const body = match[1];
    if (body === undefined) continue;
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`${key} is not a string list`);
    }
    found.push(parsed);
  }
  if (found.length === 0) throw new Error(`missing ${key}`);
  return found;
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

interface WorkflowStep {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}

/** The `[job name, steps]` pairs of a workflow file that run `bun run check`. */
function checkJobs(yaml: string): readonly (readonly [string, readonly WorkflowStep[]])[] {
  const parsed: unknown = Bun.YAML.parse(yaml);
  const jobs = isRecord(parsed) && isRecord(parsed.jobs) ? parsed.jobs : {};
  const found: [string, readonly WorkflowStep[]][] = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    const steps = job.steps.filter(isRecord) as WorkflowStep[];
    if (steps.some((step) => step.run?.trim() === "bun run check")) found.push([name, steps]);
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Step positions of `bun run check` and the steps before it. */
function stepsBeforeCheck(steps: readonly WorkflowStep[]): readonly WorkflowStep[] {
  return steps.slice(
    0,
    steps.findIndex((step) => step.run?.trim() === "bun run check"),
  );
}

/**
 * The `node-version` of the job that runs `bun run test:runtimes`.
 *
 * @param reference - Workflow text, `ci.yml` in the guard
 * @returns That job's last setup-node version, when the job exists
 */
function runtimesNodeVersion(reference: string): string | undefined {
  const parsed: unknown = Bun.YAML.parse(reference);
  const jobs = isRecord(parsed) && isRecord(parsed.jobs) ? parsed.jobs : {};
  for (const job of Object.values(jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    const steps = job.steps.filter(isRecord) as WorkflowStep[];
    if (steps.some((step) => step.run?.includes("bun run test:runtimes"))) {
      return nodeVersion(steps);
    }
  }
  return undefined;
}

/** The `node-version` of the last setup-node step in a job. */
function nodeVersion(steps: readonly WorkflowStep[]): string | undefined {
  const setups = steps.filter((step) => step.uses?.includes("actions/setup-node@"));
  const version = setups[setups.length - 1]?.with?.["node-version"];
  return typeof version === "string" || typeof version === "number" ? String(version) : undefined;
}

/** The `node-version` of the last setup-node step before `bun run check`. */
function nodeBeforeCheck(steps: readonly WorkflowStep[]): string | undefined {
  const setups = stepsBeforeCheck(steps).filter((step) =>
    step.uses?.includes("actions/setup-node@"),
  );
  const version = setups[setups.length - 1]?.with?.["node-version"];
  return typeof version === "string" || typeof version === "number" ? String(version) : undefined;
}

/**
 * Problems for jobs in `workflow` that run `bun run check` without the Node
 * version that `reference` (ci.yml) uses on the runtimes job.
 */
function checkSetupProblems(workflow: string, reference: string): readonly string[] {
  const expectedNode = runtimesNodeVersion(reference);
  if (expectedNode === undefined) return ["ci.yml has no setup-node before Check"];
  const problems: string[] = [];
  for (const [name, steps] of checkJobs(workflow)) {
    if (nodeBeforeCheck(steps) !== expectedNode) {
      problems.push(
        `${name}: runs bun run check without setup-node ${expectedNode} before it, as ci.yml has`,
      );
    }
  }
  return problems;
}
