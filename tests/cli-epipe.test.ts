/**
 * Node exits when `okm`'s stderr pipe is already closed (`okm … 2>&1 | head`).
 *
 * The postgres.js adapter keeps an `uncaughtException` listener. Printing that
 * EPIPE writes stderr again, which raises another EPIPE, and Node stays at
 * 100% CPU. Bun exits 1. The process has to exit with some code.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";

/**
 * `ChildProcess` emits `"exit"` at runtime. TypeScript 7 does not put that
 * listener on the class instance type, so the wait uses this shape.
 */
type ExitWait = {
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

test("node okm exits when stderr is closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-epipe-"));
  const outfile = join(dir, "okm.mjs");
  const built = spawnSync(
    "bun",
    ["build", join(repoRoot(), "src/tooling/cli.ts"), "--target", "node", "--outfile", outfile],
    { encoding: "utf8" },
  );
  expect(built.status, built.stderr).toBe(0);
  const child = spawn("node", [outfile, "build"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // `2>&1 | head` closes the pipe after the first line. Destroying both ends
  // is that same closed pipe, without a race on how fast head reads.
  child.stdout?.destroy();
  child.stderr?.destroy();
  const result = await stopped(child as unknown as ExitWait, 2_000);
  try {
    expect(result.signal).toBeNull();
    expect(typeof result.code).toBe("number");
  } finally {
    if (result.signal !== null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

function stopped(
  child: ExitWait,
  ms: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, "SIGKILL");
    }, ms);
    child.once("exit", (code, signal) => finish(code, signal));
  });
}
