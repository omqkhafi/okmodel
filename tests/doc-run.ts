/**
 * Shared pieces for tests that run commands copied out of `docs/`.
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One fenced block and the line that introduces it. */
export type MarkdownFence = {
  /** The line before the fence. Empty when the fence opens the file. */
  readonly label: string;
  /** Info string, such as `ts` or `sh`. */
  readonly lang: string;
  /** Fence body, without the surrounding backticks. */
  readonly code: string;
};

/** A Postgres URL served by an in-process PGlite wire server. */
export type ListeningPostgres = {
  /** `postgres://` URL for `okm migrate apply` and `connect`. */
  readonly url: string;
  /** Stops the server and closes the database. */
  close(): Promise<void>;
};

/**
 * Reads fenced code blocks in source order.
 *
 * @param markdown - A docs file
 * @returns Fences, with the line that introduces each one
 */
export function markdownFences(markdown: string): readonly MarkdownFence[] {
  const fences: MarkdownFence[] = [];
  for (const match of markdown.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
    const index = match.index ?? 0;
    const label = markdown.slice(0, index).trimEnd().split("\n").at(-1)?.trim() ?? "";
    fences.push({ label, lang: (match[1] ?? "").trim(), code: match[2] ?? "" });
  }
  return fences;
}

/**
 * File name from a label such as `` `schema.ts`: ``.
 *
 * @param label - The line before a fence
 * @returns The file name, or undefined when the label is not a file
 */
export function fenceFileName(label: string): string | undefined {
  return /^`([^`]+)`:?$/.exec(label.trim())?.[1];
}

/**
 * Non-empty, non-comment lines of a shell fence.
 *
 * @param code - Fence body
 * @returns Commands in order
 */
export function shellCommands(code: string): readonly string[] {
  return code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Inline `okm …` commands, not shell fences.
 *
 * @param markdown - A docs file
 * @returns Commands that include `--target`
 */
export function inlineOkmCommands(markdown: string): readonly string[] {
  const commands: string[] = [];
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const text = match[1]?.trim() ?? "";
    if (text.startsWith("okm ") && text.includes("--target")) commands.push(text);
  }
  return commands;
}

/**
 * Starts a Postgres wire server on an ephemeral port.
 *
 * `okm migrate apply` speaks a Postgres URL. The check job has no Docker
 * database, so the docs tests use this server.
 *
 * @returns The URL and a close function
 */
export async function listenPostgres(): Promise<ListeningPostgres> {
  const db = new PGlite("memory://");
  const server = new PGLiteSocketServer({
    db,
    port: 0,
    host: "127.0.0.1",
    maxConnections: 20,
  });
  await server.start();
  return {
    url: `postgres://postgres:postgres@${server.getServerConn()}/postgres`,
    async close() {
      await server.stop();
      await db.close();
    },
  };
}

/**
 * Packs the repository into a tarball.
 *
 * @param root - Repository root
 * @returns Absolute path of the new tarball
 */
export function pack(root: string): string {
  const before = new Set(readdirSync(root).filter((name) => name.endsWith(".tgz")));
  const proc = Bun.spawnSync(["bun", "pm", "pack"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`bun pm pack exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`);
  }
  const created = readdirSync(root).find((name) => name.endsWith(".tgz") && !before.has(name));
  if (created === undefined) throw new Error("bun pm pack did not write a tarball");
  return join(root, created);
}

/**
 * Runs one command and returns stdout.
 *
 * @param cwd - Working directory
 * @param args - Command and arguments, as the docs wrote them
 * @param env - Extra environment variables
 * @returns Stdout
 */
export async function command(
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  const proc = Bun.spawn([...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${args.join(" ")} exited ${String(code)}\n${stderr}\n${stdout}`);
  }
  return stdout;
}

/**
 * Creates an empty directory for one docs project.
 *
 * @param prefix - Directory name prefix
 * @returns Absolute path
 */
export function tempProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Removes a directory and a tarball.
 *
 * @param dir - Project directory
 * @param tarball - Packed tarball, when this test created it
 */
export function removeProject(dir: string, tarball?: string): void {
  rmSync(dir, { recursive: true, force: true });
  if (tarball !== undefined) rmSync(tarball, { force: true });
}
