/**
 * bump-version — pre-release planning and Unreleased promotion.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { planBump, promoteUnreleasedSection } from "./bump-version.js";
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

  test("release rejects a version that has no suffix", () => {
    expect(() => planBump("0.1.0", { kind: "release" })).toThrow(/X\.Y\.Z-next\.N/);
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

test("next dry-run prints the next version and does not write", async () => {
  const root = repoRoot();
  const packagePath = join(root, "package.json");
  const before = readFileSync(packagePath, "utf8");
  const current = (JSON.parse(before) as { version: string }).version;
  const expected = planBump(current, { kind: "next" }).version;
  const proc = Bun.spawn(["bun", "./scripts/bump-version.ts", "next", "--dry-run"], {
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
