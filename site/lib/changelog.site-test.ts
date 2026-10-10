/**
 * The changelog page is a projection of the root changelog, not a second copy.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadChangelog,
  loadChangelogSeries,
  parseChangelog,
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
