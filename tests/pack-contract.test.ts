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
    files: ["src"],
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
