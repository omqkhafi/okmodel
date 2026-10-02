/**
 * Routing vocabulary for the topology spike.
 *
 * Names follow section 15.1. `leastConnections` is the least-loaded strategy
 * (lowest in-flight count). `random` is included because this spike was asked
 * to measure it; the spec's named strategies are weighted, roundRobin,
 * leastConnections, and latencyAware.
 */

import type { LagLimit } from "./lag.js";

/** Which physical role an endpoint has. The primary is not a replica. */
export type EndpointRole = "primary" | "replica";

/** How an automatic read picks among eligible replicas. */
export type SelectName = "weighted" | "roundRobin" | "leastConnections" | "latencyAware" | "random";

/** Session watermark or no watermark. */
export type Consistency = "session" | "eventual";

/** Where an automatic read goes when no replica is eligible. */
export type Fallback = "primary" | "error";

/**
 * One replica a strategy may choose.
 *
 * `lag` is the eligibility view, not a ranking key, except for a custom
 * `select` that chooses to read it.
 */
export type SelectCandidate = {
  /** Endpoint name. */
  readonly name: string;
  /** Relative weight. Equal weights are smooth round-robin. */
  readonly weight: number;
  /** Statements in flight on this endpoint's pool. */
  readonly inflight: number;
  /** Smoothed statement latency. */
  readonly latencyMs: number;
  /** Byte and time lag. Null when the position is unknown. */
  readonly lag: { readonly bytes: bigint | null; readonly ms: number | null };
};

/** Extra inputs a custom strategy may use. */
export type SelectContext = {
  /** Returns a number in `[0, 1)`. */
  readonly random: () => number;
};

/**
 * Custom strategy. Returns the name of one candidate.
 *
 * @param candidates - Replicas that already passed filtering
 * @param ctx - Shared inputs such as the random source
 * @returns A name from `candidates`
 */
export type SelectFn = (candidates: readonly SelectCandidate[], ctx: SelectContext) => string;

/** Mutable cursor for strategies that remember earlier picks. */
export type SelectState = {
  /** Next index into the name-sorted candidate list. */
  readonly roundRobin: number;
  /** Nginx smooth-weighted current weights, keyed by endpoint name. */
  readonly weighted: Readonly<Record<string, number>>;
};

/**
 * What an operation is. The router trusts this classification.
 *
 * Writes, batches, locking reads, advisory locks, and user transactions
 * require the primary. Reads and internal read-only transactions do not.
 */
export type OperationKind =
  | "read"
  | "internal-read"
  | "write"
  | "batch"
  | "locking-read"
  | "advisory-lock"
  | "tx";

/** Per-call constraint. Omitted means automatic. */
export type RouteConstraint =
  | { readonly kind: "auto" }
  | { readonly kind: "primary" }
  | { readonly kind: "replica"; readonly consistency?: Consistency | undefined };

/** Why an automatic read did not use a replica. */
export type FallbackWhy = "no-replicas" | "unhealthy" | "behind" | "position-unknown" | "saturated";

/**
 * `inspect()` reason from section 15.1.
 *
 * `auto:<name>` is the replica that was chosen. `fallback:<why>` is an
 * automatic read that went to the primary.
 */
export type RouteReason =
  | "primary-required"
  | "constraint:primary"
  | "constraint:replica"
  | `auto:${string}`
  | `fallback:${FallbackWhy}`;

/** The endpoint chosen for one operation. */
export type Decision = {
  /** Endpoint name. The primary's name is `primary`. */
  readonly endpoint: string;
  /** Primary or replica. */
  readonly role: EndpointRole;
  /** Why this endpoint was chosen. */
  readonly reason: RouteReason;
};

/**
 * One replica after health, lag, and pool stats have been applied.
 *
 * The router does not open connections. It only reads this view.
 */
export type ReplicaView = {
  /** Endpoint name. */
  readonly name: string;
  /** Selection weight. */
  readonly weight: number;
  /** The last probe succeeded and the circuit is closed. */
  readonly healthy: boolean;
  /** Consecutive probe failures opened the circuit. */
  readonly circuitOpen: boolean;
  /** Last replay LSN that moved the cache forward. */
  readonly replayLsn: string | null;
  /** Byte lag against the primary insert LSN. */
  readonly lagBytes: bigint | null;
  /** Time lag. Zero when byte lag is zero. */
  readonly lagMs: number | null;
  /** In-flight checkouts on this pool. */
  readonly inflight: number;
  /** Callers waiting for a checkout. */
  readonly waiting: number;
  /** Free checkout slots. */
  readonly idle: number;
  /** The pool has no free slot. */
  readonly saturated: boolean;
  /** Smoothed probe or statement latency. */
  readonly latencyMs: number;
  /** This replica answered a replay-position read. */
  readonly positionCapable: boolean;
};

/** Connect-time routing policy. */
export type RoutingPolicy = {
  /** Named strategy or a function. */
  readonly select: SelectName | SelectFn;
  /** Default read consistency. */
  readonly consistency: Consistency;
  /** Automatic-read fallback. */
  readonly fallback: Fallback;
  /** Eligibility bound. Null means no lag bound. */
  readonly maxLag: LagLimit | null;
  /** Background probe interval. Zero probes only when asked. */
  readonly probeMs: number;
};

/**
 * Fresh strategy cursors.
 *
 * @returns An empty cursor
 */
export function initialSelectState(): SelectState {
  return { roundRobin: 0, weighted: {} };
}

/**
 * Returns whether this operation is allowed only on the primary.
 *
 * @param kind - Operation classification
 * @returns True for writes, batch, locking reads, advisory locks, and user transactions
 */
export function requiresPrimary(kind: OperationKind): boolean {
  return kind !== "read" && kind !== "internal-read";
}
