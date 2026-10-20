/**
 * A packed stray file, then a postinstall script, each fail the pack contract.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a stray packed file, then a postinstall script, fails the pack contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "okm-pack-contract-"));
  const repo = join(import.meta.dir, "..");
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "ok.js"), "export const ok = 1;\n");
    writeManifest(root, {});
    const updated = await run(repo, root, ["--update"]);
    expect(updated.code, updated.stderr).toBe(0);
    const clean = await run(repo, root, []);
    expect(clean.code, clean.stderr).toBe(0);

    writeFileSync(join(root, "src", "leak.ts"), "export const leak = 1;\n");
    const stray = await run(repo, root, []);
    expect(stray.code).not.toBe(0);
    expect(stray.stderr).toContain("src/leak.ts");

    rmSync(join(root, "src", "leak.ts"));
    writeManifest(root, { postinstall: "echo pwned" });
    const hooked = await run(repo, root, []);
    expect(hooked.code).not.toBe(0);
    expect(hooked.stderr).toContain("postinstall");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("a changed chunk hash passes, and a new or removed chunk fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "okm-pack-chunk-"));
  const repo = join(import.meta.dir, "..");
  const shared = join(root, "dist", "shared");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "ok.js"), "export const ok = 1;\n");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "aaaaaaaa.js"), "export const a = 1;\n");
    writeFileSync(join(shared, "bbbbbbbb.js"), "export const b = 1;\n");
    writeFileSync(join(root, "dist", "index.js"), "export const ok = 1;\n");
    writeManifest(root, {});
    const updated = await run(repo, root, ["--update"]);
    expect(updated.code, updated.stderr).toBe(0);
    const snapshot = await Bun.file(join(root, "pack-contract.snap.json")).text();
    expect(snapshot).toContain("dist/shared/*.js");
    expect(snapshot).not.toContain("aaaaaaaa.js");
    expect(snapshot).not.toContain("bbbbbbbb.js");

    rmSync(join(shared, "aaaaaaaa.js"));
    writeFileSync(join(shared, "cccccccc.js"), "export const a = 1;\n");
    const renamed = await run(repo, root, []);
    expect(renamed.code, renamed.stderr).toBe(0);

    writeFileSync(join(shared, "dddddddd.js"), "export const d = 1;\n");
    const added = await run(repo, root, []);
    expect(added.code).not.toBe(0);
    expect(added.stderr).toContain("dist/shared/*.js");

    rmSync(join(shared, "dddddddd.js"));
    rmSync(join(shared, "bbbbbbbb.js"));
    const removed = await run(repo, root, []);
    expect(removed.code).not.toBe(0);
    expect(removed.stderr).toContain("dist/shared/*.js");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

/**
 * Writes a fixture manifest. `scripts` is omitted when empty.
 *
 * @param root - Fixture directory
 * @param scripts - Script entries to set
 */
function writeManifest(root: string, scripts: Readonly<Record<string, string>>): void {
  const manifest: Record<string, unknown> = {
    name: "okm-pack-fixture",
    version: "0.0.0",
    files: ["src", "dist"],
    exports: { ".": { import: "./src/ok.js" } },
  };
  if (Object.keys(scripts).length > 0) manifest.scripts = scripts;
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Runs the pack contract against a fixture.
 *
 * @param repo - Repository root, so the script path resolves
 * @param root - Fixture package
 * @param args - Extra arguments (`--update`)
 * @returns Exit code and standard error
 */
async function run(
  repo: string,
  root: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stderr: string }> {
  const proc = Bun.spawn(["bun", "./scripts/pack-contract.ts", "--root", root, ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}
