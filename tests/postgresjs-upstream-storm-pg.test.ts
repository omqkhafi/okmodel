/**
 * Live proof that postgres.js alone still raises uncaught under a kill storm
 * (B-02). No OKModel imports. Fails if the upstream bug disappears without
 * updating docs/known-limits.md.
 */

import { expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();

type StormReport = {
  readonly crashes: number;
  readonly socket: number;
  readonly samples: readonly (readonly [string, string])[];
};

async function runRepro(runtime: "bun" | "node"): Promise<StormReport> {
  const env = { ...process.env, DATABASE_URL: primaryUrl() };
  const script = "docs/postgresjs-kill-storm.mjs";
  if (runtime === "bun") {
    const proc = Bun.spawn(["bun", script], {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const line = stdout
      .split("\n")
      .map((row) => row.trim())
      .find((row) => row.startsWith('{"postgres"'));
    expect(line, `${stdout}\n${stderr}`).toBeDefined();
    // Exit 1 is the expected upstream failure mode.
    expect([0, 1]).toContain(code);
    return JSON.parse(line!) as StormReport;
  }
  const dir = mkdtempSync(join(tmpdir(), "okm-pgjs-storm-"));
  const outfile = join(dir, "storm.mjs");
  const built = Bun.spawnSync(["bun", "build", script, "--target", "node", "--outfile", outfile], {
    cwd: repoRoot(),
  });
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const nodeChild = Bun.spawnSync(["node", outfile], {
    cwd: repoRoot(),
    timeout: 120_000,
    env,
  });
  const stdout = nodeChild.stdout?.toString() ?? "";
  const stderr = nodeChild.stderr?.toString() ?? "";
  const line = stdout
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.startsWith('{"postgres"'));
  expect(line, `${stdout}\n${stderr}`).toBeDefined();
  expect([0, 1]).toContain(nodeChild.exitCode);
  return JSON.parse(line!) as StormReport;
}

postgresTest(
  gate,
  "postgres.js alone: kill storm still raises uncaught socket.write (B-02 upstream)",
  async () => {
    const bunReport = await runRepro("bun");
    expect(bunReport.crashes).toBeGreaterThan(0);
    expect(bunReport.socket).toBeGreaterThan(0);
    console.info(
      `postgres.js upstream bun crashes=${String(bunReport.crashes)} socket=${String(bunReport.socket)}`,
    );

    let nodeMajor = 0;
    try {
      const proc = Bun.spawnSync(["node", "--version"], { stdout: "pipe" });
      if (proc.exitCode === 0) {
        nodeMajor = Number(proc.stdout.toString().trim().replace(/^v/, "").split(".")[0] ?? "0");
      }
    } catch {
      nodeMajor = 0;
    }
    if (nodeMajor >= 20) {
      const nodeReport = await runRepro("node");
      expect(nodeReport.crashes).toBeGreaterThan(0);
      expect(nodeReport.socket).toBeGreaterThan(0);
      console.info(
        `postgres.js upstream node crashes=${String(nodeReport.crashes)} socket=${String(nodeReport.socket)}`,
      );
    }
  },
  180_000,
);
