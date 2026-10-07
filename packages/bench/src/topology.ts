/**
 * Watermark cost and fallback rate on the CI topology.
 *
 * One primary and two hot standbys. At least 200 timed writes in each
 * consistency mode, then 200 writes while reads continue to 2,000.
 * Prints JSON. Nothing fails the build on the numbers.
 *
 *   OKM_PRIMARY_PORT=… bun ./packages/bench/src/topology.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compareLsn, isolatedSchemaName, primaryUrl, replicaUrl } from "../../harness/src/index.js";
import { openPostgres } from "../../harness/src/postgres.js";
import { schema, table, t } from "../../../src/dialects/pg/index.js";
import { connect } from "../../../src/runtime/pg/postgresjs.js";
import type { RouteEvent } from "../../../src/runtime/topology.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const WARMUP = 10;
const TIMED_WRITES = 200;
const LOAD_WRITES = 200;
const MIN_READS = 2_000;

const report = {
  primary: primaryUrl(),
  writes: { warmup: WARMUP, timed: TIMED_WRITES, load: LOAD_WRITES },
  minReads: MIN_READS,
  session: { p50: 0, p95: 0 },
  eventual: { p50: 0, p95: 0 },
  extra: { p50: 0, p95: 0 },
  fallback: {
    reads: 0,
    fallbacks: 0,
    replicaReads: 0,
    rate: 0,
    writes: LOAD_WRITES,
    reasons: {} as Record<string, number>,
  },
};

async function main(): Promise<void> {
  const started = performance.now();
  const admin = openPostgres();
  const schemaName = isolatedSchemaName();
  try {
    await admin.unsafe(`create schema ${schemaName}`);
    await admin.unsafe(
      `create table ${schemaName}.notes (id text primary key, title text not null)`,
    );
    const lsn = await insertLsn(admin);
    await waitForReplay("a", lsn);
    await waitForReplay("b", lsn);

    const session = await openClient(schemaName, "session");
    const eventual = await openClient(schemaName, "eventual");
    try {
      await timeInserts(session, "warm-s", WARMUP);
      await timeInserts(eventual, "warm-e", WARMUP);
      const sessionMs = await timeInserts(session, "s", TIMED_WRITES);
      const eventualMs = await timeInserts(eventual, "e", TIMED_WRITES);
      report.session = percentiles(sessionMs);
      report.eventual = percentiles(eventualMs);
      report.extra = {
        p50: round(report.session.p50 - report.eventual.p50),
        p95: round(report.session.p95 - report.eventual.p95),
      };
    } finally {
      await session.close();
      await eventual.close();
    }

    const events: RouteEvent[] = [];
    const measured = await openClient(schemaName, "session", (event) => {
      events.push(event);
    });
    let stop = false;
    const readers = [0, 1].map(async () => {
      while (!stop) await measured.notes.find({ limit: 1 });
    });
    try {
      for (let index = 0; index < LOAD_WRITES; index += 1) {
        await measured.notes.insert({ id: `load${String(index)}`, title: "load" });
      }
      while (countReads(events) < MIN_READS) {
        await measured.notes.find({ limit: 1 });
      }
      stop = true;
      await Promise.all(readers);
      const reads = countReads(events);
      const reasons: Record<string, number> = {};
      for (const event of events) {
        if (event.op !== "read") continue;
        reasons[event.reason] = (reasons[event.reason] ?? 0) + 1;
      }
      const fallbacks = events.filter(
        (event) => event.op === "read" && event.reason.startsWith("fallback:"),
      ).length;
      const replicaReads = events.filter(
        (event) => event.op === "read" && event.reason.startsWith("auto:"),
      ).length;
      report.fallback = {
        reads,
        fallbacks,
        replicaReads,
        rate: reads === 0 ? 0 : round(fallbacks / reads, 4),
        writes: LOAD_WRITES,
        reasons,
      };
    } finally {
      stop = true;
      await Promise.all(readers).catch(() => undefined);
      await measured.close();
    }
  } finally {
    await admin.unsafe(`drop schema if exists ${schemaName} cascade`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }

  const output = { ...report, elapsedMs: Math.round(performance.now() - started) };
  const results = join(import.meta.dir, "..", "results");
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "topology.json"), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output));
}

async function openClient(
  schemaName: string,
  consistency: "session" | "eventual",
  onRoute?: (event: RouteEvent) => void,
) {
  return connect(
    {
      primary: primaryUrl(),
      replicas: [
        { url: replicaUrl("a"), name: "a", weight: 1 },
        { url: replicaUrl("b"), name: "b", weight: 1 },
      ],
    },
    {
      schema: app,
      searchPath: schemaName,
      max: 4,
      routing: { consistency, probe: 250 },
      onRoute(event) {
        onRoute?.(event);
      },
    },
  );
}

async function timeInserts(
  db: Awaited<ReturnType<typeof openClient>>,
  prefix: string,
  count: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await db.notes.insert({ id: `${prefix}${String(index)}`, title: "t" });
    samples.push(performance.now() - started);
  }
  return samples;
}

async function insertLsn(admin: ReturnType<typeof openPostgres>): Promise<string> {
  const rows = await admin<{ lsn: string }[]>`select pg_current_wal_insert_lsn()::text as lsn`;
  const lsn = rows[0]?.lsn;
  if (lsn === undefined) throw new Error("primary did not return an insert LSN");
  return lsn;
}

async function waitForReplay(name: "a" | "b", target: string): Promise<void> {
  const sql = openPostgres(replicaUrl(name));
  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      const rows = await sql<{ lsn: string | null }[]>`
        select pg_last_wal_replay_lsn()::text as lsn
      `;
      const lsn = rows[0]?.lsn;
      if (lsn !== null && lsn !== undefined && compareLsn(lsn, target) >= 0) return;
      if (Date.now() > deadline) throw new Error(`replica ${name} did not reach ${target}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function countReads(events: readonly RouteEvent[]): number {
  let reads = 0;
  for (const event of events) if (event.op === "read") reads += 1;
  return reads;
}

function percentiles(samples: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(samples, 50)), p95: round(percentile(samples, 95)) };
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
