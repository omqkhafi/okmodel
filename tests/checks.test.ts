import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  duplicatedModuleProblems,
  npmPackageProblems,
  scanHarnessBarrel,
} from "../scripts/bundle-purity.js";
import { checkCompilerApi } from "../scripts/compiler-api.js";
import { checkCorePurity } from "../scripts/core-purity.js";
import { checkDocs } from "../scripts/docs-check.js";
import { checkReadme } from "../scripts/readme-check.js";
import {
  DEPLOY_FETCH_BUDGET_MS,
  DEPLOY_FETCH_WAITS_MS,
  confirmDeployedVersion,
  declaredSiteOrigin,
  deployRefProblems,
  pageContainsVersion,
  prereleaseProblem,
  resolveDeployTag,
  tagCommitProblem,
} from "../scripts/deploy-ref.js";
import {
  mainAncestorStatus,
  releaseCommitProblem,
  releaseGuardProblems,
  releasePublishRequested,
  releaseRefProblem,
  releaseTagCommitProblem,
} from "../scripts/release-ref.js";
import { checkLayers } from "../scripts/layers-check.js";
import {
  checkReleaseDirs,
  checkReleaseSnapshots,
  releaseExemption,
} from "../scripts/release-check.js";
import { repoRoot } from "../scripts/root.js";
import {
  appBudgetProblems,
  checkDistSize,
  coldImportFinding,
  incrementalBudgetProblems,
  runtimeBudgetProblems,
} from "../scripts/size.js";

const root = repoRoot();
const fixtures = join(root, "tests", "fixtures");

test("layers-check fails when an import goes upward, including import type", () => {
  const problems = checkLayers(join(fixtures, "layers", "upward"));
  expect(problems.some((problem) => problem.includes("bad.ts"))).toBe(true);
  expect(problems.some((problem) => problem.includes("type-only.ts"))).toBe(true);
});

test("layers-check fails when an adapter imports a dialect", () => {
  const problems = checkLayers(join(fixtures, "layers", "adapter-dialect"));
  expect(problems.some((problem) => problem.includes("adapters/bad.ts"))).toBe(true);
});

test("layers-check allows a downward import", () => {
  expect(checkLayers(join(fixtures, "layers", "downward"))).toEqual([]);
});

test("layers-check accepts the repository source", () => {
  expect(checkLayers(join(root, "src"))).toEqual([]);
});

test("core-purity fails on a node import in the core", () => {
  const problems = checkCorePurity({
    root: join(fixtures, "core-purity", "node-import"),
  });
  expect(problems.some((problem) => problem.includes("node:fs"))).toBe(true);
});

test("core-purity fails on runtime dependencies", () => {
  const problems = checkCorePurity({
    root: join(fixtures, "core-purity", "dependencies"),
    packageJsonPath: join(fixtures, "core-purity", "dependencies", "package.json"),
  });
  expect(problems.some((problem) => problem.includes("left-pad"))).toBe(true);
});

test("core-purity allows node imports in tooling and an empty dependency list", () => {
  const problems = checkCorePurity({
    root: join(fixtures, "core-purity", "clean"),
    packageJsonPath: join(fixtures, "core-purity", "clean", "package.json"),
  });
  expect(problems).toEqual([]);
});

test("core-purity accepts the repository", () => {
  expect(
    checkCorePurity({
      root: join(root, "src"),
      packageJsonPath: join(root, "package.json"),
    }),
  ).toEqual([]);
});

test("docs:check accepts a directory whose links, sections, and decisions resolve", () => {
  expect(checkDocs(join(fixtures, "docs", "ok"))).toEqual([]);
});

test("docs:check fails on a broken relative link", () => {
  const problems = checkDocs(join(fixtures, "docs", "bad-link"));
  expect(problems.some((problem) => problem.includes("missing.md"))).toBe(true);
});

test("docs:check fails on an unknown section reference", () => {
  const problems = checkDocs(join(fixtures, "docs", "bad-section"));
  expect(problems.some((problem) => problem.includes("§9.9"))).toBe(true);
});

