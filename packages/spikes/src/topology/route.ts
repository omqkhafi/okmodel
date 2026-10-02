/**
 * Routing decision.
 *
 * Eligibility and choice stay separate: health, then consistency and lag,
 * then capacity, then the selection strategy. The primary is never a candidate
 * in that list.
 */

import { compareLsn } from "@okmodel/harness";

import { fallbackError, noEligibleReplica, primaryRequiredReplica } from "./error.js";
import { withinLag } from "./lag.js";
import { selectReplica } from "./select.js";
import {
  requiresPrimary,
  type Decision,
  type FallbackWhy,
  type OperationKind,
  type ReplicaView,
  type RouteConstraint,
  type RoutingPolicy,
  type SelectState,
} from "./types.js";

/** Inputs for one decision. The function does not read a pool or a socket. */
export type RouteInput = {
  /** Operation classification. */
  readonly kind: OperationKind;
  /** Per-call constraint. Automatic when omitted by the caller. */
  readonly constraint: RouteConstraint;
  /** Connect-time policy. */
  readonly policy: RoutingPolicy;
  /** Replica views. The primary is not in this list. */
  readonly replicas: readonly ReplicaView[];
  /** Session commit position. Null when this session has not committed a write. */
  readonly watermark: string | null;
  /** The position read after commit failed. Reads stay on the primary. */
  readonly positionUnknown: boolean;
  /** The primary can read a WAL insert position. */
  readonly positionCapable: boolean;
  /** Strategy cursors. */
  readonly state: SelectState;
  /** Source for the random strategy. */
  readonly random: () => number;
};

/** The chosen endpoint and the cursors to store. */
export type RouteChoice = {
  /** Where the operation runs. */
  readonly decision: Decision;
  /** Cursors after selection. Unchanged when the primary is chosen. */
  readonly state: SelectState;
};

/**
 * Chooses the endpoint for one operation.
 *
 * Throws OKM1840, OKM1843, or OKM1844. It does not open a connection.
 *
 * @param input - Policy, views, and the session watermark
 * @returns The decision and the next strategy cursors
 */
export function decideRoute(input: RouteInput): RouteChoice {
  if (requiresPrimary(input.kind)) {
    if (input.constraint.kind === "replica") throw primaryRequiredReplica();
    return primary("primary-required", input.state);
  }
  if (input.constraint.kind === "primary") return primary("constraint:primary", input.state);

  const strict = input.constraint.kind === "replica";
  const consistency =
    input.constraint.kind === "replica"
      ? (input.constraint.consistency ?? input.policy.consistency)
      : input.policy.consistency;

  if (input.replicas.length === 0) return miss(input, "no-replicas", strict);

  const needsPosition =
    consistency === "session" && (input.watermark !== null || input.positionUnknown);
  if (needsPosition && (input.positionUnknown || !input.positionCapable)) {
    return miss(input, "position-unknown", strict);
  }

  const healthy = input.replicas.filter((replica) => replica.healthy && !replica.circuitOpen);
  if (healthy.length === 0) return miss(input, "unhealthy", strict);

  let caughtUp = healthy;
  if (consistency === "session" && input.watermark !== null) {
    const watermark = input.watermark;
    const capable = healthy.filter((replica) => replica.positionCapable);
    if (capable.length === 0) return miss(input, "position-unknown", strict);
    caughtUp = capable.filter(
      (replica) => replica.replayLsn !== null && compareLsn(replica.replayLsn, watermark) >= 0,
    );
  }
  if (caughtUp.length === 0) return miss(input, "behind", strict);

  const within =
    input.policy.maxLag === null
      ? caughtUp
      : caughtUp.filter((replica) =>
          withinLag(
            { bytes: replica.lagBytes, ms: replica.lagMs },
            input.policy.maxLag as NonNullable<RoutingPolicy["maxLag"]>,
          ),
        );
  if (within.length === 0) return miss(input, "behind", strict);

  const open = within.filter((replica) => !replica.saturated);
  if (open.length === 0) return miss(input, "saturated", strict);

  const chosen = selectReplica(input.policy.select, open, input.state, input.random);
  const reason = strict ? "constraint:replica" : (`auto:${chosen.name}` as const);
  return {
    decision: { endpoint: chosen.name, role: "replica", reason },
    state: chosen.state,
  };
}

function primary(reason: Decision["reason"], state: SelectState): RouteChoice {
  return { decision: { endpoint: "primary", role: "primary", reason }, state };
}

function miss(input: RouteInput, why: FallbackWhy, strict: boolean): RouteChoice {
  if (strict) throw noEligibleReplica(why);
  if (input.policy.fallback === "error") throw fallbackError(why);
  return {
    decision: { endpoint: "primary", role: "primary", reason: `fallback:${why}` },
    state: input.state,
  };
}
