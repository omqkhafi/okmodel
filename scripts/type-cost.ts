/**
 * Measures type cost with TypeScript 7's own diagnostics and applies D127 ceilings.
 *
 * The gated numbers compile fixtures against the built `.d.ts` files with
 * `skipLibCheck`, which is what a consumer project pays. The same fixtures
 * compiled against library source are reported and are not gated. Check time
 * is reported and is not a ceiling.
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
  writeColumnProject,
  writeProductionEmittedProject,
  writeProductionInferredProject,
  writeQueryProject,
  writeValidateProject,
  type LibraryTarget,
} from "./type-projects.js";
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

/**
 * Type ceilings after D133.
 *
 * Table and column ceilings apply to declaration consumers. The tagged-operator
 * surcharge stays on the source measurement, because the declaration figure is 0.
 * Check time is reported and is not capped.
 */
export const TYPE_CEILINGS = {
  inferred200Instantiations: 17_300,
  inferred200Types: 6_500,
  inferred500Instantiations: 42_400,
  /** The 250-table probe (R4): measured 17,650 plus 20 percent. */
  inferred250Instantiations: 21_180,
  instantiationsPerAddedTable: 84,
  emittedConsumerTypes: 700,
  /** Query composite probe on 200 tables (D140). Separate from the inferred-schema baseline. */
  queryCompositeTypes: 7_100,
  /** The query probe with `okmodel/validate` imported (D176): measured 24,885 / 6,412 plus 3 percent, rounded down. */
  queryValidateInstantiations: 25_631,
  queryValidateTypes: 6_604,
  /** The query probe with `page`, `aggregate` and `manyThrough` in use (D176): measured 24,070 / 6,730 plus 3 percent, rounded down. */
  queryFeaturesInstantiations: 24_792,
  queryFeaturesTypes: 6_931,
  /** The query probe with a chain of two presets with arguments, then `find` (D176): measured 19,180 / 7,128 plus 3 percent, rounded down. */
  queryPresetsInstantiations: 19_755,
  queryPresetsTypes: 7_341,
  /** The query probe with a `tx` callback: a locked `find`, an `update`, and `afterCommit` (D176): measured 24,283 / 6,948 plus 3 percent, rounded down. */
  queryTxInstantiations: 25_011,
  queryTxTypes: 7_156,
  taggedOperatorSurcharge: 800,
  columnInstantiations: 720,
  columnTypes: 1_100,
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

/** Source-compiled fixtures. Reported, not gated. */
export type SourceTypeCost = {
  readonly rows: readonly TypeBudgetRow[];
  readonly perAddedTable: readonly PerTableCost[];
  readonly taggedOperatorSurcharge: number;
};

/** Fixture rows the ceilings read. */
export type TypeBudgetCore = {
  readonly rows: readonly TypeBudgetRow[];
  readonly perAddedTable: readonly PerTableCost[];
  readonly taggedOperatorSurcharge: number;
  readonly ceilings: typeof TYPE_CEILINGS;
};

/** Ceiling inputs written next to the trivial measurement. */
export type TypeBudgetReport = TypeBudgetCore & {
  /** The same fixtures compiled against library source. Not gated. */
  readonly source: SourceTypeCost;
  /** Column sample compiled against declarations. Gated. */
  readonly columns: ColumnTypeCost;
  /** Read queries on 10, 50, and 200 tables. Gated by the D133 inferred-200 ceilings. */
  readonly queries: readonly TypeBudgetRow[];
  /** `Input` and `insert.validate` on one table. Printed, not gated. */
  readonly validate: TypeBudgetRow;
  /** The 200-table query probe with `okmodel/validate` imported and enabled. Gated apart (D176). */
  readonly queryValidate: TypeBudgetRow;
  /**
   * The 200-table query probe plus one call each of `page`, then `aggregate`, then a
   * `manyThrough` include and filter, added in that order. The last row is gated apart
   * (D176); the others show what each feature costs.
   */
  readonly queryFeatures: readonly TypeBudgetRow[];
  /** The 200-table query probe plus a chain of two presets with arguments and a `find`. Gated apart (D176). */
  readonly queryPresets: TypeBudgetRow;
  /** The 200-table query probe plus a `tx` callback with a locked `find`, an `update`, and `afterCommit`. Gated apart (D176). */
  readonly queryTx: TypeBudgetRow;
  /** The 200-table query probe plus a `batch` of an insert, an update and a delete. Printed, not gated. */
  readonly queryBatch: TypeBudgetRow;
  /** The 200-table query probe plus one function and one trigger. Printed, not gated. */
  readonly queryRoutines: TypeBudgetRow;
};

/**
 * Writes the trivial measurement and the ceiling report as JSON.
 */
function writeReport(report: {
  readonly trivial: TypeCostReport;
  readonly budgets: TypeBudgetReport;
  readonly columns: ColumnTypeCost;
  readonly columnsSource: ColumnTypeCost;
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
    const declarations = emitLibraryDeclarations();
    const operators = emitOperatorDeclarations(join(root, "operators"));
    const columnDir = join(root, "columns");
    writeColumnProject(columnDir, declarations);
    const columns = measureProjectFile(columnDir, "columns-declarations");
    const rows = measureFixtureRows(join(root, "consumer"), { declarations }, operators);
    const queries = ([10, 50, 200] as const).map((tables) =>
      measureProject(join(root, "consumer"), `query-${String(tables)}`, tables, (dir) => {
        writeQueryProject(dir, generateFixture({ seed: 1, tables }), { declarations });
      }),
    );
    queries.push(
      measureProject(join(root, "consumer"), "query-200+extensions", 200, (dir) => {
        writeQueryProject(
          dir,
          generateFixture({ seed: 1, tables: 200 }),
          { declarations },
          {
            extensions: 12,
          },
        );
      }),
    );
    const sourceRows = measureFixtureRows(join(root, "source"));
    const source = budgetReport(sourceRows);
    const validate = measureProject(join(root, "consumer"), "validate-input", 1, (dir) => {
      writeValidateProject(dir, { declarations });
    });
    const queryValidate = measureProject(
      join(root, "consumer"),
      "query-200-validate",
      200,
      (dir) => {
        writeQueryProject(
          dir,
          generateFixture({ seed: 1, tables: 200 }),
          { declarations },
          {
            validate: true,
          },
        );
      },
    );
    const queryFeatures = (
      [["page"], ["page", "aggregate"], ["page", "aggregate", "through"]] as const
    ).map((features) =>
      measureProject(join(root, "consumer"), `query-200+${features.join("+")}`, 200, (dir) => {
        writeQueryProject(
          dir,
          generateFixture({ seed: 1, tables: 200 }),
          { declarations },
          { features },
        );
      }),
    );
    const [queryPresets, queryTx, queryBatch] = (["presets", "tx", "batch"] as const).map(
      (feature) =>
        measureProject(join(root, "consumer"), `query-200+${feature}`, 200, (dir) => {
          writeQueryProject(
            dir,
            generateFixture({ seed: 1, tables: 200 }),
            { declarations },
            { features: [feature] },
          );
        }),
    );
    if (queryPresets === undefined || queryTx === undefined || queryBatch === undefined)
      throw new Error("probe rows missing");
    const queryRoutines = measureProject(
      join(root, "consumer"),
      "query-200+routines",
      200,
      (dir) => {
        writeQueryProject(
          dir,
          generateFixture({ seed: 1, tables: 200 }),
          { declarations },
          { routines: true },
        );
      },
    );
    return {
      ...budgetReport(rows),
      source: {
        rows: source.rows,
        perAddedTable: source.perAddedTable,
        taggedOperatorSurcharge: source.taggedOperatorSurcharge,
      },
      columns,
      queries,
      validate,
      queryValidate,
      queryFeatures,
      queryPresets,
      queryTx,
      queryBatch,
      queryRoutines,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function measureFixtureRows(
  root: string,
  target?: LibraryTarget,
  operators?: string,
): TypeBudgetRow[] {
  const rows: TypeBudgetRow[] = [];
  for (const tables of [50, 200, 500] as const) {
    const fixture = generateFixture({ seed: 1, tables });
    rows.push(
      measureProject(root, `inferred-${String(tables)}`, tables, (dir) => {
        writeProductionInferredProject(dir, fixture, target);
      }),
    );
  }
  // R4: the 250-table probe. Table generation is prefix-stable (each table
  // only references earlier tables), so the first 250 tables of the seed-1
  // 500-table fixture are exactly what a 250-table fixture would be.
  const twoFifty = generateFixture({ seed: 1, tables: 500 });
  rows.push(
    measureProject(root, "inferred-250", 250, (dir) => {
      writeProductionInferredProject(
        dir,
        { ...twoFifty, tableCount: 250, tables: twoFifty.tables.slice(0, 250) },
        target,
      );
    }),
  );
  const twoHundred = generateFixture({ seed: 1, tables: 200 });
  rows.push(
    measureProject(root, "emitted-200", 200, (dir) => {
      writeProductionEmittedProject(dir, twoHundred);
    }),
  );
  rows.push(
    measureProject(root, "equality-200", 200, (dir) => {
      writeOperatorProject(dir, twoHundred, "equality", operators);
    }),
  );
  rows.push(
    measureProject(root, "tagged-200", 200, (dir) => {
      writeOperatorProject(dir, twoHundred, "tagged", operators);
    }),
  );
  return rows;
}

/**
 * Builds the ceiling report from measured rows.
 *
 * @param rows - Inferred, emitted, and operator projects
 * @returns The report `ceilingProblems` checks
 */
export function budgetReport(rows: readonly TypeBudgetRow[]): TypeBudgetCore {
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
 * Reports rows that exceed a D133 ceiling.
 *
 * @param report - Consumer rows from {@link measureTypeBudgets}
 * @param taggedSurcharge - Source-based tagged-operator surcharge. Defaults to the figure on `report`
 * @returns Problem lines. Empty when every ceiling holds
 */
export function ceilingProblems(
  report: TypeBudgetCore & {
    readonly queries?: readonly TypeBudgetRow[];
    readonly queryValidate?: TypeBudgetRow;
    readonly queryFeatures?: readonly TypeBudgetRow[];
    readonly queryPresets?: TypeBudgetRow;
    readonly queryTx?: TypeBudgetRow;
  },
  taggedSurcharge: number = report.taggedOperatorSurcharge,
): readonly string[] {
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
  const inferred250 = rowNamed(report.rows, "inferred-250");
  if (inferred250.instantiations > TYPE_CEILINGS.inferred250Instantiations) {
    problems.push(
      `type-cost: inferred 250 tables used ${String(inferred250.instantiations)} instantiations, above ${String(TYPE_CEILINGS.inferred250Instantiations)}`,
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
  const query200 = report.queries?.find((entry) => entry.label === "query-200");
  const queryExtensions = report.queries?.find((entry) => entry.label === "query-200+extensions");
  for (const row of [query200, queryExtensions]) {
    if (row === undefined) continue;
    if (row.instantiations > TYPE_CEILINGS.inferred200Instantiations) {
      problems.push(
        `type-cost: ${row.label} used ${String(row.instantiations)} instantiations, above ${String(TYPE_CEILINGS.inferred200Instantiations)}`,
      );
    }
    if (row.types > TYPE_CEILINGS.queryCompositeTypes) {
      problems.push(
        `type-cost: ${row.label} used ${String(row.types)} types, above ${String(TYPE_CEILINGS.queryCompositeTypes)}`,
      );
    }
  }
  const features = report.queryFeatures?.at(-1);
  const probes = [
    [
      report.queryValidate,
      TYPE_CEILINGS.queryValidateInstantiations,
      TYPE_CEILINGS.queryValidateTypes,
    ],
    [features, TYPE_CEILINGS.queryFeaturesInstantiations, TYPE_CEILINGS.queryFeaturesTypes],
    [
      report.queryPresets,
      TYPE_CEILINGS.queryPresetsInstantiations,
      TYPE_CEILINGS.queryPresetsTypes,
    ],
    [report.queryTx, TYPE_CEILINGS.queryTxInstantiations, TYPE_CEILINGS.queryTxTypes],
  ] as const;
  for (const [row, instantiations, types] of probes) {
    if (row !== undefined && row.instantiations > instantiations) {
      problems.push(
        `type-cost: ${row.label} used ${String(row.instantiations)} instantiations, above ${String(instantiations)}`,
      );
    }
    if (row !== undefined && row.types > types) {
      problems.push(
        `type-cost: ${row.label} used ${String(row.types)} types, above ${String(types)}`,
      );
    }
  }
  if (taggedSurcharge > TYPE_CEILINGS.taggedOperatorSurcharge) {
    problems.push(
      `type-cost: tagged operators added ${String(taggedSurcharge)} instantiations, above ${String(TYPE_CEILINGS.taggedOperatorSurcharge)}`,
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

/**
 * Emits library declarations the consumer fixtures import.
 *
 * Uses the package build config so the `.d.ts` layout matches `okmodel` and
 * `okmodel/pg`. `bun run build` replaces `dist/` afterwards.
 *
 * @returns The `dist/` declaration root
 */
function emitLibraryDeclarations(): string {
  const ran = runProjectTsc(["-p", join(repoRoot(), "tsconfig.build.json")], repoRoot());
  if (ran.exitCode !== 0) {
    throw new Error(`declaration emit failed\n${ran.output}`);
  }
  return join(repoRoot(), "dist");
}

/**
 * Emits the spike operator types as declarations.
 *
 * Tagged operators are not in the package yet. The consumer probe still reads
 * declarations, not the spike function bodies.
 *
 * @param dir - Output directory
 * @returns Directory of the emitted `.d.ts` files
 */
function emitOperatorDeclarations(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const outDir = join(dir, "out");
  const safety = join(repoRoot(), "packages/spikes/src/safety");
  const config = join(dir, "tsconfig.json");
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          declaration: true,
          emitDeclarationOnly: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2023",
          skipLibCheck: true,
          rootDir: safety,
          outDir,
        },
        files: [
          join(safety, "errors.ts"),
          join(safety, "eq-where.ts"),
          join(safety, "operators.ts"),
        ],
      },
      null,
      2,
    )}\n`,
  );
  const ran = runProjectTsc(["-p", config], repoRoot());
  if (ran.exitCode !== 0) {
    throw new Error(`operator declaration emit failed\n${ran.output}`);
  }
  return outDir;
}

if (import.meta.main) {
  try {
    const budgets = measureTypeBudgets();
    const columnsSource = measureColumnTypes();
    const problems = [
      ...ceilingProblems(budgets, budgets.source.taggedOperatorSurcharge),
      ...columnTypeProblems(budgets.columns),
    ];
    writeReport({
      trivial: measureTypeCost(),
      budgets,
      columns: budgets.columns,
      columnsSource,
    });
    for (const problem of problems) {
      console.error(problem);
    }
    if (problems.length > 0) process.exit(1);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function measureProjectFile(dir: string, project: string): ColumnTypeCost {
  const ran = runProjectTsc(
    ["--noEmit", "--pretty", "false", "--extendedDiagnostics", "-p", dir],
    repoRoot(),
  );
  if (ran.exitCode !== 0) {
    throw new Error(`${project} failed to typecheck\n${ran.output}`);
  }
  const diagnostics = parseDiagnostics(ran.output, ran.exitCode);
  return {
    project,
    instantiations: diagnostics.instantiations,
    types: diagnostics.types,
    checkTimeSeconds: diagnostics.checkTimeSeconds,
  };
}