test("docs:check fails on an unknown decision", () => {
  const problems = checkDocs(join(fixtures, "docs", "bad-decision"));
  expect(problems.some((problem) => problem.includes("D404"))).toBe(true);
});

test("docs:check accepts the repository docs", () => {
  expect(checkDocs(join(root, "docs"))).toEqual([]);
});

test("compiler-api check fails on a typescript import", () => {
  const problems = checkCompilerApi([join(fixtures, "compiler-api")]);
  expect(problems.some((problem) => problem.includes("typescript"))).toBe(true);
});

test("compiler-api check accepts the repository", () => {
  expect(
    checkCompilerApi([
      join(root, "src"),
      join(root, "scripts"),
      join(root, "tests"),
      join(root, "packages", "harness"),
      join(root, "packages", "bench"),
      join(root, "packages", "spikes"),
    ]),
  ).toEqual([]);
});

test("size check fails above the ceiling and passes under it", () => {
  const dir = join(fixtures, "size");
  expect(checkDistSize(dir, 8).length).toBeGreaterThan(0);
  expect(checkDistSize(dir, 1000)).toEqual([]);
});

test("app bundle budget fails above the startup ceilings", () => {
  const over = appBudgetProblems({
    entry: "scripts/app-startup.ts",
    minBytes: 100_000,
    gzipBytes: 40_000,
    coldImportMs: 30,
  });
  expect(over.some((problem) => problem.includes("minified"))).toBe(true);
  expect(over.some((problem) => problem.includes("gzip"))).toBe(true);
  expect(over.some((problem) => problem.includes("cold import"))).toBe(false);
  expect(
    appBudgetProblems({
      entry: "scripts/app-startup.ts",
      minBytes: 38_000,
      gzipBytes: 12_000,
      coldImportMs: 20,
    }).some((problem) => problem.includes("cold import")),
  ).toBe(false);
  expect(
    appBudgetProblems({
      entry: "scripts/app-startup.ts",
      minBytes: 38_000,
      gzipBytes: 12_000,
      coldImportMs: 5,
    }),
  ).toEqual([]);
});

test("adapter incremental budget fails above its ceiling", () => {
  expect(
    incrementalBudgetProblems("src/adapters/pg/postgresjs.ts", 16_000, 15_093).length,
  ).toBeGreaterThan(0);
  expect(incrementalBudgetProblems("src/adapters/pg/postgresjs.ts", 12_000, 15_093)).toEqual([]);
});

test("runtime size budget fails above the ceilings", () => {
  const over = runtimeBudgetProblems(
    {
      entry: "src/contracts/index.ts",
      minBytes: 70_000,
      gzipBytes: 25_000,
      coldImportMs: 40,
    },
    { ci: true },
  );
  expect(over.some((problem) => problem.includes("minified"))).toBe(true);
  expect(over.some((problem) => problem.includes("gzip"))).toBe(true);
  expect(over.some((problem) => problem.includes("cold import"))).toBe(true);
  expect(
    runtimeBudgetProblems(
      {
        entry: "src/contracts/index.ts",
        minBytes: 70_000,
        gzipBytes: 25_000,
        coldImportMs: 40,
      },
      { ci: false },
    ).some((problem) => problem.includes("cold import")),
  ).toBe(false);
  expect(coldImportFinding(20)).toContain("15");
  expect(coldImportFinding(5)).toBeUndefined();
  expect(
    runtimeBudgetProblems({
      entry: "src/contracts/index.ts",
      minBytes: 1000,
      gzipBytes: 400,
      coldImportMs: 2,
    }),
  ).toEqual([]);
});

