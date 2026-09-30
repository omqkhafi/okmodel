import { expect, test } from "bun:test";
import { join } from "node:path";

import { measureTypeCost } from "../scripts/type-cost.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("tsc rejects a wrong expectTypeOf assertion", () => {
  const proc = Bun.spawnSync(
    [
      "bunx",
      "tsc",
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      join(root, "tests", "fixtures", "expect-type"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  expect(proc.exitCode).not.toBe(0);
  expect(output).toContain("wrong.test-d.ts");
  expect(output).toContain("TS2344");
});

test("type-cost parses TypeScript 7 diagnostics for a trivial type", () => {
  const report = measureTypeCost();
  expect(report.compiler.startsWith("7.")).toBe(true);
  expect(report.project).toBe("tests/fixtures/type-cost");
  expect(report.instantiations).toBeGreaterThanOrEqual(0);
  expect(report.checkTimeSeconds).toBeGreaterThanOrEqual(0);
  expect(report.memoryUsedKb).toBeGreaterThan(0);
  expect(report.types).toBeGreaterThan(0);
  expect(report.fields["Instantiations"]).toBe(report.instantiations);
  expect(report.fields["Check time"]).toBe(report.checkTimeSeconds);
  expect(report.fields["Memory used"]).toBe(report.memoryUsedKb);
  expect(report.fields["Types"]).toBe(report.types);
  expect(report.traceOptions).toContain("generateTrace");
});
