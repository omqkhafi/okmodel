/**
 * Measures type cost with TypeScript 7's own diagnostics and applies D127 ceilings.
 *
 * The trivial project stays in the report. The ceilings cover the inferred
 * 200- and 500-table fixtures, the instantiations added per table, the emitted
 * consumer, the tagged-operator surcharge, and the column-type sample. Check
 * time is reported and is not a ceiling.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateFixture } from "../packages/harness/src/fixtures.js";
import { writeOperatorProject } from "../packages/spikes/src/safety/projects.js";
import {
  parseDiagnostics,
  runTsc as runProjectTsc,
} from "../packages/spikes/src/types/diagnostics.js";
import {
  writeEmittedProject,
  writeInferredProject,
} from "../packages/spikes/src/types/projects.js";
import { repoRoot } from "./root.js";

/** Counters parsed from `tsc --extendedDiagnostics`, plus which trace flags exist. */
export type TypeCostReport = {
  /** `tsc --version`, such as `7.0.2`. */
  readonly compiler: string;
  /** Project the diagnostics were collected from, relative to the repository root. */
  readonly project: string;
  /** `Instantiations` from the diagnostic block. */
  readonly instantiations: number;
  /** `Check time` in seconds. */
  readonly checkTimeSeconds: number;
  /** `Memory used`, in kilobytes. */
  readonly memoryUsedKb: number;
  /** `Types` from the diagnostic block. */
  readonly types: number;
  /** Every `Name: value` line the compiler printed, as a number. */
  readonly fields: Readonly<Record<string, number>>;
  /** Trace-related flags present in `tsc --help --all`. */
  readonly traceOptions: readonly string[];
};

const projectRelative = "tests/fixtures/type-cost";
const traceFlags = ["generateTrace", "traceResolution"] as const;

/**
 * Runs the TypeScript 7 compiler on the trivial type project and parses its diagnostics.
 */
export function measureTypeCost(): TypeCostReport {
  const root = repoRoot();
  const project = join(root, projectRelative);
  const diagnostics = runTsc([
    "--noEmit",
    "--pretty",
    "false",
    "--extendedDiagnostics",
    "-p",
    project,
  ]);
  const fields = parseDiagnosticFields(diagnostics);
  const version = runTsc(["--version"]).match(/(\d+\.\d+\.\d+)/);
  if (version?.[1] === undefined) {
    throw new Error(`tsc --version did not report a version\n${runTsc(["--version"])}`);
  }
  return {
    compiler: version[1],
    project: projectRelative,
    instantiations: requireField(fields, "Instantiations"),
    checkTimeSeconds: requireField(fields, "Check time"),
    memoryUsedKb: requireField(fields, "Memory used"),
    types: requireField(fields, "Types"),
    fields,
    traceOptions: traceOptionsPresent(runTsc(["--help", "--all"])),
  };
}

/** D127 type ceilings. Check time is reported beside these and is not capped. */
export const TYPE_CEILINGS = {
  inferred200Instantiations: 61_000,
  inferred200Types: 9_700,
  inferred500Instantiations: 140_000,
  instantiationsPerAddedTable: 300,
  emittedConsumerTypes: 700,
  taggedOperatorSurcharge: 800,
  columnInstantiations: 6_600,
  columnTypes: 8_200,
} as const;

/** Column-type sample measured beside the table fixtures. */
const columnProject = "tests/fixtures/type-cost-columns";

/** Instantiations and types for the column-type sample. */
export type ColumnTypeCost = {
  readonly project: string;
  readonly instantiations: number;
  readonly types: number;
  readonly checkTimeSeconds: number;
};

/** One fixture measured for the ceilings. */
export type TypeBudgetRow = {
  readonly label: string;
  readonly tables: number;
  readonly instantiations: number;
  readonly types: number;
  readonly checkTimeSeconds: number;
};

/** Instantiations added when the fixture grows from one size to the next. */
export type PerTableCost = {
  readonly fromTables: number;
  readonly toTables: number;
  readonly instantiations: number;
};

/** Ceiling inputs written next to the trivial measurement. */
export type TypeBudgetReport = {
  readonly rows: readonly TypeBudgetRow[];
  readonly perAddedTable: readonly PerTableCost[];
  readonly taggedOperatorSurcharge: number;
  readonly ceilings: typeof TYPE_CEILINGS;
};

/**
 * Writes the trivial measurement and the ceiling report as JSON.
 */
function writeReport(report: {
  readonly trivial: TypeCostReport;
  readonly budgets: TypeBudgetReport;
  readonly columns: ColumnTypeCost;
}): void {
  const results = join(repoRoot(), "packages", "bench", "results");
  mkdirSync(results, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(results, "type-cost.json"), json);
  process.stdout.write(json);
}

