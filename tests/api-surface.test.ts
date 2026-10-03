/**
 * The public export list matches the snapshot.
 *
 * A name that appears in an entry and not in the snapshot fails. So does a
 * name the snapshot still lists after it was removed.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { API_ENTRIES, classifyEntry, readEntry, type ApiExport } from "../scripts/api-surface.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("each public subpath matches the API snapshot", () => {
  const snapshot = readSnapshot(join(root, "tests/fixtures/api-surface.json"));
  expect(Object.keys(snapshot).sort()).toEqual(API_ENTRIES.map((entry) => entry.subpath).sort());
  for (const entry of API_ENTRIES) {
    const actual = classifyEntry(readEntry(join(root, entry.file)), entry.subpath);
    const recorded = snapshot[entry.subpath];
    if (recorded === undefined) throw new Error(`${entry.subpath} is missing from the snapshot`);
    expect(actual, entry.subpath).toEqual(recorded);
  }
});

test("a public subpath has no internal export", () => {
  for (const entry of API_ENTRIES) {
    if (entry.subpath === "okmodel/internal") continue;
    const actual = classifyEntry(readEntry(join(root, entry.file)), entry.subpath);
    const internal = actual.filter((item) => item.kind === "internal").map((item) => item.name);
    expect(internal, entry.subpath).toEqual([]);
  }
});

test("okmodel/internal export statements carry @internal", () => {
  const source = readFileSync(join(root, "src/contracts/internal.ts"), "utf8");
  const parts = source.split(/\nexport /);
  expect(parts.length).toBeGreaterThan(1);
  for (const before of parts.slice(0, -1)) {
    expect(before).toContain("@internal");
  }
});

test("package exports are the snapshot subpaths", () => {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.exports)) {
    throw new Error("package.json exports are missing");
  }
  const published = Object.keys(parsed.exports)
    .map((key) => (key === "." ? "okmodel" : `okmodel${key.slice(1)}`))
    .sort();
  const snapshotted = API_ENTRIES.map((entry) => entry.subpath).sort();
  expect(published).toEqual(snapshotted);
  expect(published).not.toContain("okmodel/testing");
});

function readSnapshot(path: string): Readonly<Record<string, readonly ApiExport[]>> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("api snapshot is not an object");
  const snapshot: Record<string, readonly ApiExport[]> = {};
  for (const [subpath, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) throw new Error(`${subpath} is not a list`);
    snapshot[subpath] = value.map((item) => {
      if (!isExport(item)) throw new Error(`${subpath} has an export that is not classified`);
      return item;
    });
  }
  return snapshot;
}

function isExport(value: unknown): value is ApiExport {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.kind === "stable" || value.kind === "experimental" || value.kind === "internal")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
