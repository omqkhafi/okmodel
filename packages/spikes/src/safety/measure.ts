/**
 * Type cost of tagged operators, and runtime cost of operators, identifier
 * checks, and the verifier.
 *
 * Type cost uses `tsc --extendedDiagnostics` on the harness fixture, the same
 * way the types spike does. Instantiations and types are the locked numbers.
 * Runtime samples are microseconds, mean and p99, and are not locked.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateFixture } from "@okmodel/harness/fixtures";

import { compilerVersion, parseDiagnostics, runTsc } from "../types/diagnostics.js";
import { compose } from "./compose.js";
import { assertKnownField, quoteIdentifier } from "./identifier.js";
import { lt } from "./operators.js";
import {
  writeInferredOperatorProject,
  writeOperatorBaseline,
  writeOperatorProject,
} from "./projects.js";
import { sizedQuery } from "./sample.js";
import { verify } from "./verify.js";

/** One `tsc` project. */
export type TypeCostRow = {
  readonly label: string;
  readonly strategy: "baseline" | "equality" | "tagged" | "inferred-equality" | "inferred-tagged";
  readonly tables: number;
  readonly instantiations: number;
  readonly types: number;
  readonly checkTimeSeconds: number;
  readonly memoryUsedKb: number;
  readonly exitCode: number;
};

/** One runtime sample, in microseconds. */
export type RuntimeSample = {
  readonly label: string;
  readonly meanUs: number;
  readonly p99Us: number;
};

/** Type cost plus runtime samples. */
export type SafetyMeasurement = {
  readonly compiler: string;
  readonly seed: 1;
  readonly rows: readonly TypeCostRow[];
  readonly runtime: readonly RuntimeSample[];
};

const repoRoot = join(import.meta.dir, "../../../..");

/**
 * Measures operator type cost on the fixture and the runtime samples.
 *
 * Type projects are written under a temporary directory and deleted afterwards.
 *
 * @returns Counters and timings
 */
export function measureSafety(): SafetyMeasurement {
  const root = join(tmpdir(), `okm-safety-${String(Date.now())}`);
  mkdirSync(root, { recursive: true });
  try {
    const rows: TypeCostRow[] = [];
    rows.push(measureProject(root, "empty", "baseline", 0, (dir) => writeOperatorBaseline(dir)));
    for (const tables of [10, 50, 200] as const) {
      const fixture = generateFixture({ seed: 1, tables });
      rows.push(
        measureProject(root, `tagged-${String(tables)}`, "tagged", tables, (dir) => {
          writeOperatorProject(dir, fixture, "tagged");
        }),
      );
    }
    const twoHundred = generateFixture({ seed: 1, tables: 200 });
    rows.push(
      measureProject(root, "equality-200", "equality", 200, (dir) => {
        writeOperatorProject(dir, twoHundred, "equality");
      }),
    );
    rows.push(
      measureProject(root, "inferred-equality-200", "inferred-equality", 200, (dir) => {
        writeInferredOperatorProject(dir, twoHundred, "equality");
      }),
    );
    rows.push(
      measureProject(root, "inferred-tagged-200", "inferred-tagged", 200, (dir) => {
        writeInferredOperatorProject(dir, twoHundred, "tagged");
      }),
    );
    const report: SafetyMeasurement = {
      compiler: compilerVersion(repoRoot),
      seed: 1,
      rows,
      runtime: measureRuntime(),
    };
    rmSync(root, { recursive: true, force: true });
    return report;
  } catch (error) {
    console.error(`safety project left at ${root}`);
    throw error;
  }
}

/**
 * Runtime samples for operator construction, identifier checks, and verification.
 *
 * @returns Mean and p99 in microseconds
 */
export function measureRuntime(): readonly RuntimeSample[] {
  const samples: RuntimeSample[] = [];
  let sink = 0;
  samples.push(
    bench("tagged-operator", () => {
      sink += lt(1).value;
    }),
  );
  samples.push(
    bench("plain-value", () => {
      sink += { value: 1 }.value;
    }),
  );
  const operators = 8;
  samples.push(
    bench("tagged-query-8", () => {
      const built = Array.from({ length: operators }, (_value, index) => lt(index));
      sink += built.length;
    }),
  );
  samples.push(
    bench("plain-query-8", () => {
      const built = Array.from({ length: operators }, (_value, index) => index);
      sink += built.length;
    }),
  );
  samples.push(
    bench("quote-identifier", () => {
      sink += quoteIdentifier("tasks").length;
    }),
  );
  samples.push(
    bench("quote-identifier-63", () => {
      sink += quoteIdentifier("a".repeat(63)).length;
    }),
  );
  samples.push(
    bench("quote-identifier-unicode", () => {
      sink += quoteIdentifier("タスク").length;
    }),
  );
  const fields = ["id", "title", "tenantId"];
  samples.push(
    bench("known-field", () => {
      assertKnownField(fields, "title", "where");
      sink += 1;
    }),
  );
  for (const predicates of [1, 8, 32, 128]) {
    const sized = sizedQuery(1, predicates);
    samples.push(
      bench(
        `verify-predicates-${String(predicates)}`,
        () => {
          const query = compose(sized.draft, sized.catalog);
          const verified = verify(query, sized.catalog);
          sink += verified.contributions.length;
        },
        { batch: 20, samples: 100 },
      ),
    );
  }
  for (const tables of [1, 10, 40]) {
    const sized = sizedQuery(tables, 1);
    samples.push(
      bench(
        `verify-tables-${String(tables)}`,
        () => {
          const query = compose(sized.draft, sized.catalog);
          const verified = verify(query, sized.catalog);
          sink += verified.tables.length;
        },
        { batch: 20, samples: 100 },
      ),
    );
  }
  if (sink < 0) {
    throw new Error("benchmark sink underflow");
  }
  return samples;
}

function measureProject(
  root: string,
  label: string,
  strategy: TypeCostRow["strategy"],
  tables: number,
  write: (dir: string) => void,
): TypeCostRow {
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
  return {
    label,
    strategy,
    tables,
    instantiations: diagnostics.instantiations,
    types: diagnostics.types,
    checkTimeSeconds: diagnostics.checkTimeSeconds,
    memoryUsedKb: diagnostics.memoryUsedKb,
    exitCode: diagnostics.exitCode,
  };
}

/**
 * Times `run` and returns microseconds per call.
 *
 * Each sample times a batch so a sub-microsecond call is still visible.
 * Ten warmup batches are discarded.
 *
 * @param label - Sample name
 * @param run - Work to time
 * @returns Mean and p99
 */
export function bench(
  label: string,
  run: () => void,
  options?: { readonly batch?: number; readonly samples?: number },
): RuntimeSample {
  const batch = options?.batch ?? 400;
  const samples = options?.samples ?? 200;
  for (let warmup = 0; warmup < 10; warmup += 1) {
    for (let index = 0; index < batch; index += 1) {
      run();
    }
  }
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    for (let index = 0; index < batch; index += 1) {
      run();
    }
    values.push(((performance.now() - started) * 1000) / batch);
  }
  values.sort((left, right) => left - right);
  const meanUs = values.reduce((sum, value) => sum + value, 0) / values.length;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(0.99 * values.length) - 1));
  return { label, meanUs, p99Us: values[index] ?? meanUs };
}

if (import.meta.main) {
  const report = measureSafety();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const target = new URL("../../safety/results.json", import.meta.url);
  mkdirSync(new URL(".", target), { recursive: true });
  writeFileSync(target, json);
  process.stdout.write(json);
}
