import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  budgetReport,
  ceilingProblems,
  columnTypeProblems,
  measureTypeCost,
  type ColumnTypeCost,
  type TypeBudgetRow,
} from "../scripts/type-cost.js";
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

test("type ceilings fail when a fixture is over the D133 limits", () => {
  const rows: TypeBudgetRow[] = [
    row("inferred-50", 50, 15_000, 3_000),
    row("inferred-200", 200, 80_000, 12_000),
    row("inferred-500", 500, 200_000, 20_000),
    row("emitted-200", 200, 0, 900),
    row("equality-200", 200, 20, 800),
    row("tagged-200", 200, 2_000, 1_400),
  ];
  const problems = ceilingProblems(budgetReport(rows));
  expect(problems.some((problem) => problem.includes("inferred 200"))).toBe(true);
  expect(problems.some((problem) => problem.includes("inferred 500"))).toBe(true);
  expect(problems.some((problem) => problem.includes("emitted"))).toBe(true);
  expect(problems.some((problem) => problem.includes("per table"))).toBe(true);
  expect(problems.some((problem) => problem.includes("tagged operators"))).toBe(true);
});

test("column type ceilings fail when the sample is over the limit", () => {
  const over: ColumnTypeCost = {
    project: "tests/fixtures/type-cost-columns",
    instantiations: 7_000,
    types: 9_000,
    checkTimeSeconds: 0,
  };
  const problems = columnTypeProblems(over);
  expect(problems.some((problem) => problem.includes("instantiations"))).toBe(true);
  expect(problems.some((problem) => problem.includes("types"))).toBe(true);
  expect(columnTypeProblems({ ...over, instantiations: 500, types: 800 })).toEqual([]);
});

function row(label: string, tables: number, instantiations: number, types: number): TypeBudgetRow {
  return { label, tables, instantiations, types, checkTimeSeconds: 0 };
}
