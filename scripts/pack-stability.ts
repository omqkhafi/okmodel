/**
 * Builds and packs this tree twice and prints both tarball sha256 values.
 *
 * The process exits 0 when the hashes differ or a build fails. The line is
 * informational. It is not a release gate.
 *
 *   bun ./scripts/pack-stability.ts
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";
import { sha256Hex } from "./verify-release.js";

/**
 * Whether two packs of one tree produced the same tarball.
 *
 * @param first - sha256 of the first pack
 * @param second - sha256 of the second pack
 * @returns `pack-stability: match` or `pack-stability: differ`
 */
export function packStabilityLine(first: string, second: string): string {
  return first === second ? "pack-stability: match" : "pack-stability: differ";
}

if (import.meta.main) {
  try {
    const root = repoRoot();
    const first = await packOnce(root);
    const second = await packOnce(root);
    console.log(`pack-stability: first sha256 ${first}`);
    console.log(`pack-stability: second sha256 ${second}`);
    console.log(packStabilityLine(first, second));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`pack-stability: could not pack twice\n${message}`);
    console.log("pack-stability: differ");
  }
}

/**
 * Deletes `dist`, builds, packs, and removes the tarball.
 *
 * @param root - Repository root
 * @returns sha256 of the packed tarball
 */
async function packOnce(root: string): Promise<string> {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  for (const name of readdirSync(root)) {
    if (name.startsWith("okmodel-") && name.endsWith(".tgz")) rmSync(join(root, name));
  }
  const built = await command(root, ["bun", "run", "build"]);
  if (built.code !== 0) {
    throw new Error(tail(built.stderr || built.stdout) || "bun run build failed");
  }
  const packed = await command(root, ["bun", "pm", "pack"]);
  if (packed.code !== 0) {
    throw new Error(tail(packed.stderr || packed.stdout) || "bun pm pack failed");
  }
  const created = readdirSync(root).filter(
    (name) => name.startsWith("okmodel-") && name.endsWith(".tgz"),
  );
  const name = created[0];
  if (name === undefined || created.length !== 1) {
    throw new Error("bun pm pack did not write one tarball");
  }
  const bytes = new Uint8Array(readFileSync(join(root, name)));
  rmSync(join(root, name));
  return sha256Hex(bytes);
}

/** One finished command. */
type CommandResult = {
  /** Exit code. */
  readonly code: number;
  /** Standard output. */
  readonly stdout: string;
  /** Standard error. */
  readonly stderr: string;
};

/**
 * @param cwd - Working directory
 * @param args - Argv, including the executable
 * @returns The finished command
 */
async function command(cwd: string, args: readonly string[]): Promise<CommandResult> {
  const proc = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

/**
 * @param text - Command output
 * @returns The last lines, for a report
 */
function tail(text: string): string {
  return text.trim().split("\n").slice(-20).join("\n");
}
