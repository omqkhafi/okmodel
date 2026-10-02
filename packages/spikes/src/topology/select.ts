/**
 * Replica selection.
 *
 * Filtering has already removed ineligible replicas. These functions only choose.
 */

import type {
  ReplicaView,
  SelectCandidate,
  SelectContext,
  SelectFn,
  SelectName,
  SelectState,
} from "./types.js";

/** A choice and the cursors to keep. */
export type Selection = {
  /** Chosen replica. */
  readonly name: string;
  /** Cursors after this choice. */
  readonly state: SelectState;
};

/**
 * Picks one replica.
 *
 * @param name - Strategy name or function
 * @param replicas - Eligible replicas. Must be non-empty
 * @param state - Cursors from the previous choice
 * @param random - Source for the `random` strategy and for custom functions
 * @returns The chosen name and the next cursors
 */
export function selectReplica(
  name: SelectName | SelectFn,
  replicas: readonly ReplicaView[],
  state: SelectState,
  random: () => number,
): Selection {
  if (replicas.length === 0) throw new Error("selectReplica requires a candidate.");
  if (typeof name === "function") {
    return { name: fromFunction(name, replicas, { random }), state };
  }
  if (name === "roundRobin") return roundRobin(replicas, state);
  if (name === "leastConnections") return { name: leastConnections(replicas), state };
  if (name === "latencyAware") return { name: latencyAware(replicas), state };
  if (name === "random") return { name: randomPick(replicas, random), state };
  return weighted(replicas, state);
}

/**
 * Projects a replica into the object a custom strategy sees.
 *
 * @param replica - Eligible replica
 * @returns The strategy view
 */
export function asCandidate(replica: ReplicaView): SelectCandidate {
  return {
    name: replica.name,
    weight: replica.weight,
    inflight: replica.inflight,
    latencyMs: replica.latencyMs,
    lag: { bytes: replica.lagBytes, ms: replica.lagMs },
  };
}

function fromFunction(
  select: SelectFn,
  replicas: readonly ReplicaView[],
  ctx: SelectContext,
): string {
  const candidates = replicas.map(asCandidate);
  const chosen = select(candidates, ctx);
  if (!replicas.some((replica) => replica.name === chosen)) {
    throw new Error(`select returned '${chosen}', which is not an eligible replica.`);
  }
  return chosen;
}

function roundRobin(replicas: readonly ReplicaView[], state: SelectState): Selection {
  const ordered = [...replicas].sort((left, right) => left.name.localeCompare(right.name));
  const index = state.roundRobin % ordered.length;
  const chosen = ordered[index];
  if (chosen === undefined) throw new Error("roundRobin requires a candidate.");
  return { name: chosen.name, state: { ...state, roundRobin: state.roundRobin + 1 } };
}

function leastConnections(replicas: readonly ReplicaView[]): string {
  return (
    [...replicas].sort(
      (left, right) =>
        left.inflight - right.inflight ||
        left.waiting - right.waiting ||
        left.name.localeCompare(right.name),
    )[0]?.name ?? missing()
  );
}

function latencyAware(replicas: readonly ReplicaView[]): string {
  return (
    [...replicas].sort(
      (left, right) =>
        left.latencyMs - right.latencyMs ||
        left.inflight - right.inflight ||
        left.name.localeCompare(right.name),
    )[0]?.name ?? missing()
  );
}

function randomPick(replicas: readonly ReplicaView[], random: () => number): string {
  const ordered = [...replicas].sort((left, right) => left.name.localeCompare(right.name));
  const index = Math.min(ordered.length - 1, Math.floor(random() * ordered.length));
  return ordered[index]?.name ?? missing();
}

/**
 * Smooth weighted round-robin (nginx).
 *
 * Equal weights rotate in name order. A higher weight is chosen more often.
 */
function weighted(replicas: readonly ReplicaView[], state: SelectState): Selection {
  const next: Record<string, number> = { ...state.weighted };
  let total = 0;
  for (const replica of replicas) total += replica.weight;
  let best: ReplicaView | undefined;
  let bestWeight = Number.NEGATIVE_INFINITY;
  for (const replica of replicas) {
    const value = (next[replica.name] ?? 0) + replica.weight;
    next[replica.name] = value;
    if (
      best === undefined ||
      value > bestWeight ||
      (value === bestWeight && replica.name < best.name)
    ) {
      best = replica;
      bestWeight = value;
    }
  }
  if (best === undefined) missing();
  next[best.name] = (next[best.name] ?? 0) - total;
  return { name: best.name, state: { ...state, weighted: next } };
}

function missing(): never {
  throw new Error("selectReplica requires a candidate.");
}
