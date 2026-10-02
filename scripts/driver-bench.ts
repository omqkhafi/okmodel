/**
 * Micro-benchmark of adapter `execute` against calling postgres.js directly.
 *
 * Same query, one connection, sequential calls. Prints the median of many
 * batches. No ceiling.
 */

import postgres from "postgres";

import { open } from "../src/adapters/pg/postgresjs.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const QUERY = "SELECT 1";
const WARMUP_BATCHES = 10;
const BATCHES = 40;
const CALLS_PER_BATCH = 50;

/**
 * Median of the batch times, divided by the calls in a batch.
 *
 * @param samples - Milliseconds for each batch
 * @returns Median milliseconds per call
 */
function medianPerCall(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const mid = ordered[Math.floor(ordered.length / 2)] ?? 0;
  return mid / CALLS_PER_BATCH;
}

async function timeDirect(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    for (let index = 0; index < WARMUP_BATCHES; index += 1) {
      for (let call = 0; call < CALLS_PER_BATCH; call += 1) {
        await sql.unsafe(QUERY).raw();
      }
    }
    const samples: number[] = [];
    for (let index = 0; index < BATCHES; index += 1) {
      const started = performance.now();
      for (let call = 0; call < CALLS_PER_BATCH; call += 1) {
        await sql.unsafe(QUERY).raw();
      }
      samples.push(performance.now() - started);
    }
    return medianPerCall(samples);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function timeAdapter(url: string): Promise<number> {
  const pool = open({ url, max: 1 });
  try {
    for (let index = 0; index < WARMUP_BATCHES; index += 1) {
      for (let call = 0; call < CALLS_PER_BATCH; call += 1) {
        await pool.execute(QUERY);
      }
    }
    const samples: number[] = [];
    for (let index = 0; index < BATCHES; index += 1) {
      const started = performance.now();
      for (let call = 0; call < CALLS_PER_BATCH; call += 1) {
        await pool.execute(QUERY);
      }
      samples.push(performance.now() - started);
    }
    return medianPerCall(samples);
  } finally {
    await pool.close();
  }
}

const url = primaryUrl();
const direct = await timeDirect(url);
const adapter = await timeAdapter(url);
const output = {
  query: QUERY,
  batches: BATCHES,
  callsPerBatch: CALLS_PER_BATCH,
  directMedianMs: Math.round(direct * 1000) / 1000,
  adapterMedianMs: Math.round(adapter * 1000) / 1000,
  overheadMs: Math.round((adapter - direct) * 1000) / 1000,
};
console.log(JSON.stringify(output));