/**
 * Measures the fixture sizes the D127 ceilings name.
 *
 * Projects are written under a temporary directory and deleted afterwards.
 *
 * @returns Rows, the per-table rate, and the operator surcharge
 */
export function measureTypeBudgets(): TypeBudgetReport {
  const root = join(tmpdir(), `okm-type-budgets-${String(Date.now())}`);
  mkdirSync(root, { recursive: true });
  try {
    const rows: TypeBudgetRow[] = [];
    for (const tables of [50, 200, 500] as const) {
      const fixture = generateFixture({ seed: 1, tables });
      rows.push(
        measureProject(root, `inferred-${String(tables)}`, tables, (dir) => {
          writeInferredProject(dir, fixture);
        }),
      );
    }
    const twoHundred = generateFixture({ seed: 1, tables: 200 });
    rows.push(
      measureProject(root, "emitted-200", 200, (dir) => {
        writeEmittedProject(dir, twoHundred);
      }),
    );
    rows.push(
      measureProject(root, "equality-200", 200, (dir) => {
        writeOperatorProject(dir, twoHundred, "equality");
      }),
    );
    rows.push(
      measureProject(root, "tagged-200", 200, (dir) => {
        writeOperatorProject(dir, twoHundred, "tagged");
      }),
    );
    return budgetReport(rows);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Builds the ceiling report from measured rows.
 *
 * @param rows - Inferred, emitted, and operator projects
 * @returns The report `ceilingProblems` checks
 */
export function budgetReport(rows: readonly TypeBudgetRow[]): TypeBudgetReport {
  const tagged = rowNamed(rows, "tagged-200");
  const equality = rowNamed(rows, "equality-200");
  return {
    rows,
    perAddedTable: [
      perTable(rowNamed(rows, "inferred-50"), rowNamed(rows, "inferred-200")),
      perTable(rowNamed(rows, "inferred-200"), rowNamed(rows, "inferred-500")),
    ],
    taggedOperatorSurcharge: tagged.instantiations - equality.instantiations,
    ceilings: TYPE_CEILINGS,
  };
}

/**
 * Reports rows that exceed a D127 ceiling.
 *
 * @param report - Output of {@link measureTypeBudgets}
 * @returns Problem lines. Empty when every ceiling holds
 */
export function ceilingProblems(report: TypeBudgetReport): readonly string[] {
  const problems: string[] = [];
  const inferred200 = rowNamed(report.rows, "inferred-200");
  const inferred500 = rowNamed(report.rows, "inferred-500");
  const emitted200 = rowNamed(report.rows, "emitted-200");
  if (inferred200.instantiations > TYPE_CEILINGS.inferred200Instantiations) {
    problems.push(
      `type-cost: inferred 200 tables used ${String(inferred200.instantiations)} instantiations, above ${String(TYPE_CEILINGS.inferred200Instantiations)}`,
    );
  }
  if (inferred200.types > TYPE_CEILINGS.inferred200Types) {
    problems.push(
      `type-cost: inferred 200 tables used ${String(inferred200.types)} types, above ${String(TYPE_CEILINGS.inferred200Types)}`,
    );
  }
  if (inferred500.instantiations > TYPE_CEILINGS.inferred500Instantiations) {
    problems.push(
      `type-cost: inferred 500 tables used ${String(inferred500.instantiations)} instantiations, above ${String(TYPE_CEILINGS.inferred500Instantiations)}`,
    );
  }
  if (emitted200.types > TYPE_CEILINGS.emittedConsumerTypes) {
    problems.push(
      `type-cost: emitted 200-table consumer used ${String(emitted200.types)} types, above ${String(TYPE_CEILINGS.emittedConsumerTypes)}`,
    );
  }
  for (const step of report.perAddedTable) {
    if (step.instantiations > TYPE_CEILINGS.instantiationsPerAddedTable) {
      problems.push(
        `type-cost: ${String(step.fromTables)} to ${String(step.toTables)} tables added ${step.instantiations.toFixed(1)} instantiations per table, above ${String(TYPE_CEILINGS.instantiationsPerAddedTable)}`,
      );
    }
  }
  if (report.taggedOperatorSurcharge > TYPE_CEILINGS.taggedOperatorSurcharge) {
    problems.push(
      `type-cost: tagged operators added ${String(report.taggedOperatorSurcharge)} instantiations, above ${String(TYPE_CEILINGS.taggedOperatorSurcharge)}`,
    );
  }
  return problems;
}

function measureProject(
  root: string,
  label: string,
  tables: number,
  write: (dir: string) => void,
): TypeBudgetRow {
  const dir = join(root, label);
  write(dir);
  const ran = runProjectTsc(
    ["--noEmit", "--pretty", "false", "--extendedDiagnostics", "-p", dir],
    repoRoot(),
  );
  if (ran.exitCode !== 0) {
    throw new Error(`${label} failed to typecheck\n${ran.output}`);
  }
  const diagnostics = parseDiagnostics(ran.output, ran.exitCode);
  return {
    label,
    tables,
    instantiations: diagnostics.instantiations,
    types: diagnostics.types,
    checkTimeSeconds: diagnostics.checkTimeSeconds,
  };
}

function perTable(earlier: TypeBudgetRow, later: TypeBudgetRow): PerTableCost {
  const added = later.tables - earlier.tables;
  if (added <= 0) {
    throw new Error(`type-cost: ${later.label} does not add tables after ${earlier.label}`);
  }
  return {
    fromTables: earlier.tables,
    toTables: later.tables,
    instantiations: (later.instantiations - earlier.instantiations) / added,
  };
}

function rowNamed(rows: readonly TypeBudgetRow[], label: string): TypeBudgetRow {
  const row = rows.find((entry) => entry.label === label);
  if (row === undefined) {
    throw new Error(`type-cost: missing ${label}`);
  }
  return row;
}

function runTsc(args: readonly string[]): string {
  const proc = Bun.spawnSync(["bunx", "tsc", ...args], {
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  if (proc.exitCode !== 0 && !args.includes("--help")) {
    throw new Error(`tsc ${args.join(" ")} exited ${String(proc.exitCode)}\n${output}`);
  }
  return output;
}

function parseDiagnosticFields(output: string): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Za-z][^:]*):\s+(\S+)\s*$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    fields[match[1]] = parseDiagnosticValue(match[2]);
  }
  if (Object.keys(fields).length === 0) {
    throw new Error(`tsc --extendedDiagnostics printed no counters\n${output}`);
  }
  return fields;
}

