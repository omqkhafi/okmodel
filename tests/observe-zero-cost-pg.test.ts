/**
 * Zero cost with no observer, on a real database (G-8).
 *
 * `observe.test.ts` and `observe-query.test.ts` prove it against a fake pool.
 * This file extends it to every path that has an observer hook: autocommit,
 * read, batch, transaction, savepoint rollback, rollback, and failed
 * statements, on each adapter. A child process counts the clock reads made by
 * the observer paths and lists the observer modules it loaded, once with no
 * observer and once with both as a control.
 */

import { expect, test } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { DRIVERS, runnable } from "./observe-conformance-kit.js";

const gate = await loadPostgresGate();

type Report = {
  readonly quiet: { readonly reads: number; readonly loaded: readonly string[] };
  readonly watched: { readonly reads: number; readonly loaded: readonly string[] };
};

for (const driver of DRIVERS) {
  const title = `${driver}: with no observer no event is built, no clock is read, and no observer module loads`;
  if (!runnable(driver)) {
    test.skip(title, () => {});
    continue;
  }
  const run = async (): Promise<void> => {
    const child = Bun.spawnSync(["bun", "tests/observe-zero-cost.worker.ts", driver], {
      cwd: process.cwd(),
    });
    if (child.exitCode !== 0) {
      throw new Error(
        `worker exited ${String(child.exitCode)}\n${child.stdout.toString()}\n${child.stderr.toString()}`,
      );
    }
    const report = JSON.parse(
      child.stdout.toString().trim().split("\n").at(-1) as string,
    ) as Report;
    expect(report.quiet.reads).toBe(0);
    // observe-keys.ts is the 59-line key helper the write planner always imports. It builds no event.
    expect(report.quiet.loaded.filter((name) => name !== "observe-keys.ts")).toEqual([]);
    expect(report.watched.reads).toBeGreaterThan(0);
    expect(report.watched.loaded).toContain("observe-emit.ts");
    expect(report.watched.loaded).toContain("observe-query.ts");
  };
  if (driver === "pglite") test(title, run, { timeout: 60_000 });
  else postgresTest(gate, title, run, 60_000);
}
