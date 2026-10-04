/**
 * OKM1201 on real Postgres, in a process that has not imported `okmodel/validate`.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "a write that would validate throws OKM1201 before any statement",
  async () => {
    const proc = Bun.spawn(["bun", "tests/validate-closed-pg.worker.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  },
  60_000,
);