test("bundle purity rejects the harness barrel and an npm package in the metafile", () => {
  const barrel = scanHarnessBarrel(join(fixtures, "bundle-purity", "src"), fixtures);
  expect(barrel.some((problem) => problem.includes("harness barrel"))).toBe(true);
  expect(scanHarnessBarrel(join(root, "src"), root)).toEqual([]);
  const bundled = npmPackageProblems(
    { inputs: { "node_modules/postgres/src/index.js": { bytes: 1 } } },
    "router",
  );
  expect(bundled.some((problem) => problem.includes("postgres"))).toBe(true);
  expect(
    npmPackageProblems({ inputs: { "src/contracts/sha256.ts": { bytes: 1 } } }, "root"),
  ).toEqual([]);
  const duplicated = duplicatedModuleProblems({
    outputs: {
      "contracts/index.js": { inputs: { "src/contracts/sha256.ts": { bytes: 1 } } },
      "dialects/pg/index.js": { inputs: { "src/contracts/sha256.ts": { bytes: 1 } } },
    },
  });
  expect(duplicated.some((problem) => problem.includes("sha256.ts"))).toBe(true);
  expect(
    duplicatedModuleProblems({
      outputs: {
        "contracts/index.js": { inputs: { "src/contracts/index.ts": { bytes: 1 } } },
        "shared/chunk.js": { inputs: { "src/contracts/sha256.ts": { bytes: 1 } } },
      },
    }),
  ).toEqual([]);
});

const releaseFixtures = join(fixtures, "release-check");

test("release check fails when the version and Unreleased notes are unchanged", () => {
  const problems = checkReleaseDirs(
    join(releaseFixtures, "unchanged", "base"),
    join(releaseFixtures, "unchanged", "head"),
  );
  expect(problems.some((problem) => problem.includes("equals the base branch"))).toBe(true);
  expect(problems.some((problem) => problem.includes("no new lines"))).toBe(true);
});

test("release check fails when the version matches even if Unreleased gained a line", () => {
  const problems = checkReleaseDirs(
    join(releaseFixtures, "same-version", "base"),
    join(releaseFixtures, "same-version", "head"),
  );
  expect(problems.some((problem) => problem.includes("equals the base branch"))).toBe(true);
  expect(problems.some((problem) => problem.includes("no new lines"))).toBe(false);
});

test("release check fails when the version moved but Unreleased did not", () => {
  const problems = checkReleaseDirs(
    join(releaseFixtures, "version-only", "base"),
    join(releaseFixtures, "version-only", "head"),
  );
  expect(problems).toEqual(["changelog.md has no new lines under ## Unreleased"]);
});

test("release check accepts a new Unreleased line and a new version", () => {
  expect(
    checkReleaseDirs(
      join(releaseFixtures, "notes", "base"),
      join(releaseFixtures, "notes", "head"),
    ),
  ).toEqual([]);
});

test("release check accepts a release that promotes Unreleased", () => {
  expect(
    checkReleaseDirs(
      join(releaseFixtures, "release", "base"),
      join(releaseFixtures, "release", "head"),
    ),
  ).toEqual([]);
});

test("release check accepts notes under an untagged release heading", () => {
  const base = {
    version: "0.1.0",
    changelog: "# Changelog\n\n## Unreleased\n\n## v0.1.0 — 2026-10-03\n\n- First.\n",
  };
  const head = {
    version: "0.1.0",
    changelog:
      "# Changelog\n\n## Unreleased\n\n## v0.1.0 — 2026-10-03\n\n- First.\n- Public subpaths keep public names.\n",
  };
  expect(checkReleaseSnapshots(base, head).length).toBeGreaterThan(0);
  expect(checkReleaseSnapshots(base, head, { untaggedRelease: true })).toEqual([]);
});

test("release check rejects an emptied Unreleased that is not the suffix drop", () => {
  const problems = checkReleaseDirs(
    join(releaseFixtures, "not-release", "base"),
    join(releaseFixtures, "not-release", "head"),
  );
  expect(problems).toEqual(["changelog.md has no new lines under ## Unreleased"]);
});

test("release check accepts notes folded into an untagged release heading", () => {
  const base = {
    version: "0.7.0-next.4",
    changelog: "# Changelog\n\n## Unreleased\n\n- QA.\n\n## v0.6.0 — 2026-10-11\n\n- First.\n",
  };
  const head = {
    version: "0.6.0",
    changelog: "# Changelog\n\n## Unreleased\n\n## v0.6.0 — 2026-10-11\n\n- QA.\n- First.\n",
  };
  expect(checkReleaseSnapshots(base, head)).toEqual([
    "changelog.md has no new lines under ## Unreleased",
  ]);
  expect(checkReleaseSnapshots(base, head, { untaggedRelease: true })).toEqual([]);
});

