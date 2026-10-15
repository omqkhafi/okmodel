/**
 * An untracked file under `src/` fails the tarball check.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an untracked source file is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "okm-pack-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "okm-pack-fixture", version: "0.0.0", files: ["src"] })}\n`,
    );
    writeFileSync(join(root, "src", "ok.ts"), "export const ok = 1;\n");
    git(root, ["init"]);
    git(root, ["add", "package.json", "src/ok.ts"]);
    git(root, [
      "-c",
      "user.email=pack@example.com",
      "-c",
      "user.name=pack",
      "commit",
      "-m",
      "seed",
    ]);
    writeFileSync(join(root, "src", "leak.ts"), "export const leak = 1;\n");
    const failed = Bun.spawn(["bun", "./scripts/pack-tracked.ts", "--root", root], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(failed.stderr).text();
    expect(await failed.exited).not.toBe(0);
    expect(stderr).toContain("src/leak.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || `git ${args.join(" ")} failed`);
  }
}
