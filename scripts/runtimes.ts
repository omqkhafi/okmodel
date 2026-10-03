/**
 * Runs the unit checks that each runtime can run.
 *
 * Bun runs `bun test`. This script runs the portable checks on Node and Deno,
 * imports the runtime entry as an edge bundle, and prints a skip with a reason
 * for every test file a runtime cannot execute.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

const PORTABLE = "tests/portable/entry.ts";
const RUNTIME_ENTRY = "src/contracts/index.ts";

if (import.meta.main) {
  const problems = runtimeProblems(repoRoot());
  exitOnProblems(problems);
}

/**
 * Runs Node, Deno, and the edge import. Prints every skip.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when every runnable check passed
 */
export function runtimeProblems(root: string): readonly string[] {
  const problems: string[] = [];
  const files = testFiles(root);
  problems.push(...runRuntime(root, "node", files));
  problems.push(...runRuntime(root, "deno", files));
  problems.push(...edgeProblems(root, files));
  return problems;
}

function testFiles(root: string): readonly string[] {
  const dir = join(root, "tests");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

function runRuntime(
  root: string,
  runtime: "node" | "deno",
  files: readonly string[],
): readonly string[] {
  const found = commandVersion(runtime);
  if (found === undefined) {
    const reason = `${runtime} is not on PATH`;
    console.log(`skip ${runtime}: ${reason}`);
    if (process.env.CI === "true" || process.env.CI === "1") {
      return [`runtimes: ${reason}, and CI must run it`];
    }
    return [];
  }
  if (runtime === "node" && !nodeAtLeast22(found)) {
    const reason = `node ${found} is older than engines.node >=22`;
    console.log(`skip node: ${reason}`);
    if (process.env.CI === "true" || process.env.CI === "1") return [`runtimes: ${reason}`];
    return [];
  }
  console.log(
    `skip ${runtime}: ${String(files.length)} files under tests/*.test.ts import bun:test`,
  );
  const dir = mkdtempSync(join(tmpdir(), "okm-runtime-"));
  const outfile = join(dir, "ids.mjs");
  try {
    const built = bunBuild(root, join(root, PORTABLE), outfile, "node");
    if (built !== undefined) return [built];
    const ran = spawn(
      runtime === "node" ? ["node", outfile] : ["deno", "run", "--allow-env", outfile],
    );
    if (ran.code !== 0) {
      return [`runtimes: ${runtime} portable checks failed\n${ran.stderr}${ran.stdout}`];
    }
    console.log(`runtimes: ${runtime} ${found} ran ${PORTABLE}`);
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function edgeProblems(root: string, files: readonly string[]): readonly string[] {
  console.log(
    `skip edge: ${String(files.length)} files under tests/*.test.ts; the edge check imports only the runtime entry`,
  );
  const dir = mkdtempSync(join(tmpdir(), "okm-edge-"));
  const outfile = join(dir, "entry.mjs");
  try {
    const built = bunBuild(root, join(root, RUNTIME_ENTRY), outfile, "browser");
    if (built !== undefined) return [`runtimes: edge bundle failed\n${built}`];
    const text = readFileSync(outfile, "utf8");
    const problems: string[] = [];
    if (text.includes("node:")) problems.push("runtimes: edge bundle imports node:");
    if (/\bBun\b/.test(text)) problems.push("runtimes: edge bundle references Bun");
    if (/\bprocess\./.test(text)) problems.push("runtimes: edge bundle references process");
    if (problems.length > 0) return problems;
    const ran = spawn(["node", outfile]);
    if (ran.code !== 0) {
      return [`runtimes: node could not import the edge bundle\n${ran.stderr}${ran.stdout}`];
    }
    console.log("runtimes: edge bundle of the runtime entry imported on node");
    if (commandVersion("deno") === undefined) {
      console.log("skip edge deno: deno is not on PATH");
      if (process.env.CI === "true" || process.env.CI === "1") {
        return ["runtimes: edge import on deno did not run, and CI must run it"];
      }
      return [];
    }
    const deno = spawn(["deno", "run", "--allow-env", outfile]);
    if (deno.code !== 0) {
      return [`runtimes: deno could not import the edge bundle\n${deno.stderr}${deno.stdout}`];
    }
    console.log("runtimes: edge bundle of the runtime entry imported on deno");
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function bunBuild(
  root: string,
  entry: string,
  outfile: string,
  target: "node" | "browser",
): string | undefined {
  const proc = spawnSync(
    "bun",
    ["build", entry, "--target", target, "--outfile", outfile, "--format", "esm"],
    { cwd: root, encoding: "utf8" },
  );
  if (proc.status === 0) return undefined;
  return proc.stderr || proc.stdout || `bun build ${entry} failed`;
}

function commandVersion(command: string): string | undefined {
  const proc = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (proc.status !== 0) return undefined;
  const line = `${proc.stdout}${proc.stderr}`.trim().split("\n")[0] ?? "";
  return line.length === 0 ? command : line;
}

function nodeAtLeast22(versionText: string): boolean {
  const match = /v?(\d+)/.exec(versionText);
  const major = Number(match?.[1] ?? "0");
  return major >= 22;
}

function spawn(args: readonly string[]): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const proc = spawnSync(args[0] ?? "", args.slice(1), { encoding: "utf8" });
  return {
    code: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}