test("release check accepts a bare version cut with notes under the new heading", () => {
  const base = {
    version: "0.1.0",
    changelog: "# Changelog\n\n## Unreleased\n\n- Note.\n\n## v0.1.0 — 2026-10-03\n\n- First.\n",
  };
  const head = {
    version: "0.1.1",
    changelog:
      "# Changelog\n\n## Unreleased\n\n## v0.1.1 — 2026-10-03\n\n- Note.\n\n## v0.1.0 — 2026-10-03\n\n- First.\n",
  };
  expect(checkReleaseSnapshots(base, head)).toEqual([]);
});

test("release exemption covers a change that is only under .github/", () => {
  expect(releaseExemption([".github/workflows/ci.yml"])).toBe(
    "only .github/ changed: no version bump or changelog needed",
  );
  expect(releaseExemption([".github/workflows/ci.yml", ".github/pull_request_template.md"])).toBe(
    "only .github/ changed: no version bump or changelog needed",
  );
});

test("release exemption never covers an empty change or a file outside .github/", () => {
  expect(releaseExemption([])).toBeUndefined();
  expect(releaseExemption([".github/workflows/ci.yml", "src/contracts/index.ts"])).toBeUndefined();
  expect(releaseExemption([".githubx/ci.yml"])).toBeUndefined();
  expect(releaseExemption(["docs/.github/ci.yml"])).toBeUndefined();
});

/** A throwaway git repository that holds the release-check script and a base commit. */
function releaseRepo(): { readonly dir: string; readonly base: string } {
  const dir = mkdtempSync(join(tmpdir(), "okm-release-check-"));
  for (const file of ["release-check.ts", "report.ts", "root.ts"]) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(join(root, "scripts", file), join(dir, "scripts", file));
  }
  git(dir, "init", "-q", "-b", "main");
  writeRepoFile(dir, "package.json", `${JSON.stringify({ name: "x", version: "0.2.0" })}\n`);
  writeRepoFile(
    dir,
    "changelog.md",
    "# Changelog\n\n## Unreleased\n\n## v0.2.0 — 2026-10-05\n\n- First.\n",
  );
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD").trim() };
}

function git(dir: string, ...args: readonly string[]): string {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir },
  );
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

