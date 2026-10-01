/**
 * Measures inferred and emitted row types with `tsc --extendedDiagnostics`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_SIZES, generateFixture } from "@okmodel/harness/fixtures";

import { compilerVersion, parseDiagnostics, runTsc } from "./diagnostics.js";
import {
  writeDuplicateProject,
  writeEmittedProject,
  writeEmptyProject,
  writeInferredProject,
} from "./projects.js";

/** One measured project. */
export type Measurement = {
  readonly label: string;
  readonly strategy: "baseline" | "inferred" | "emitted" | "recursion";
  readonly tables: number;
  readonly instantiations: number;
  readonly types: number;
  readonly checkTimeSeconds: number;
  readonly memoryUsedKb: number;
  readonly totalTimeSeconds: number;
  readonly exitCode: number;
};

/** Recursion probe for duplicate-name checking. */
export type RecursionProbe = {
  readonly count: number;
  readonly exitCode: number;
  readonly instantiations: number | null;
  readonly error: string | null;
};

/** Full types-spike measurement. */
export type MeasurementReport = {
  readonly compiler: string;
  readonly seed: 1;
  readonly rows: readonly Measurement[];
  readonly duplicateNames: readonly RecursionProbe[];
};

const repoRoot = join(import.meta.dir, "../../../..");

/**
 * Measures every fixture size for both row-type strategies.
 *
 * Projects are written under a temporary directory and deleted afterwards.
 *
 * @returns Counters from `tsc --extendedDiagnostics`
 */
export function measureTypes(): MeasurementReport {
  const root = join(tmpdir(), `okm-types-${String(Date.now())}`);
  mkdirSync(root, { recursive: true });
  try {
    const rows: Measurement[] = [];
    rows.push(measureProject(root, "empty", "baseline", 0, (dir) => writeEmptyProject(dir)));
    rows.push(
      measureProject(root, "empty-libcheck", "baseline", 0, (dir) => {
        writeEmptyProject(dir, { skipLibCheck: false });
      }),
    );
    for (const tables of FIXTURE_SIZES) {
      const fixture = generateFixture({ seed: 1, tables });
      rows.push(
        measureProject(root, `inferred-${String(tables)}`, "inferred", tables, (dir) => {
          writeInferredProject(dir, fixture);
        }),
      );
      rows.push(
        measureProject(root, `emitted-${String(tables)}`, "emitted", tables, (dir) => {
          writeEmittedProject(dir, fixture);
        }),
      );
    }
    const twoHundred = generateFixture({ seed: 1, tables: 200 });
    rows.push(
      measureProject(root, "inferred-200-extensions", "inferred", 200, (dir) => {
        writeInferredProject(dir, twoHundred, { extensions: true });
      }),
    );
    rows.push(
      measureProject(root, "inferred-200-unbranded", "inferred", 200, (dir) => {
        writeInferredProject(dir, twoHundred, { brandIds: false });
      }),
    );
    rows.push(
      measureProject(root, "emitted-200-unbranded", "emitted", 200, (dir) => {
        writeEmittedProject(dir, twoHundred, { brandIds: false });
      }),
    );
    rows.push(
      measureProject(root, "emitted-200-libcheck", "emitted", 200, (dir) => {
        writeEmittedProject(dir, twoHundred, { skipLibCheck: false });
      }),
    );
    rows.push(
      measureProject(root, "register-200", "inferred", 200, (dir) => {
        writeInferredProject(dir, twoHundred, { register: true });
      }),
    );
    const report: MeasurementReport = {
      compiler: compilerVersion(repoRoot),
      seed: 1,
      rows,
      duplicateNames: measureDuplicates(root),
    };
    rmSync(root, { recursive: true, force: true });
    return report;
  } catch (error) {
    console.error(`types project left at ${root}`);
    throw error;
  }
}

function measureProject(
  root: string,
  label: string,
  strategy: Measurement["strategy"],
  tables: number,
  write: (dir: string) => void,
): Measurement {
  const dir = join(root, label);
  write(dir);
  const ran = runTsc(
    ["--noEmit", "--pretty", "false", "--extendedDiagnostics", "-p", dir],
    repoRoot,
  );
  if (ran.exitCode !== 0) {
    throw new Error(`${label} failed to typecheck\n${ran.output}`);
  }
  const diagnostics = parseDiagnostics(ran.output, ran.exitCode);
  const row: Measurement = {
    label,
    strategy,
    tables,
    instantiations: diagnostics.instantiations,
    types: diagnostics.types,
    checkTimeSeconds: diagnostics.checkTimeSeconds,
    memoryUsedKb: diagnostics.memoryUsedKb,
    totalTimeSeconds: diagnostics.totalTimeSeconds,
    exitCode: diagnostics.exitCode,
  };
  return row;
}

function measureDuplicates(root: string): readonly RecursionProbe[] {
  const probes: RecursionProbe[] = [];
  for (const count of [40, 50, 80, 100, 200, 500]) {
    const dir = join(root, `dup-${String(count)}`);
    writeDuplicateProject(dir, count);
    const ran = runTsc(
      ["--noEmit", "--pretty", "false", "--extendedDiagnostics", "-p", dir],
      repoRoot,
    );
    if (ran.exitCode !== 0) {
      probes.push({
        count,
        exitCode: ran.exitCode,
        instantiations: null,
        error: firstError(ran.output),
      });
      break;
    }
    const diagnostics = parseDiagnostics(ran.output, ran.exitCode);
    probes.push({
      count,
      exitCode: 0,
      instantiations: diagnostics.instantiations,
      error: null,
    });
  }
  return probes;
}

function firstError(output: string): string {
  const line = output.split("\n").find((entry) => entry.includes("error TS"));
  return line ?? output.slice(0, 500);
}

if (import.meta.main) {
  const report = measureTypes();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(new URL("../../types/results.json", import.meta.url), json);
  process.stdout.write(json);
}
