import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  budgetReport,
  measureTypeCost,
  typeCostMarkdown,
  type TypeBudgetRow,
  type TypeCostLine,
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

test("type-cost table reports the per-table rate and the tagged surcharge", () => {
  const rows: TypeBudgetRow[] = [
    row("inferred-50", 50, 15_000, 3_000),
    row("inferred-200", 200, 80_000, 12_000),
    row("inferred-250", 250, 100_000, 15_000),
    row("inferred-500", 500, 200_000, 20_000),
    row("emitted-200", 200, 0, 900),
    row("equality-200", 200, 20, 800),
    row("tagged-200", 200, 2_000, 1_400),
  ];
  const report = budgetReport(rows);
  expect(report.taggedOperatorSurcharge).toBe(1_980);
  expect(report.perAddedTable[0]?.instantiations).toBe((80_000 - 15_000) / 150);
  const lines: TypeCostLine[] = [
    { probe: "inferred-200", instantiations: 80_000, types: 12_000 },
    {
      probe: "50 to 200 per table",
      instantiations: report.perAddedTable[0]?.instantiations ?? 0,
      types: 0,
    },
  ];
  const markdown = typeCostMarkdown(lines);
  expect(markdown).toContain("| inferred-200 | 80000 | 12000 |");
  expect(markdown).toContain("| 50 to 200 per table | 433.3 | 0 |");
});

function row(label: string, tables: number, instantiations: number, types: number): TypeBudgetRow {
  return { label, tables, instantiations, types, checkTimeSeconds: 0 };
}
