/**
 * Topology spike. Nothing here is part of the published `okmodel` package.
 */

export { TopologyError, type TopologyCode } from "./error.js";
export { connectTopology, ReadCall, TopologyClient } from "./client.js";
export type {
  CallResult,
  EndpointConfig,
  RunRequest,
  SessionClient,
  TopologyOptions,
  TxConnection,
  TxResult,
} from "./client.js";
export { parseMaxLag, parseProbe, lagBytes, lagTimeMs, withinLag, type LagLimit } from "./lag.js";
export {
  openEndpointPool,
  type EndpointPool,
  type HeldConnection,
  type PoolStats,
} from "./pool.js";
export {
  applyProbe,
  forwardLsn,
  initialProbe,
  type ProbeSample,
  type ProbeState,
} from "./probe.js";
export { decideRoute, type RouteChoice, type RouteInput } from "./route.js";
export { selectReplica, type Selection } from "./select.js";
export { emptyMark, markUnknown, noteCommit, type SessionMark } from "./session.js";
export {
  initialSelectState,
  requiresPrimary,
  type Consistency,
  type Decision,
  type EndpointRole,
  type Fallback,
  type FallbackWhy,
  type OperationKind,
  type ReplicaView,
  type RouteConstraint,
  type RouteReason,
  type RoutingPolicy,
  type SelectCandidate,
  type SelectFn,
  type SelectName,
  type SelectState,
} from "./types.js";
