/**
 * Runs the `okm` bin for the output tests: through pipes, or through a
 * pseudo-terminal (`Bun.spawn({ terminal })`, POSIX only).
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

const bin = join(repoRoot(), "src/tooling/cli.ts");
const ESC = String.fromCharCode(27);
const CURSOR_MOVES = new RegExp(`${ESC}\\[\\d*[GJK]`, "g");
const STYLES = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Variables that decide the output mode. A test sets what it needs. */
const MODE_VARIABLES = ["NO_COLOR", "FORCE_COLOR", "CI", "TERM", "OKM_DEBUG"] as const;

/** What one run printed. */
export type Ran = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function cleanEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(MODE_VARIABLES as readonly string[]).includes(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

/**
 * Runs `okm` with stdout and stderr on pipes.
 *
 * @param cwd - Working directory
 * @param args - Arguments after `okm`
 * @param env - Mode variables to set. The others are removed
 * @returns Exit code and both streams
 */
export function okm(cwd: string, args: readonly string[], env: Record<string, string> = {}): Ran {
  const result = spawnSync("bun", [bin, ...args], { cwd, encoding: "utf8", env: cleanEnv(env) });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Whether this machine can run a pseudo-terminal test. */
export const hasPty = process.platform !== "win32" && typeof Bun !== "undefined";

/** Options for {@link okmPty}. */
export type PtyOptions = {
  readonly columns?: number;
  readonly env?: Record<string, string>;
  /** Lines to type, one after each pause in the output. */
  readonly answers?: readonly string[];
};

/**
 * Runs `okm` with stdin, stdout, and stderr on one pseudo-terminal.
 *
 * Every answer is typed once the output has been quiet for a moment.
 *
 * @param cwd - Working directory
 * @param args - Arguments after `okm`
 * @param options - Width, mode variables, and answers
 * @returns The exit code and everything the terminal showed, newlines as `\n`
 */
export async function okmPty(
  cwd: string,
  args: readonly string[],
  options: PtyOptions = {},
): Promise<{ readonly code: number; readonly output: string }> {
  const chunks: string[] = [];
  const answers = [...(options.answers ?? [])];
  const proc = Bun.spawn(["bun", bin, ...args], {
    cwd,
    env: cleanEnv({ TERM: "xterm-256color", ...options.env }),
    terminal: {
      cols: options.columns ?? 100,
      rows: 30,
      data(_terminal: unknown, data: Uint8Array) {
        chunks.push(new TextDecoder().decode(data));
      },
    },
  });
  let seen = 0;
  const typing = setInterval(() => {
    const length = chunks.join("").length;
    if (length === seen || length === 0) return;
    seen = length;
    setTimeout(() => {
      if (chunks.join("").length !== length) return;
      const next = answers.shift();
      if (next !== undefined) proc.terminal?.write(`${next}\r`);
    }, 400);
  }, 250);
  const killer = setTimeout(() => proc.kill(), 60_000);
  const code = await proc.exited;
  clearInterval(typing);
  clearTimeout(killer);
  return { code, output: normalizeTerminal(chunks.join("")) };
}

/**
 * Removes the cursor movements readline writes and turns `\r\n` into `\n`.
 *
 * Color sequences stay, so a test sees what a person would.
 */
export function normalizeTerminal(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "").replace(CURSOR_MOVES, "");
}

/** Removes every ANSI color or style sequence. */
export function stripAnsi(text: string): string {
  return text.replace(STYLES, "");
}
