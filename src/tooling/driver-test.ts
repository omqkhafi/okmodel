/**
 * `okm driver test`.
 *
 * The runner lives in the harness and reuses the conformance suites. This
 * file only finds that runner and prints what it writes. Tooling does not
 * import the harness.
 */

import { spawn } from "node:child_process";
import { type EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OkmError } from "../contracts/error.js";

/**
 * Runs the conformance suites for the driver named on the command line.
 *
 * `<driver>` is `pglite`, `postgresjs`, `pg`, `bun`, `neon`, or a module path.
 * `--url` is the Postgres URL. `pglite` does not use it. The other built-in
 * drivers need `--url` or `DATABASE_URL`. A module whose export sets
 * `memory: true` does not need a URL.
 *
 * The report is one header (`driver`, `dialect postgres`) and one row per
 * case: id, behavior, result (`pass`, `fail`, or `unsupported`), and the
 * capability when the result is unsupported. A failure exits through
 * {@link OkmError}. An unsupported case does not.
 *
 * @param args - Arguments after `driver test`
 * @param stdout - Where the report is written
 */
export async function driverTest(
  args: readonly string[],
  stdout: (text: string) => void,
): Promise<void> {
  const runner = runnerPath();
  if (!existsSync(runner)) {
    throw new OkmError("invalid", "okm driver test cannot find its runner.", {
      fix: { summary: "Run bun run build, then retry." },
    });
  }
  const command = runner.endsWith(".ts") ? "bun" : process.execPath;
  const result = await runProcess(command, [runner, ...args]);
  if (result.stdout.length > 0) stdout(result.stdout);
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new OkmError("invalid", detail === "" ? "okm driver test failed." : detail, {
      fix: { summary: "The report lists each failed case." },
    });
  }
}

function runnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, "..", "..", "packages", "harness", "src", "driver-run.ts");
  if (existsSync(source)) return source;
  return join(here, "driver-run.js");
}

function runProcess(
  command: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    const proc = child as unknown as EventEmitter;
    proc.on("error", reject);
    proc.on("close", (code: number | null) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}
