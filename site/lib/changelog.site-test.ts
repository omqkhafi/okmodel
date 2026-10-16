/**
 * The changelog page is a projection of the root changelog, not a second copy.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadChangelog,
  loadChangelogSeries,
  loadUnreleased,
  parseChangelog,
  parseUnreleased,
  renderChangelogIndexMarkdown,
  renderChangelogSeriesMarkdown,
} from "./changelog";
import { repoRoot } from "./repo";

test("published releases are kept and Unreleased is not a release", () => {
  const raw = readFileSync(join(repoRoot(), "changelog.md"), "utf8");
  const releases = parseChangelog(raw);
  expect(releases.length).toBeGreaterThan(0);
  expect(releases.some((release) => release.version.toLowerCase().includes("unreleased"))).toBe(false);
  const first = releases[0];
  expect(first).toBeDefined();
  if (first === undefined) return;
  expect(first.tag.startsWith("v")).toBe(true);
  expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(first.groups.length).toBeGreaterThan(0);
});

test("unreleased notes stay off the release list and show as next", () => {
  const raw = readFileSync(join(repoRoot(), "changelog.md"), "utf8");
  const notes = parseUnreleased(raw);
  expect(loadUnreleased()).toEqual(notes);
  const releases = parseChangelog(raw);
  expect(releases.some((release) => release.tag === "vUnreleased")).toBe(false);
  const first = releases[0];
  expect(first?.version).toBe("0.9.0");
  expect(first?.tag).toBe("v0.9.0");
  expect(first?.date).toBe("2026-10-16");
  const index = renderChangelogIndexMarkdown(loadChangelogSeries(), notes);
  if (notes.length === 0) {
    expect(raw).toContain("## Unreleased");
    expect(index).not.toContain("## Next");
    return;
  }
  expect(notes.some((group) => group.items.length + group.subgroups.length > 0)).toBe(true);
  expect(index).toContain("## Next");
});

test("series pages cover every published release", () => {
  const releases = loadChangelog();
  const series = loadChangelogSeries();
  const flat = series.flatMap((entry) => entry.releases);
  expect(flat.map((release) => release.tag)).toEqual(releases.map((release) => release.tag));
  const newest = series[0];
  expect(newest).toBeDefined();
  if (newest === undefined) return;
  expect(renderChangelogSeriesMarkdown(newest)).toContain(newest.releases[0]?.tag ?? "");
});
