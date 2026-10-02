/**
 * Health and replay-position cache.
 *
 * A failed probe marks the endpoint unhealthy immediately. Consecutive
 * failures open a circuit and stretch the next probe. Replay LSNs only move
 * forward: a lower reading is ignored, so the cache stays a lower bound.
 */

import { compareLsn } from "@okmodel/harness";

/** One probe answer. */
export type ProbeSample = {
  /** `SELECT 1` reached the server. */
  readonly ok: boolean;
  /** Replay or insert LSN, when the position read worked. */
  readonly replayLsn?: string | null | undefined;
  /** Replica replay timestamp, epoch milliseconds. */
  readonly replayedAtMs?: number | null | undefined;
  /** Round-trip time of the probe. */
  readonly latencyMs: number;
  /** The position functions answered. False when the engine or the role cannot read them. */
  readonly positionCapable: boolean;
};

/** Cached health of one endpoint. */
export type ProbeState = {
  /** The last completed probe succeeded and the circuit is closed. */
  readonly healthy: boolean;
  /** Failures since the last success. */
  readonly consecutiveFailures: number;
  /** The circuit is open. The endpoint stays out until a later probe succeeds. */
  readonly circuitOpen: boolean;
  /** Highest replay or insert LSN observed. */
  readonly replayLsn: string | null;
  /** Replay timestamp from the probe that moved the LSN, or the latest success. */
  readonly replayedAtMs: number | null;
  /** Smoothed probe latency. */
  readonly latencyMs: number;
  /** Delay before the next probe after a failure. */
  readonly backoffMs: number;
  /** Earliest time a background probe should run. */
  readonly nextProbeAt: number;
  /** Position functions were usable on this endpoint. */
  readonly positionCapable: boolean;
};

/**
 * State before any probe.
 *
 * @param nowMs - Clock reading
 * @param probeMs - Configured interval, used as the first backoff
 * @returns An unknown, not-yet-healthy endpoint
 */
export function initialProbe(nowMs: number, probeMs: number): ProbeState {
  return {
    healthy: false,
    consecutiveFailures: 0,
    circuitOpen: false,
    replayLsn: null,
    replayedAtMs: null,
    latencyMs: 0,
    backoffMs: Math.max(probeMs, 1),
    nextProbeAt: nowMs,
    positionCapable: true,
  };
}

/**
 * Folds one probe into the cache.
 *
 * @param state - Previous cache
 * @param sample - What the probe saw
 * @param nowMs - Clock reading
 * @param failureThreshold - Consecutive failures that open the circuit
 * @returns The next cache
 */
export function applyProbe(
  state: ProbeState,
  sample: ProbeSample,
  nowMs: number,
  failureThreshold: number,
): ProbeState {
  if (!sample.ok) {
    const failures = state.consecutiveFailures + 1;
    const circuitOpen = failures >= failureThreshold;
    const backoffMs = circuitOpen ? Math.min(state.backoffMs * 2, 30_000) : state.backoffMs;
    return {
      ...state,
      healthy: false,
      consecutiveFailures: failures,
      circuitOpen,
      backoffMs,
      nextProbeAt: nowMs + backoffMs,
      positionCapable: state.positionCapable && sample.positionCapable,
    };
  }
  const latencyMs =
    state.latencyMs === 0 ? sample.latencyMs : state.latencyMs * 0.7 + sample.latencyMs * 0.3;
  return {
    healthy: true,
    consecutiveFailures: 0,
    circuitOpen: false,
    replayLsn: forwardLsn(state.replayLsn, sample.replayLsn ?? null),
    replayedAtMs: sample.replayedAtMs ?? state.replayedAtMs,
    latencyMs,
    backoffMs: state.backoffMs,
    nextProbeAt: nowMs,
    positionCapable: state.positionCapable && sample.positionCapable,
  };
}

/**
 * Keeps the higher LSN.
 *
 * @param cached - Previous lower bound
 * @param observed - New reading, or null when this probe had no position
 * @returns The higher of the two
 */
export function forwardLsn(cached: string | null, observed: string | null): string | null {
  if (observed === null || observed === "") return cached;
  if (cached === null) return observed;
  return compareLsn(observed, cached) > 0 ? observed : cached;
}
