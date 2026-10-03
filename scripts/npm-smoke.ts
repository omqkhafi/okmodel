/**
 * Installs the published package from npm and runs the README quickstart.
 *
 * The version comes from `package.json`. Registry propagation is retried at
 * most {@link ATTEMPTS} times, {@link WAIT_MS} apart. The run fails when that
 * version is missing or its provenance attestation is missing.
 *
 *   bun ./scripts/npm-smoke.ts
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import {
  command,
  fenceFileName,
  markdownFences,
  removeProject,
  shellCommands,
  tempProject,
} from "../tests/doc-run.js";
import { repoRoot } from "./root.js";

/** How many times the registry is asked before the smoke fails. */
const ATTEMPTS = 6;

/** Pause between registry attempts. */
const WAIT_MS = 10_000;

/**
 * Why a published version cannot be smoked, or undefined when it can.
 *
 * Accepts `npm view <name>@<version> version dist.attestations --json`.
 *
 * @param view - Parsed npm view JSON
 * @param version - Version the workflow just published
 * @returns The problem, or undefined when the version and its provenance are present
 */
export function publishedPackageProblem(view: unknown, version: string): string | undefined {
  if (!isRecord(view)) return "npm view did not return an object";
  if (view.version !== version) {
    return `npm has version ${shown(view.version)}, expected ${version}`;
  }
  const attestations = attestationsOf(view);
  if (attestations === undefined) return `okmodel@${version} has no provenance attestation`;
  const provenance = attestations.provenance;
  if (!isRecord(provenance)) return `okmodel@${version} provenance is missing`;
  return undefined;
}

function attestationsOf(view: Record<string, unknown>): Record<string, unknown> | undefined {
  const dotted = view["dist.attestations"];
  if (isRecord(dotted)) return dotted;
  const dist = view.dist;
  if (isRecord(dist) && isRecord(dist.attestations)) return dist.attestations;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shown(value: unknown): string {
  return typeof value === "string" ? value : "(missing)";
}

async function untilReady(label: string, fn: () => Promise<boolean>): Promise<void> {
  let last = `${label} did not succeed`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      if (await fn()) return;
      last = `${label} is not ready`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) await Bun.sleep(WAIT_MS);
  }
  throw new Error(`${last} after ${String(ATTEMPTS)} attempts, ${String(WAIT_MS)} ms apart`);
}

function readVersion(root: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json version is not a string");
  }
  return parsed.version;
}

async function viewPackage(version: string): Promise<unknown> {
  const proc = Bun.spawn(
    ["npm", "view", `okmodel@${version}`, "version", "dist.attestations", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`npm view exited ${String(code)}\n${stderr}`);
  return JSON.parse(stdout);
}

/**
 * Installs `okmodel@version` and runs the README quickstart on two databases.
 *
 * @param root - Repository root, for `README.md`
 * @param version - Published version
 */
async function runQuickstart(root: string, version: string): Promise<void> {
  const markdown = readFileSync(join(root, "README.md"), "utf8");
  const fences = markdownFences(markdown);
  const files = new Map<string, string>();
  const usage: string[] = [];
  for (const fence of fences) {
    if (fence.lang !== "ts") continue;
    const name = fenceFileName(fence.label);
    if (name === undefined) usage.push(fence.code);
    else files.set(name, fence.code);
  }
  if (usage.length === 0) throw new Error("README.md has no usage blocks");
  files.set("run.ts", usage.join("\n"));
  const commands = fences
    .filter((fence) => fence.lang === "sh")
    .flatMap((fence) => shellCommands(fence.code));
  const dir = tempProject("okm-npm-smoke-");
  const manifest = `${JSON.stringify({ name: "okm-npm-smoke", private: true, type: "module" })}\n`;
  try {
    await untilReady(`okmodel@${version}`, async () => {
      writeFileSync(join(dir, "package.json"), manifest);
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      rmSync(join(dir, "bun.lock"), { force: true });
      await command(dir, ["bun", "add", `okmodel@${version}`, "postgres"]);
      return true;
    });
    for (const [name, source] of files) writeFileSync(join(dir, name), source);
    const pushCommands = commands.filter((line) => line.startsWith("bunx okm push"));
    const migrateCommands = commands.filter(
      (line) => line.startsWith("bunx okm generate") || line.startsWith("bunx okm migrate apply"),
    );
    if (pushCommands.length !== 1) throw new Error("README.md must run okm push once");
    if (!migrateCommands.some((line) => line.startsWith("bunx okm generate"))) {
      throw new Error("README.md does not run okm generate");
    }
    if (!migrateCommands.some((line) => line.startsWith("bunx okm migrate apply"))) {
      throw new Error("README.md does not run okm migrate apply");
    }
    const push = await createIsolatedDatabase();
    try {
      const apply = await createIsolatedDatabase();
      try {
        for (const line of pushCommands) {
          await command(dir, line.split(/\s+/), { DATABASE_URL: push.url });
        }
        await command(dir, ["bun", "run.ts"], { DATABASE_URL: push.url });
        for (const line of migrateCommands) {
          await command(dir, line.split(/\s+/), { DATABASE_URL: apply.url });
        }
        await command(dir, ["bun", "run.ts"], { DATABASE_URL: apply.url });
      } finally {
        await apply.close();
      }
    } finally {
      await push.close();
    }
  } finally {
    removeProject(dir);
  }
}

if (import.meta.main) {
  const root = repoRoot();
  const version = readVersion(root);
  await runQuickstart(root, version);
  await untilReady(`provenance for okmodel@${version}`, async () => {
    const view = await viewPackage(version);
    const problem = publishedPackageProblem(view, version);
    if (problem !== undefined) throw new Error(problem);
    return true;
  });
  console.error(`[npm-smoke] okmodel@${version} installed from npm and its provenance is present`);
}
