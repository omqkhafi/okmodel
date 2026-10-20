/**
 * Recorded-tarball checks use fixture archives. Nothing here contacts the registry.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import {
  ancestryProblem,
  ancestryWarning,
  assessRecorded,
  rebuildWarning,
  writeReleaseRecord,
  type ReleaseRecord,
} from "../scripts/verify-release.js";

const root = repoRoot();

test("v0.9.1 off main is the known warning", () => {
  expect(ancestryWarning("0.9.1", false)).toBe(
    "warning: tag v0.9.1 is not on main (known tag-not-on-main)",
  );
  expect(ancestryProblem("0.9.1", false)).toBeUndefined();
  expect(ancestryWarning("0.9.1", true)).toBeUndefined();
  expect(ancestryProblem("0.10.0", false)).toBe("tag v0.10.0 is not on main");
  expect(ancestryWarning("0.10.0", false)).toBeUndefined();
});

test("a rebuild comparison warns and does not throw", () => {
  const published = new Uint8Array([1, 2, 3]);
  const packed = new Uint8Array([1, 2, 4]);
  const mismatch = rebuildWarning(published, packed);
  expect(mismatch.startsWith("warning:")).toBe(true);
  expect(mismatch).toContain("does not match the published tarball");
  expect(mismatch).toContain("not a gate");
  const match = rebuildWarning(published, published);
  expect(match.startsWith("warning:")).toBe(true);
  expect(match).toContain("matches the published tarball");
  expect(match).toContain("not a gate");
});

test("a recorded tarball matches sha256, file list, and version", async () => {
  const bytes = await fixtureTarball({
    "package/package.json": `${JSON.stringify({ name: "okmodel", version: "0.0.1" })}\n`,
    "package/note.txt": "ok\n",
  });
  const record = await recordOf(bytes);
  const result = await assessRecorded(bytes, "0.0.1", record);
  expect(result.problems).toEqual([]);
  expect(result.lines.join("\n")).toContain("matches the recorded tarball");
  expect(result.lines.join("\n")).toContain("file list matches the recorded tarball");
  expect(result.lines.join("\n")).toContain("package.json version 0.0.1");
});

test("a tampered tarball fails the recorded hash", async () => {
  const bytes = await fixtureTarball({
    "package/package.json": `${JSON.stringify({ name: "okmodel", version: "0.0.1" })}\n`,
    "package/note.txt": "ok\n",
  });
  const record = await recordOf(bytes);
  const published = new Uint8Array(bytes);
  const last = published.length - 1;
  const byte = published[last];
  if (byte === undefined) throw new Error("tarball is empty");
  published[last] = byte ^ 0xff;
  const result = await assessRecorded(published, "0.0.1", record);
  const text = result.problems.join("\n");
  expect(text).toContain("sha256");
  expect(text).toContain("does not match the recorded tarball");
});

test("the wrong package.json version fails", async () => {
  const bytes = await fixtureTarball({
    "package/package.json": `${JSON.stringify({ name: "okmodel", version: "0.0.1" })}\n`,
    "package/note.txt": "ok\n",
  });
  const record = await recordOf(bytes);
  const result = await assessRecorded(bytes, "9.9.9", record);
  const text = result.problems.join("\n");
  expect(text).toContain("package.json version is 0.0.1, expected 9.9.9");
  expect(text).not.toContain("does not match the recorded tarball");
  expect(text).not.toContain("file list differs");
});

test("a recorded file list that differs fails", async () => {
  const bytes = await fixtureTarball({
    "package/package.json": `${JSON.stringify({ name: "okmodel", version: "0.0.1" })}\n`,
    "package/note.txt": "ok\n",
  });
  const record = await recordOf(bytes);
  const mismatched: ReleaseRecord = { sha256: record.sha256, files: ["missing.txt"] };
  const result = await assessRecorded(bytes, "0.0.1", mismatched);
  const text = result.problems.join("\n");
  expect(text).toContain("file list differs from the recorded tarball");
  expect(text).toContain("note.txt");
  expect(text).toContain("missing.txt");
  expect(result.lines.join("\n")).toContain("matches the recorded tarball");
  expect(text).not.toContain("does not match the recorded tarball");
});

test("a record without a sha256 fails", async () => {
  const bytes = await fixtureTarball({
    "package/package.json": `${JSON.stringify({ name: "okmodel", version: "0.0.1" })}\n`,
    "package/note.txt": "ok\n",
  });
  const record = await recordOf(bytes);
  const result = await assessRecorded(bytes, "0.0.1", { files: record.files });
  expect(result.problems).toContain("recorded tarball has no sha256");
});

test("the hand command documents --recorded", async () => {
  const proc = Bun.spawn(["bun", "./scripts/verify-release.ts"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(stderr).toContain("usage: bun ./scripts/verify-release.ts <version> [--recorded <path>]");
});

/**
 * @param files - Paths and text inside the archive
 * @returns Gzip tarball bytes
 */
async function fixtureTarball(files: Readonly<Record<string, string>>): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "okm-verify-fixture-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    const proc = Bun.spawn(["tar", "-czf", "pack.tgz", "package"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    return new Uint8Array(readFileSync(join(dir, "pack.tgz")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param bytes - Tarball bytes
 * @returns The release record for those bytes
 */
async function recordOf(bytes: Uint8Array): Promise<ReleaseRecord> {
  const dir = mkdtempSync(join(tmpdir(), "okm-verify-record-"));
  try {
    const tarball = join(dir, "okmodel.tgz");
    const out = join(dir, "release-record.json");
    writeFileSync(tarball, bytes);
    return await writeReleaseRecord(tarball, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
