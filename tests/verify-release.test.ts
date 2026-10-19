/**
 * The published 0.9.1 tarball matches a clean pack of v0.9.1.
 * A tampered tarball does not.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { ancestryProblem, ancestryWarning, tarballHashProblem } from "../scripts/verify-release.js";

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

test("a tampered tarball fails the hash check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-verify-tamper-"));
  try {
    writeFileSync(join(dir, "note.txt"), "ok\n");
    const proc = Bun.spawn(["tar", "-czf", "good.tgz", "note.txt"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    const packed = new Uint8Array(readFileSync(join(dir, "good.tgz")));
    const published = new Uint8Array(packed);
    const last = published.length - 1;
    const byte = published[last];
    if (byte === undefined) throw new Error("tarball is empty");
    published[last] = byte ^ 0xff;
    expect(tarballHashProblem(packed, packed, "v0.0.0")).toBeUndefined();
    const problem = tarballHashProblem(published, packed, "v0.0.0");
    expect(problem).toContain("sha256");
    expect(problem).toContain("does not match the pack of v0.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("published 0.9.1 matches a pack of v0.9.1 and warns that the tag is not on main", async () => {
  const proc = Bun.spawn(["bun", "./scripts/verify-release.ts", "0.9.1"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  expect(stdout).toContain("sha256");
  expect(stdout).toContain("matches the pack of v0.9.1");
  expect(stdout).toContain("known tag-not-on-main");
  expect(stdout).toContain("package.json version 0.9.1");
  expect(stdout).toContain("npm audit signatures verified the attestation");
  expect(stdout).toContain("warning: tag v0.9.1 has no pack-contract snapshot");
  expect(stderr).toBe("");
}, 240_000);
