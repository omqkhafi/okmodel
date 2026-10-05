/**
 * The gate properties are sensitive (P30): with a defect on the wire they fail.
 *
 * Each case runs a gate property file in a child process with
 * `OKM_GATE_MUTATE` set (see `gate-env.ts`) and expects that run to fail on the
 * named property. A property that stays green here is a property that cannot see.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";

const gate = await loadPostgresGate();

const CASES = [
  [
    "tests/safety-gate.property.test.ts",
    "hidden",
    "safety.property: a hidden field never reaches a default projection",
  ],
  [
    "tests/safety-gate.property.test.ts",
    "active",
    "safety.property: a preset never removes the tenant, the active set or the caller's filter",
  ],
  [
    "tests/archive-gate.property.test.ts",
    "restore",
    "archive.correctness: random sequences match the contract, with tenancy and inside tx",
  ],
] as const;

for (const [file, mode, property] of CASES) {
  postgresTest(
    gate,
    `a wire defect (${mode}) makes ${property} fail`,
    async () => {
      const child = Bun.spawn(["bun", "test", file], {
        env: { ...process.env, OKM_GATE_MUTATE: mode },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const code = await child.exited;
      const text = `${out}\n${err}`;
      expect(code, text).not.toBe(0);
      expect(text).toContain(`(fail) ${property}`);
    },
    120_000,
  );
}
