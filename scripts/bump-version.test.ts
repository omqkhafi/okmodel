/**
 * bump-version — pre-release planning and Unreleased promotion.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNotesSource,
  BUMP_OUTPUTS,
  planBump,
  promoteUnreleasedSection,
} from "./bump-version.js";
import { repoRoot } from "./root.js";

describe("planBump", () => {
  test("next turns 0.0.0 into 0.1.0-next.1 and does not promote the changelog", () => {
    expect(planBump("0.0.0", { kind: "next" })).toEqual({
      version: "0.1.0-next.1",
      promoteChangelog: false,
    });
  });

  test("next increments the pre-release counter", () => {
    expect(planBump("0.1.0-next.1", { kind: "next" })).toEqual({
      version: "0.1.0-next.2",
      promoteChangelog: false,
    });
  });

  test("next after a release starts the following minor", () => {
    expect(planBump("0.1.0", { kind: "next" })).toEqual({
      version: "0.2.0-next.1",
      promoteChangelog: false,
    });
  });

  test("release drops the suffix and promotes the changelog", () => {
    expect(planBump("0.1.0-next.3", { kind: "release" })).toEqual({
      version: "0.1.0",
      promoteChangelog: true,
    });
  });

  test("release from a bare version needs the next patch or minor named", () => {
    expect(() => planBump("0.10.3", { kind: "release" })).toThrow(
      /needs the version: release 0\.10\.4 or release 0\.11\.0/,
    );
  });

  test("release accepts the next patch or minor from a bare version", () => {
    expect(planBump("0.10.3", { kind: "release", release: "0.10.4" })).toEqual({
      version: "0.10.4",
      promoteChangelog: true,
    });
    expect(planBump("0.10.3", { kind: "release", release: "v0.11.0" })).toEqual({
      version: "0.11.0",
      promoteChangelog: true,
    });
  });

  test("release refuses any other explicit version", () => {
    for (const version of ["0.10.3", "0.10.5", "0.12.0", "1.0.0", "0.10.4-next.1"]) {
      expect(() => planBump("0.10.3", { kind: "release", release: version })).toThrow();
    }
    expect(() => planBump("0.11.0-next.2", { kind: "release", release: "0.11.1" })).toThrow(
      /accepts 0\.11\.0/,
    );
    expect(planBump("0.11.0-next.2", { kind: "release", release: "0.11.0" }).version).toBe(
      "0.11.0",
    );
  });

  test("patch, minor, major, and --set still promote", () => {
    expect(planBump("1.2.3", { kind: "patch" })).toEqual({
      version: "1.2.4",
      promoteChangelog: true,
    });
    expect(planBump("1.2.3", { kind: "minor" })).toEqual({
      version: "1.3.0",
      promoteChangelog: true,
    });
    expect(planBump("1.2.3", { kind: "major" })).toEqual({
      version: "2.0.0",
      promoteChangelog: true,
    });
    expect(planBump("1.2.3", { set: "v9.8.7" })).toEqual({
      version: "9.8.7",
      promoteChangelog: true,
    });
  });

  test("patch of a pre-release bumps the bare version and promotes", () => {
    expect(planBump("1.2.3-next.4", { kind: "patch" })).toEqual({
      version: "1.2.4",
      promoteChangelog: true,
    });
  });
});

test("a bump writes package.json and changelog.md and does not write docs/", () => {
  expect([...BUMP_OUTPUTS]).toEqual(["package.json", "changelog.md"]);
  for (const path of BUMP_OUTPUTS) expect(path.startsWith("docs")).toBe(false);
});

describe("promoteUnreleasedSection", () => {
  test("renames Unreleased into vX.Y.Z and leaves a fresh empty Unreleased", () => {
    const raw = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### ✨ Added",
      "",
      "- New thing.",
      "",
      "### 🐛 Fixed",
      "",
      "- A bug.",
      "",
      "## v0.1.0 — 2026-01-01",
      "",
      "### ✨ Added",
      "",
      "- Old thing.",
      "",
    ].join("\n");

    const out = promoteUnreleasedSection(raw, "0.2.0", "2026-09-30");

    expect(out).toContain("## Unreleased\n\n## v0.2.0 — 2026-09-30");
    expect(out).toContain("- New thing.");
    expect(out).toContain("- A bug.");
    expect(out).toContain("## v0.1.0 — 2026-01-01");
    expect(out.indexOf("## Unreleased")).toBeLessThan(out.indexOf("## v0.2.0"));
    expect(out.indexOf("- New thing.")).toBeGreaterThan(out.indexOf("## v0.2.0"));
  });

  test("release promotion uses the suffix-free version", () => {
    const raw = "# Changelog\n\n## Unreleased\n\n### ✨ Added\n\n- Ready.\n\n";
    const version = planBump("0.1.0-next.2", { kind: "release" }).version;
    const out = promoteUnreleasedSection(raw, version, "2026-09-30");
    expect(out).toContain("## v0.1.0 — 2026-09-30");
    expect(out).toContain("- Ready.");
  });

  test("fails when Unreleased is missing", () => {
    expect(() =>
      promoteUnreleasedSection(
        "## v0.1.0 — 2026-01-01\n\n### ✨ Added\n\n- x.\n",
        "0.1.1",
        "2026-01-02",
      ),
    ).toThrow(/no ## Unreleased/);
  });

  test("fails when Unreleased has no bullets", () => {
    expect(() =>
      promoteUnreleasedSection(
        "# Changelog\n\n## Unreleased\n\n## v0.1.0 — 2026-01-01\n\n### ✨ Added\n\n- x.\n",
        "0.1.1",
        "2026-01-02",
      ),
    ).toThrow(/no bullets/);
  });
});

describe("assertNotesSource", () => {
  const empty = "# Changelog\n\n## Unreleased\n\n## v0.1.0 — 2026-01-01\n\n- x.\n";
  const filled = "# Changelog\n\n## Unreleased\n\n- Ready.\n\n## v0.1.0 — 2026-01-01\n";

  function withRepo(tag: boolean, run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "okm-bump-"));
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "init");
      if (tag) git("tag", "v0.1.0");
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("an empty Unreleased with no vX.Y.Z tag says to fetch tags", () => {
    withRepo(false, (root) => {
      expect(() => assertNotesSource(root, empty)).toThrow(/git fetch --tags/);
    });
  });

  test("passes with a tag, or with hand-written bullets", () => {
    withRepo(true, (root) => expect(() => assertNotesSource(root, empty)).not.toThrow());
    withRepo(false, (root) => expect(() => assertNotesSource(root, filled)).not.toThrow());
  });
});

test("next without --publish refuses to run", async () => {
  const proc = Bun.spawn(["bun", "./scripts/bump-version.ts", "next", "--dry-run"], {
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(2);
  expect(stderr).toContain("Pass --publish");
});

test("next --publish dry-run prints the next version and does not write", async () => {
  const root = repoRoot();
  const packagePath = join(root, "package.json");
  const before = readFileSync(packagePath, "utf8");
  const current = (JSON.parse(before) as { version: string }).version;
  const expected = planBump(current, { kind: "next" }).version;
  const proc = Bun.spawn(["bun", "./scripts/bump-version.ts", "next", "--publish", "--dry-run"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(stderr).toContain(`${current} → ${expected}`);
  expect(stderr).not.toContain("changelog.md");
  expect(readFileSync(packagePath, "utf8")).toBe(before);
});