function writeRepoFile(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function runReleaseCheck(dir: string, base: string) {
  const proc = Bun.spawnSync(["bun", "scripts/release-check.ts", "--base", base], { cwd: dir });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function withReleaseRepo(run: (dir: string, base: string) => void): void {
  const { dir, base } = releaseRepo();
  try {
    run(dir, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("release-check passes a pull request that changes only .github/", () => {
  withReleaseRepo((dir, base) => {
    writeRepoFile(dir, ".github/workflows/ci.yml", "name: CI\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "workflow");
    const result = runReleaseCheck(dir, base);
    expect(result.code).toBe(0);
    expect(result.out).toContain("only .github/ changed: no version bump or changelog needed");
  });
});

test("release-check still wants the bump and the changelog line when src/ changes too", () => {
  withReleaseRepo((dir, base) => {
    writeRepoFile(dir, ".github/workflows/ci.yml", "name: CI\n");
    writeRepoFile(dir, "src/index.ts", "export {};\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "workflow and source");
    const result = runReleaseCheck(dir, base);
    expect(result.code).toBe(1);
    expect(result.err).toContain("package.json version 0.2.0 equals the base branch");
    expect(result.err).toContain("changelog.md has no new lines under ## Unreleased");
    expect(result.out).not.toContain("only .github/ changed");
  });
});

test("release-check passes a mixed pull request that has the bump and the changelog line", () => {
  withReleaseRepo((dir, base) => {
    writeRepoFile(dir, ".github/workflows/ci.yml", "name: CI\n");
    writeRepoFile(dir, "src/index.ts", "export {};\n");
    writeRepoFile(dir, "package.json", `${JSON.stringify({ name: "x", version: "0.2.1" })}\n`);
    writeRepoFile(
      dir,
      "changelog.md",
      "# Changelog\n\n## Unreleased\n\n- A note.\n\n## v0.2.0 — 2026-10-05\n\n- First.\n",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "mixed");
    expect(runReleaseCheck(dir, base).code).toBe(0);
  });
});

test("release-check treats an empty diff as it always did", () => {
  withReleaseRepo((dir, base) => {
    const result = runReleaseCheck(dir, base);
    expect(result.code).toBe(1);
    expect(result.err).toContain("package.json version 0.2.0 equals the base branch");
    expect(result.err).toContain("changelog.md has no new lines under ## Unreleased");
    expect(result.out).not.toContain("only .github/ changed");
  });
});

test("readme check fails on a relative link and on a relative image", () => {
  expect(checkReadme("[quickstart](docs/quickstart.md)")).toEqual([
    "README.md contains a relative link: docs/quickstart.md",
  ]);
  expect(checkReadme("![logo](./logo.png)")).toEqual(["README.md contains an image: ./logo.png"]);
  expect(checkReadme("![logo][logo]\n\n[logo]: ./logo.png")).toEqual([
    "README.md contains an image: logo",
    "README.md contains an image: ./logo.png",
  ]);
  expect(checkReadme('<img src="logo.png">')).toEqual(["README.md contains an image: <img"]);
  expect(checkReadme('<source srcset="logo.png">')).toEqual([
    "README.md contains an image: <source",
  ]);
});

test("readme check accepts an absolute https image", () => {
  expect(checkReadme("![logo](https://img.shields.io/npm/v/okmodel)")).toEqual([]);
  expect(checkReadme('<img alt="logo" src="https://example.com/logo.svg" width="750">')).toEqual(
    [],
  );
  expect(
    checkReadme('<source media="(prefers-color-scheme: dark)" srcset="https://a.b/c.svg">'),
  ).toEqual([]);
  expect(checkReadme("![logo](http://example.com/logo.png)")).toEqual([
    "README.md contains an image: http://example.com/logo.png",
  ]);
});

test("readme check ignores fences and accepts absolute links", () => {
  const fenced = ["```md", "[quickstart](docs/quickstart.md)", "```", ""].join("\n");
  expect(checkReadme(fenced)).toEqual([]);
  expect(
    checkReadme("[quickstart](https://github.com/omqkhafi/okmodel/blob/main/docs/quickstart.md)"),
  ).toEqual([]);
  expect(checkReadme("[commands](#commands)")).toEqual([]);
});

test("readme check accepts the repository readme", () => {
  expect(checkReadme(readFileSync(join(root, "README.md"), "utf8"))).toEqual([]);
});

test("a dry run accepts main and refuses a branch tag", () => {
  expect(releasePublishRequested(undefined)).toBe(false);
  expect(releasePublishRequested("false")).toBe(false);
  expect(releasePublishRequested("true")).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), "okm-release-"));
  const git = (args: readonly string[]): void => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(proc.stderr.toString());
    }
  };
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "release@example.com"]);
    git(["config", "user.name", "Release test"]);
    const version = "0.10.0-next.1";
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ version })}\n`);
    const changelog = `## Unreleased\n\n## v${version} — 2026-10-19\n\n- Staged.\n`;
    writeFileSync(join(dir, "changelog.md"), changelog);
    git(["add", "package.json", "changelog.md"]);
    git(["commit", "-m", "main"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(mainAncestorStatus(dir)).toBe(0);
    expect(
      releaseGuardProblems({
        ref: "refs/heads/main",
        version,
        changelog,
        onMain: mainAncestorStatus(dir) === 0,
        publish: false,
      }),
    ).toEqual([]);
    git(["tag", `v${version}`]);
    expect(
      releaseGuardProblems({
        ref: `refs/tags/v${version}`,
        version,
        changelog,
        onMain: true,
        publish: true,
      }),
    ).toEqual([]);
    expect(
      releaseGuardProblems({
        ref: `refs/tags/v${version}`,
        version,
        changelog: "## Unreleased\n",
        onMain: true,
        publish: true,
      }).join("\n"),
    ).toContain(`## v${version}`);
    expect(
      releaseGuardProblems({
        ref: "refs/heads/main",
        version,
        changelog,
        onMain: true,
        publish: true,
      }).join("\n"),
    ).toContain(`v${version}`);

    git(["checkout", "-b", "side"]);
    const side = "0.10.0-next.2";
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ version: side })}\n`);
    const sideLog = `## Unreleased\n\n## v${side} — 2026-10-19\n\n- Branch.\n`;
    writeFileSync(join(dir, "changelog.md"), sideLog);
    git(["add", "package.json", "changelog.md"]);
    git(["commit", "-m", "side"]);
    git(["tag", `v${side}`]);
    expect(mainAncestorStatus(dir)).not.toBe(0);
    const refused = releaseGuardProblems({
      ref: `refs/tags/v${side}`,
      version: side,
      changelog: sideLog,
      onMain: mainAncestorStatus(dir) === 0,
      publish: false,
    });
    expect(refused.join("\n")).toContain("git merge-base --is-ancestor");
    expect(refused.join("\n")).toContain("not on main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release ref accepts v plus the package version and refuses anything else", () => {
  expect(releaseRefProblem("refs/tags/v0.1.1", "0.1.1")).toBeUndefined();
  expect(releaseRefProblem("refs/tags/v0.1.0", "0.1.1")).toBe(
    'Refusing to publish from refs/tags/v0.1.0. package.json is 0.1.1, so the tag must be v0.1.1. Run: git push origin "v0.1.1"',
  );
  expect(releaseRefProblem(undefined, "0.1.1")).toContain("Refusing to publish from (unset)");
});

