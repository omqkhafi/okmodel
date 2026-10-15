/**
 * postgres.js calls settle under a backend-kill storm, and a close before
 * the first reserve does not poison the next reserve.
 */

import { expect } from "bun:test";

import { open } from "../src/adapters/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "../scripts/root.js";
import postgres from "postgres";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "a backend kill before the first reserve still allows a reserve",
  async () => {
    const url = primaryUrl();
    const pool = open({ url, max: 2 });
    const admin = postgres(url, { max: 1, fetch_types: false });
    try {
      await pool.execute("select 1");
      await admin.unsafe(
        "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'okmodel' and pid <> pg_backend_pid()",
      );
      await Bun.sleep(50);
      const connection = await pool.reserve?.();
      if (connection === undefined) throw new Error("reserve");
      const result = await connection.execute("select 1");
      expect(result.rows.length).toBe(1);
      await connection.release();
    } finally {
      await admin.end({ timeout: 1 });
      await pool.close();
    }
  },
  20_000,
);

postgresTest(
  gate,
  "every in-flight call settles under a kill storm",
  async () => {
    const proc = Bun.spawn(["bun", "tests/postgres-kill-storm.worker.ts"], {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    const line = stdout.trim().split("\n").at(-1) ?? "";
    const report = JSON.parse(line) as {
      settled: number;
      hung: number;
      maxMs: number;
      crashes: string[];
    };
    expect(report.settled).toBe(200 * 8);
    expect(report.hung).toBe(0);
    expect(report.maxMs).toBeLessThanOrEqual(10_000);
    console.info(
      `kill storm settled=${report.settled} hung=${report.hung} maxMs=${report.maxMs} unhandled=${report.crashes.length}`,
    );
    for (const crash of report.crashes) {
      expect(crash).toContain("typarray");
    }
  },
  180_000,
);
