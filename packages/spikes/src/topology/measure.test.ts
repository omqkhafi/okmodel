/**
 * Decision time, and pool acquire time on each live endpoint.
 */

import { expect, test } from "bun:test";

import { primaryUrl, replicaUrl } from "@okmodel/harness";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { connectTopology } from "./client.js";
import { summarizeUs, timeDecisions, type Timing } from "./measure.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

test("routing decision time", () => {
  const timing = timeDecisions(5_000);
  console.log(JSON.stringify({ event: "topology-decide", ...timing }));
  expect(timing.n).toBe(5_000);
  expect(timing.meanUs).toBeGreaterThan(0);
});

postgresTest(decision, "pool acquire time per endpoint", async () => {
  const client = await connectTopology({
    primary: primaryUrl(),
    replicas: [
      { url: replicaUrl("a"), name: "a" },
      { url: replicaUrl("b"), name: "b" },
    ],
    routing: { probe: "0ms" },
    timeouts: { acquire: 1000 },
  });
  try {
    const acquire: Record<string, Timing> = {};
    for (const name of ["primary", "a", "b"]) {
      for (let warm = 0; warm < 3; warm += 1) {
        const held = await client.acquire(name);
        held.release();
      }
      const samples: number[] = [];
      for (let sample = 0; sample < 20; sample += 1) {
        const started = performance.now();
        const held = await client.acquire(name);
        samples.push((performance.now() - started) * 1000);
        held.release();
      }
      acquire[name] = summarizeUs(samples);
    }
    console.log(JSON.stringify({ event: "topology-acquire", acquire }));
    expect(acquire.primary?.n).toBe(20);
    expect(acquire.a?.meanUs).toBeGreaterThan(0);
    expect(acquire.b?.meanUs).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});