test("a release commit must be the full SHA the tag peels to", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  expect(releaseCommitProblem(sha)).toBeUndefined();
  expect(releaseCommitProblem(`  ${sha.toUpperCase()}  `)).toBeUndefined();
  expect(releaseCommitProblem(undefined)).toContain("(unset)");
  expect(releaseCommitProblem("")).toContain("(unset)");
  expect(releaseCommitProblem(sha.slice(0, 7))).toContain("40-hex");
  expect(releaseCommitProblem(`${sha}0`)).toContain("40-hex");
  expect(releaseTagCommitProblem("v0.7.0", sha, sha)).toBeUndefined();
  expect(releaseTagCommitProblem("v0.7.0", sha.toUpperCase(), sha)).toBeUndefined();
  expect(releaseTagCommitProblem("v0.7.0", other, sha)).toBe(
    `Refusing to publish. Tag v0.7.0 points at ${other}, not the QA'd commit ${sha}.`,
  );
  expect(releaseTagCommitProblem("v0.7.0", sha, "abc")).toContain("not the QA'd commit abc");
});

test("a site deploy accepts a release tag and refuses a prerelease", () => {
  expect(
    resolveDeployTag({ eventName: "workflow_dispatch", inputTag: "v0.7.0", headBranch: "" }),
  ).toEqual({
    ok: true,
    value: "v0.7.0",
  });
  expect(
    resolveDeployTag({
      eventName: "workflow_dispatch",
      inputTag: "refs/tags/v0.7.0",
      headBranch: "",
    }),
  ).toEqual({ ok: true, value: "v0.7.0" });
  expect(
    resolveDeployTag({ eventName: "workflow_dispatch", inputTag: "main", headBranch: "" }).ok,
  ).toBe(false);
  expect(
    resolveDeployTag({ eventName: "workflow_dispatch", inputTag: "", headBranch: "" }),
  ).toEqual({
    ok: false,
    problem: "A tag is required. Pass a v* tag, for example v0.7.0.",
  });
  expect(
    resolveDeployTag({ eventName: "workflow_run", inputTag: "", headBranch: "v0.6.0" }),
  ).toEqual({
    ok: true,
    value: "v0.6.0",
  });
  expect(resolveDeployTag({ eventName: "workflow_run", inputTag: "", headBranch: "main" }).ok).toBe(
    false,
  );
  const unset = resolveDeployTag({ eventName: "workflow_run", inputTag: "", headBranch: "" });
  expect(unset.ok).toBe(false);
  if (!unset.ok) expect(unset.problem).toContain("(unset)");
  expect(prereleaseProblem("0.7.0")).toBeUndefined();
  expect(prereleaseProblem("0.7.0+build")).toBeUndefined();
  expect(prereleaseProblem("0.7.0-next.106")).toContain("not a prerelease");
  expect(releaseRefProblem("refs/tags/v0.7.0-next.106", "0.7.0-next.106")).toBeUndefined();
  expect(deployRefProblems("v0.7.0-next.106", "0.7.0-next.106")).toEqual([
    "Refusing to deploy 0.7.0-next.106. The production site deploys only a release version (X.Y.Z), not a prerelease.",
  ]);
  expect(deployRefProblems("v0.7.0", "0.7.0")).toEqual([]);
  expect(deployRefProblems("v0.6.0", "0.7.0")[0]).toContain("the tag must be v0.7.0");
  expect(tagCommitProblem("v0.7.0", "a".repeat(40), "a".repeat(40))).toBeUndefined();
  expect(tagCommitProblem("v0.7.0", "a".repeat(40), "b".repeat(40))).toContain("Release run was");
  expect(tagCommitProblem("v0.7.0", "a".repeat(40), undefined)).toBeUndefined();
});

