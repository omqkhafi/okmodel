/**
 * Fresh project: install the packed tarball, build, migrate on PGlite, query.
 */

import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

test("quickstart installs the tarball, migrates on PGlite, and queries", async () => {
  const root = repoRoot();
  if (!existsSync(join(root, "dist", "okm.js"))) {
    throw new Error("dist/okm.js is missing. bun run build writes it.");
  }
  const tarball = pack(root);
  const dir = mkdtempSync(join(tmpdir(), "okm-quickstart-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "okm-quickstart", private: true, type: "module" })}\n`,
    );
    cpSync(join(root, "tests/fixtures/quickstart"), dir, { recursive: true });
    await command(dir, ["bun", "add", tarball, "@electric-sql/pglite@0.5.8"]);
    await command(dir, ["bunx", "okm", "build"]);
    await command(dir, ["bunx", "okm", "generate", "init"]);
    const stdout = await command(dir, ["bun", "run.ts"]);
    expect(stdout.trim()).toBe("ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
}, 180_000);

function pack(root: string): string {
  const before = new Set(readdirSync(root).filter((name) => name.endsWith(".tgz")));
  const proc = Bun.spawnSync(["bun", "pm", "pack"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`bun pm pack exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`);
  }
  const created = readdirSync(root).find((name) => name.endsWith(".tgz") && !before.has(name));
  if (created === undefined) throw new Error("bun pm pack did not write a tarball");
  return join(root, created);
}

async function command(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${args.join(" ")} exited ${String(code)}\n${stderr}\n${stdout}`);
  }
  return stdout;
}
