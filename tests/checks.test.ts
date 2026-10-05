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
import { releaseRefProblem } from "../scripts/release-ref.js";
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

test("readme check fails on a relative link and on an image", () => {
  expect(checkReadme("[quickstart](docs/quickstart.md)")).toEqual([
    "README.md contains a relative link: docs/quickstart.md",
  ]);
  expect(checkReadme("![logo](./logo.png)")).toEqual(["README.md contains an image: ./logo.png"]);
  expect(checkReadme("![logo][logo]\n\n[logo]: ./logo.png")).toEqual([
    "README.md contains an image: logo",
    "README.md contains an image: ./logo.png",
  ]);
  expect(checkReadme('<img src="logo.png">')).toEqual(["README.md contains an image: <img"]);
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

test("release ref accepts v plus the package version and refuses anything else", () => {
  expect(releaseRefProblem("refs/tags/v0.1.1", "0.1.1")).toBeUndefined();
  expect(releaseRefProblem("refs/tags/v0.1.0", "0.1.1")).toBe(
    "Refusing to publish from refs/tags/v0.1.0. package.json is 0.1.1, so the tag must be v0.1.1. Run: gh workflow run release.yml --ref v0.1.1",
  );
  expect(releaseRefProblem(undefined, "0.1.1")).toContain("Refusing to publish from (unset)");
});