test("the confirm step reads the origin site-identity declares", () => {
  const identity = readFileSync(join(root, "site/lib/site-identity.ts"), "utf8");
  expect(declaredSiteOrigin(identity)).toBe("https://okm.omqkhafi.dev");
  expect(() => declaredSiteOrigin('export const SITE_NAME = "OKModel";')).toThrow(
    /does not declare a default https origin/,
  );
});

test("the deployed page must contain the release version, not a prerelease that starts with it", () => {
  expect(pageContainsVersion("<span>v0.7.0</span>", "0.7.0")).toBe(true);
  expect(pageContainsVersion("v0.7.0-next.106", "0.7.0")).toBe(false);
  expect(pageContainsVersion("0.6.0", "0.7.0")).toBe(false);
  expect(pageContainsVersion("v0.7.0", "")).toBe(false);
  const waits = DEPLOY_FETCH_WAITS_MS.reduce<number>((sum, wait) => sum + wait, 0);
  expect(DEPLOY_FETCH_WAITS_MS[0]).toBe(0);
  expect(DEPLOY_FETCH_WAITS_MS[1]).toBe(10_000);
  expect(DEPLOY_FETCH_WAITS_MS.at(-1)).toBe(60_000);
  expect(DEPLOY_FETCH_BUDGET_MS).toBe(12 * 60 * 1000);
  expect(waits).toBeLessThanOrEqual(DEPLOY_FETCH_BUDGET_MS);
  expect(waits).toBe(690_000);
});

test("deploy confirm retries until the page shows the release version and stays inside the budget", async () => {
  const seen: string[] = [];
  let slept = 0;
  const bodies = ["v0.7.0-next.106", "v0.7.0"];
  await confirmDeployedVersion("https://okm.example", "0.7.0", {
    fetchPage: async (url) => {
      seen.push(url);
      return bodies.shift() ?? "";
    },
    sleep: async (ms) => {
      slept += ms;
    },
  });
  expect(seen).toEqual(["https://okm.example", "https://okm.example"]);
  expect(slept).toBe(10_000);

  slept = 0;
  let refused = false;
  try {
    await confirmDeployedVersion("https://okm.example", "0.7.0", {
      fetchPage: async () => "v0.7.0-next.106",
      sleep: async (ms) => {
        slept += ms;
      },
    });
  } catch (error) {
    refused = true;
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toMatch(/does not contain 0\.7\.0/);
      expect(error.message).toMatch(/did not show 0\.7\.0/);
    }
  }
  expect(refused).toBe(true);
  expect(slept).toBe(690_000);
  expect(slept).toBeLessThanOrEqual(DEPLOY_FETCH_BUDGET_MS);

  let blocked = false;
  try {
    await confirmDeployedVersion("http://okm.example", "0.7.0", {
      fetchPage: async () => "v0.7.0",
      sleep: async () => undefined,
    });
  } catch (error) {
    blocked = true;
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).toMatch(/must be https/);
  }
  expect(blocked).toBe(true);
});
