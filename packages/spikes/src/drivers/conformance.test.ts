/**
 * Runs the driver conformance suite and writes the compatibility table.
 */

import { afterAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { openPglite as openRawPglite, primaryUrl } from "@okmodel/harness";
import postgres from "postgres";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { openPglite } from "./pglite.js";
import { openBatchMode, openPostgresJs, terminateBackend } from "./postgresjs.js";
import { CASES, CASE_IDS, skipReason, type CaseContext, type Observation } from "./suite.js";
import { mergeResults, readResults, writeResults, type StatusRecord } from "./table.js";
import type { DriverPool } from "./types.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const pglite = await openPglite();
const postgresJs = decision.run ? openPostgresJs(primaryUrl()) : null;
const batchMode = decision.run ? openBatchMode(primaryUrl()) : null;

const records: StatusRecord[] = [];
const observations: Observation[] = [];
const versions: Record<string, string> = {};

const SLOW = new Set([
  "execute.cancel",
  "timeout.declaration",
  "batch.atomic.cancel",
  "batch.atomic.timeout",
  "batch.atomic.outcome",
]);

bind("pglite", pglite, null);
if (postgresJs !== null) {
  bind("postgresjs", postgresJs, (marker) => terminateBackend(primaryUrl(), marker));
}
if (batchMode !== null) {
  bind("batch-mode", batchMode, (marker) => terminateBackend(primaryUrl(), marker));
}
if (!decision.run) {
  for (const item of CASES) {
    const timeout = SLOW.has(item.id) ? 20_000 : 15_000;
    postgresTest(decision, `postgresjs ${item.id}`, async () => undefined, timeout);
    postgresTest(decision, `batch-mode ${item.id}`, async () => undefined, timeout);
  }
}

test("pglite overhead and batch statements", async () => {
  const raw = await openRawPglite();
  try {
    const direct = await time(() => raw.query("SELECT 1"), 30);
    const wrapped = await time(() => pglite.execute("SELECT 1"), 30);
    const batch = await timeBatch(pglite);
    observations.push(
      { driver: "pglite", name: "directMeanUs", value: String(direct.meanUs) },
      { driver: "pglite", name: "adapterMeanUs", value: String(wrapped.meanUs) },
      { driver: "pglite", name: "adapterP99Us", value: String(wrapped.p99Us) },
      { driver: "pglite", name: "batch8MeanMs", value: String(batch.meanMs) },
      { driver: "pglite", name: "batch8Statements", value: String(batch.statements) },
      { driver: "pglite", name: "sequential8MeanMs", value: String(batch.sequentialMs) },
    );
    expect(direct.meanUs).toBeGreaterThan(0);
    expect(wrapped.meanUs).toBeGreaterThan(0);
  } finally {
    await raw.close();
  }
});

postgresTest(decision, "postgresjs overhead and batch statements", async () => {
  if (postgresJs === null || batchMode === null) throw new Error("postgres pool was not opened");
  const raw = postgres(primaryUrl(), { max: 1, prepare: true, onnotice: () => undefined });
  try {
    const direct = await time(async () => {
      await raw.unsafe("SELECT 1");
    }, 30);
    const wrapped = await time(() => postgresJs.execute("SELECT 1"), 30);
    const interactive = await timeBatch(postgresJs);
    const batched = await timeBatch(batchMode);
    const pipelined = await timePipeline(raw);
    observations.push(
      { driver: "postgresjs", name: "directMeanUs", value: String(direct.meanUs) },
      { driver: "postgresjs", name: "directP99Us", value: String(direct.p99Us) },
      { driver: "postgresjs", name: "adapterMeanUs", value: String(wrapped.meanUs) },
      { driver: "postgresjs", name: "adapterP99Us", value: String(wrapped.p99Us) },
      { driver: "postgresjs", name: "batch8MeanMs", value: String(interactive.meanMs) },
      { driver: "postgresjs", name: "batch8Statements", value: String(interactive.statements) },
      { driver: "postgresjs", name: "sequential8MeanMs", value: String(interactive.sequentialMs) },
      { driver: "batch-mode", name: "batch8MeanMs", value: String(batched.meanMs) },
      { driver: "batch-mode", name: "batch8Statements", value: String(batched.statements) },
      { driver: "batch-mode", name: "sequential8MeanMs", value: String(batched.sequentialMs) },
      { driver: "postgresjs", name: "pipeline8MeanMs", value: String(pipelined) },
    );
    expect(wrapped.meanUs).toBeGreaterThan(0);
  } finally {
    await raw.end({ timeout: 2 });
  }
});

afterAll(async () => {
  for (const observation of observations) {
    console.log(JSON.stringify({ event: "drivers", ...observation }));
  }
  const directory = fileURLToPath(new URL("../../drivers/", import.meta.url));
  const merged = mergeResults(
    readResults(`${directory}/results.json`),
    records,
    versions,
    CASE_IDS,
  );
  writeResults(directory, merged);
  await pglite.close();
  await postgresJs?.close();
  await batchMode?.close();
}, 20_000);

function bind(
  driver: string,
  pool: DriverPool,
  terminate: ((marker: string) => Promise<number>) | null,
): void {
  for (const item of CASES) {
    const timeout = SLOW.has(item.id) ? 20_000 : 15_000;
    test(
      `${driver} ${item.id}`,
      async () => {
        if (versions[driver] === undefined) {
          versions[driver] = await pool.serverVersion();
        }
        const reason = skipReason(pool, item.id, terminate !== null);
        if (reason !== undefined) {
          records.push({ driver, testId: item.id, status: "skip", reason });
          return;
        }
        const ctx: CaseContext = {
          driver,
          pool,
          terminate,
          note(name, value) {
            observations.push({ driver, name, value: String(value) });
          },
        };
        try {
          await item.run(ctx);
          records.push({ driver, testId: item.id, status: "pass" });
        } catch (error) {
          records.push({
            driver,
            testId: item.id,
            status: "fail",
            reason: error instanceof Error ? error.message : "failed",
          });
          throw error;
        }
      },
      { timeout },
    );
  }
}

async function time(
  fn: () => Promise<unknown>,
  samples: number,
): Promise<{ meanUs: number; p99Us: number }> {
  for (let index = 0; index < 5; index++) await fn();
  const durations: number[] = [];
  for (let index = 0; index < samples; index++) {
    const started = Bun.nanoseconds();
    await fn();
    durations.push(Number(Bun.nanoseconds() - started));
  }
  durations.sort((left, right) => left - right);
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const index = Math.min(durations.length - 1, Math.ceil(durations.length * 0.99) - 1);
  return { meanUs: Math.round(mean / 1000), p99Us: Math.round((durations[index] ?? 0) / 1000) };
}

async function timePipeline(raw: ReturnType<typeof postgres>): Promise<number> {
  const once = async (): Promise<void> => {
    const queries = Array.from({ length: 8 }, () => raw.unsafe("SELECT 1"));
    await Promise.all(queries);
  };
  for (let index = 0; index < 2; index++) await once();
  const runs = 5;
  const started = performance.now();
  for (let index = 0; index < runs; index++) await once();
  return Math.round((performance.now() - started) / runs);
}

async function timeBatch(
  pool: DriverPool,
): Promise<{ meanMs: number; statements: number; sequentialMs: number }> {
  const statements = Array.from({ length: 8 }, () => ({ text: "SELECT 1" }));
  for (let index = 0; index < 2; index++) await pool.batch(statements);
  pool.takeStatements();
  const runs = 5;
  const batchStarted = performance.now();
  for (let index = 0; index < runs; index++) await pool.batch(statements);
  const meanMs = Math.round((performance.now() - batchStarted) / runs);
  const sent = pool.takeStatements() / runs;
  const sequentialStarted = performance.now();
  for (let index = 0; index < runs; index++) {
    for (let row = 0; row < 8; row++) await pool.execute("SELECT 1");
  }
  return {
    meanMs,
    statements: Math.round(sent),
    sequentialMs: Math.round((performance.now() - sequentialStarted) / runs),
  };
}
