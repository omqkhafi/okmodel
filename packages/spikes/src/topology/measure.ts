/**
 * Routing decision time.
 *
 * Pool acquire time is measured against the live topology in the test, because
 * it includes the adapter checkout.
 */

import { decideRoute } from "./route.js";
import {
  initialSelectState,
  type ReplicaView,
  type RoutingPolicy,
  type SelectState,
} from "./types.js";

/** A timing summary in microseconds. */
export type Timing = {
  /** Sample count. */
  readonly n: number;
  /** Arithmetic mean. */
  readonly meanUs: number;
  /** 99th percentile. */
  readonly p99Us: number;
};

/**
 * Summarises microsecond samples.
 *
 * @param samples - One duration per trial
 * @returns Mean and p99
 */
export function summarizeUs(samples: readonly number[]): Timing {
  if (samples.length === 0) return { n: 0, meanUs: 0, p99Us: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.99) - 1));
  return {
    n: samples.length,
    meanUs: round(total / samples.length),
    p99Us: round(sorted[index] ?? 0),
  };
}

/**
 * Times `decideRoute` on two healthy replicas.
 *
 * @param iterations - How many decisions to time
 * @returns Microseconds per decision
 */
export function timeDecisions(iterations: number): Timing {
  const policy: RoutingPolicy = {
    select: "weighted",
    consistency: "session",
    fallback: "primary",
    maxLag: null,
    probeMs: 0,
  };
  const replicas = [replica("a"), replica("b")];
  const samples: number[] = [];
  let state: SelectState = initialSelectState();
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const choice = decideRoute({
      kind: "read",
      constraint: { kind: "auto" },
      policy,
      replicas,
      watermark: null,
      positionUnknown: false,
      positionCapable: true,
      state,
      random: () => 0,
    });
    samples.push((performance.now() - started) * 1000);
    state = choice.state;
  }
  return summarizeUs(samples);
}

function replica(name: string): ReplicaView {
  return {
    name,
    weight: 1,
    healthy: true,
    circuitOpen: false,
    replayLsn: "0/10",
    lagBytes: 0n,
    lagMs: 0,
    inflight: 0,
    waiting: 0,
    idle: 4,
    saturated: false,
    latencyMs: 1,
    positionCapable: true,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