function parseDiagnosticValue(raw: string): number {
  const trimmed = raw.endsWith("K") || raw.endsWith("s") ? raw.slice(0, -1) : raw;
  const value = Number(trimmed);
  if (Number.isNaN(value)) {
    throw new Error(`tsc diagnostic value is not a number: ${raw}`);
  }
  return value;
}

function requireField(fields: Readonly<Record<string, number>>, name: string): number {
  const value = fields[name];
  if (value === undefined) {
    throw new Error(`tsc --extendedDiagnostics did not report ${name}`);
  }
  return value;
}

function traceOptionsPresent(help: string): readonly string[] {
  return traceFlags.filter((flag) => help.includes(`--${flag}`));
}

/**
 * Measures the column-type sample.
 *
 * @returns Instantiations, types, and check time
 */
export function measureColumnTypes(): ColumnTypeCost {
  const output = runTsc([
    "--noEmit",
    "--pretty",
    "false",
    "--extendedDiagnostics",
    "-p",
    join(repoRoot(), columnProject),
  ]);
  const fields = parseDiagnosticFields(output);
  return {
    project: columnProject,
    instantiations: requireField(fields, "Instantiations"),
    types: requireField(fields, "Types"),
    checkTimeSeconds: requireField(fields, "Check time"),
  };
}

/**
 * Reports a column-type sample over its ceiling.
 *
 * @param measured - Output of {@link measureColumnTypes}
 * @returns Problem lines. Empty when the sample is inside the ceilings
 */
export function columnTypeProblems(measured: ColumnTypeCost): readonly string[] {
  const problems: string[] = [];
  if (measured.instantiations > TYPE_CEILINGS.columnInstantiations) {
    problems.push(
      `type-cost: column types used ${String(measured.instantiations)} instantiations, above ${String(TYPE_CEILINGS.columnInstantiations)}`,
    );
  }
  if (measured.types > TYPE_CEILINGS.columnTypes) {
    problems.push(
      `type-cost: column types used ${String(measured.types)} types, above ${String(TYPE_CEILINGS.columnTypes)}`,
    );
  }
  return problems;
}

if (import.meta.main) {
  try {
    const budgets = measureTypeBudgets();
    const columns = measureColumnTypes();
    const problems = [...ceilingProblems(budgets), ...columnTypeProblems(columns)];
    writeReport({ trivial: measureTypeCost(), budgets, columns });
    for (const problem of problems) {
      console.error(problem);
    }
    if (problems.length > 0) process.exit(1);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
