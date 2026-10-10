/**
 * Primary and replica endpoints (spec §15.1).
 *
 * Loaded only when `connect` is given a topology object. The string and pool
 * paths do not import this module. An automatic read chooses among eligible
 * replicas. One watermark on this handle covers the root, `for()`, `unscoped()`,
 * `using()`, and `reserve()`.
 */

import { isConnectionErrno, isConnectionSqlstate } from "../contracts/connection.js";
import type {
  DriverConnection,
  DriverPool,
  DriverStats,
  DriverTimeouts,
  ExecuteOptions,
  ExecuteResult,
  WireValue,
} from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import type { QuerySchema } from "../dialects/pg/model.js";
import { createClient } from "./client.js";
import type { ConnectOptions, Connected } from "./types.js";

/** How many consecutive probe failures open a replica's circuit. */
const CIRCUIT_AT = 2;

/** Longest backoff between probes, in milliseconds. */
const BACKOFF_CAP_MS = 30_000;

/** Default `routing.probe`, one second. */
const DEFAULT_PROBE_MS = 1_000;

const CAPABILITY_SQL =
  "select case when to_regprocedure('pg_last_wal_replay_lsn()') is null then false when to_regprocedure('pg_current_wal_insert_lsn()') is null then false else has_function_privilege(to_regprocedure('pg_last_wal_replay_lsn()'), 'execute') and has_function_privilege(to_regprocedure('pg_current_wal_insert_lsn()'), 'execute') end";

const HEALTH_SQL = "select 1, pg_last_wal_replay_lsn()::text";

/** Replay position and timestamp. Used only when `maxLag` is a duration. */
const HEALTH_TIME_SQL =
  "select 1, pg_last_wal_replay_lsn()::text, pg_last_xact_replay_timestamp()::text";

const INSERT_LSN_SQL = "select pg_current_wal_insert_lsn()::text";

const PING_SQL = "select 1";

/** Built-in `routing.select` names, in the order the OKM1120 message lists them. */
const SELECT_NAMES = ["weighted", "roundRobin", "leastConnections", "latencyAware"] as const;

/**
 * EWMA weight for `latencyAware` (D203).
 *
 * The first sample is stored as itself. Later samples use this alpha.
 */
const LATENCY_ALPHA = 0.2;

/** Keys `routing` accepts. */
const ROUTING_KEYS = "probe, select, fallback, consistency, maxLag";

/** `"primary"` or `"replica"`. `using` and `route` accept only these. */
export type RouteName = "primary" | "replica";

/**
 * One routing choice.
 *
 * `onRoute` receives this. `inspect()` does not, until the dev inspector (M2).
 */
export type RouteEvent = {
  /** What the statement was classified as. */
  readonly op: "read" | "write" | "tx" | "lock";
  /** Endpoint name. The primary is `"primary"`. */
  readonly endpoint: string;
  /**
   * `primary-required`, `constraint:primary`, `constraint:replica`,
   * `auto:<name>`, or `fallback:<no-replicas | unhealthy | position-unknown | saturated | behind>`.
   */
  readonly reason: string;
};

/**
 * One replica passed to a custom `routing.select`.
 *
 * `lag` is the replica's byte lag, or `null` when the primary insert position
 * or the replica replay position has not been seen. `latencyMs` stays `null`
 * until a probe or a successful read has been timed.
 */
export type ReplicaCandidate = {
  /** Endpoint name. */
  readonly name: string;
  /** Configured weight. Zero and below are OKM1120 at connect. */
  readonly weight: number;
  /** In-flight statements this router is running on the replica. */
  readonly inflight: number;
  /** EWMA of observed round-trip time, in milliseconds, or `null`. */
  readonly latencyMs: number | null;
  /** Byte lag behind the primary, or `null` when either position is unknown. */
  readonly lag: number | null;
};

/** What a custom `routing.select` is choosing for. */
type ReplicaSelectContext = {
  /** Automatic reads are the only calls that invoke a custom select. */
  readonly op: "read";
};

/** A built-in strategy name. */
type SelectName = (typeof SELECT_NAMES)[number];

/** `routing.select`. A function runs only for an automatic read with two or more candidates. */
type SelectChoice =
  | SelectName
  | ((
      candidates: readonly ReplicaCandidate[],
      ctx: ReplicaSelectContext,
    ) => ReplicaCandidate | string);

/**
 * A topology client.
 *
 * `using` returns a client that forces one route. That client has no `close`
 * and no `using`. Only the root closes the pools.
 */
export type RoutedClient<S extends QuerySchema> = Connected<S> & {
  /**
   * Forces later operations onto the primary or a replica.
   *
   * @param route - `"primary"` or `"replica"`
   * @returns A client with no `close` and no `using`
   */
  using(route: RouteName): Omit<Connected<S>, "close">;
};

/**
 * Replay position for one replica.
 *
 * Tests supply this over independent databases. The probe still runs `SELECT 1`
 * on the replica's pool. The position does not come from a mocked driver.
 */
export type ReplicaState = {
  /**
   * @param endpoint - The replica being probed
   * @returns The replay LSN, or `null` when the replica has not replayed
   */
  replayLsn(endpoint: { readonly name: string }): string | null | Promise<string | null>;
  /**
   * Replay timestamp for a time `maxLag`.
   *
   * Omitted, and with no seam, the probe reads `pg_last_xact_replay_timestamp()`
   * only when `maxLag` is a duration.
   *
   * @param endpoint - The replica being probed
   * @returns A timestamp, or `null` when the replica has not replayed a transaction
   */
  replayTime?(endpoint: {
    readonly name: string;
  }): Date | string | null | Promise<Date | string | null>;
};

/** One replica in `{ primary, replicas }`. A string is a URL with weight 1. */
export type ReplicaInput = {
  readonly url: string;
  readonly weight?: number;
  readonly name?: string;
  readonly pool?: { readonly max?: number };
};

/** The first argument of `connect` when it is a topology. */
export type TopologyInput = {
  readonly primary: string;
  readonly replicas?: readonly (string | ReplicaInput)[];
};

/** Options only the topology module reads. */
export type TopologyOptions = {
  /**
   * Background probe interval. `"1s"` when omitted.
   *
   * `select` chooses among eligible replicas. The default is `"weighted"`.
   * `consistency` is `"session"` (the default) or `"eventual"`. `maxLag` is a
   * duration (`"5s"`, `"500ms"`, `"2m"`) or a size (`"16MB"`, `"512KB"`,
   * `"1GB"`, `"4096B"`). `fallback` is `"primary"` (the default) or `"error"`.
   */
  readonly routing?: {
    readonly probe?: string | number;
    readonly select?:
      | "weighted"
      | "roundRobin"
      | "leastConnections"
      | "latencyAware"
      | ((
          candidates: readonly ReplicaCandidate[],
          ctx: { readonly op: "read" },
        ) => ReplicaCandidate | string);
    readonly consistency?: "session" | "eventual";
    readonly fallback?: "primary" | "error";
    readonly maxLag?: string;
  };
  /**
   * Called after an endpoint is chosen.
   *
   * A throw is swallowed. The operation still runs.
   */
  readonly onRoute?: (event: RouteEvent) => void;
  /** Test seam for replay positions. Omitted, the probe reads `pg_last_wal_replay_lsn()`. */
  readonly replicaState?: ReplicaState;
};

/** One endpoint after connect. Tests read this. It is not the query path. */
export type EndpointView = {
  readonly name: string;
  readonly role: "primary" | "replica";
  readonly weight: number;
  /** `max` passed to the driver. Absent when connect did not set one. */
  readonly max: number | undefined;
  /** Whether `replication.position` was detected on this endpoint. */
  readonly position: boolean;
  readonly circuit: "closed" | "open";
  readonly failures: number;
  readonly replayLsn: string | null;
  /** Delay until the next probe. The primary is 0. */
  readonly nextDelayMs: number;
};

/** The topology a client was built with. */
export type TopologyView = {
  readonly endpoints: readonly EndpointView[];
};

/** Fields each driver's `open` may read. Extra keys are ignored by that driver. */
type EndpointConfig = {
  readonly url: string;
  readonly dataDir: string;
  readonly max?: number;
  readonly timeouts?: DriverTimeouts;
  readonly prepared?: "named" | "unnamed";
  readonly searchPath?: string;
  readonly ssl?: unknown;
};

/** Opens one endpoint. postgres.js reads `url`. PGlite reads `dataDir`. */
export type EndpointOpen = (config: EndpointConfig) => DriverPool | Promise<DriverPool>;

type Endpoint = {
  name: string;
  role: "primary" | "replica";
  weight: number;
  max: number | undefined;
  pool: DriverPool;
  position: boolean;
  circuit: "closed" | "open";
  failures: number;
  replayLsn: string | null;
  /** Parsed replay LSN. Absent until a probe or an on-demand check returns one. */
  replayPos: bigint | undefined;
  /** Replay timestamp, in epoch milliseconds. `null` until a time probe sees one. */
  replayAt: number | null;
  nextDelayMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Smooth weighted round-robin current weight. */
  current: number;
  /** Statements this router has started on the endpoint and not finished. */
  inflight: number;
  /** EWMA of round-trip time. `null` until the first probe or successful read. */
  latencyMs: number | null;
};

/** `"session"` tracks a watermark. `"eventual"` does not. */
type Consistency = "session" | "eventual";

/** A parsed `routing.maxLag`. */
type MaxLag =
  | { readonly kind: "time"; readonly ms: number }
  | { readonly kind: "bytes"; readonly bytes: bigint };

type Handle = {
  closed: boolean;
  probeMs: number;
  consistency: Consistency;
  maxLag: MaxLag | undefined;
  /** At least one replica was configured. */
  hasReplicas: boolean;
  /**
   * Client-wide commit watermark.
   *
   * Absent until a committed write's position read succeeds. Never moves backwards.
   */
  watermark: bigint | undefined;
  /** A committed write's position could not be read. Automatic reads use the primary. */
  positionUnknown: boolean;
  /**
   * Generation of {@link Handle.positionUnknown}.
   *
   * Increments every time the flag is set. A primary probe may clear the flag
   * only when it started in the generation that is still current.
   */
  unknownEpoch: number;
  /** Latest primary insert LSN from a probe or a write. Never moves backwards. */
  primaryLsn: bigint | undefined;
  fallback: "primary" | "error";
  select: SelectChoice;
  /** Last replica `roundRobin` chose. Absent until the first pick. */
  rrLast: Endpoint | undefined;
  /** Reused candidate list. Not held across an await. */
  scratch: Endpoint[];
  onRoute: ((event: RouteEvent) => void) | undefined;
  replicaState: ReplicaState | undefined;
  endpoints: Endpoint[];
  closing: Promise<void> | undefined;
};

const handles = new WeakMap<object, Handle>();

/**
 * Opens one pool per endpoint, detects `replication.position`, and starts replica probes.
 *
 * An automatic read runs the selection pipeline and `routing.select`.
 * `close()` stops the probes and closes every pool this call opened,
 * including clients from `using`.
 *
 * @param target - `{ primary, replicas }`
 * @param options - Schema, pool default, probe interval, and the optional seam
 * @param open - The driver's `open`
 * @returns The client
 */
export async function connectTopology<S extends QuerySchema>(
  target: object,
  options: ConnectOptions<S> &
    TopologyOptions & {
      readonly max?: number;
      readonly prepared?: "named" | "unnamed";
      readonly searchPath?: string;
      readonly ssl?: unknown;
    },
  open: EndpointOpen,
): Promise<RoutedClient<S>> {
  if (Object.prototype.hasOwnProperty.call(options.schema.model, "using")) {
    throw new OkmError("OKM1120", 'Table "using" collides with client.using(). Rename the table.');
  }
  refuseRouting(options.routing);
  const consistency = readConsistency(options.routing?.consistency);
  const maxLag = readMaxLag(options.routing?.maxLag);
  const select = readSelect(options.routing?.select);
  const primaryUrl = readPrimary(target);
  const replicas = readReplicas(target);
  const probeMs = readProbe(options.routing?.probe);
  const defaults = driverFields(options);
  const opened: Endpoint[] = [];
  try {
    opened.push(
      await openEndpoint(
        open,
        primaryUrl,
        defaults.max,
        defaults,
        "primary",
        "primary",
        1,
        probeMs,
      ),
    );
    for (let index = 0; index < replicas.length; index += 1) {
      const replica = replicas[index];
      if (replica === undefined) continue;
      const name = replica.name ?? `replica-${String(index + 1)}`;
      opened.push(
        await openEndpoint(
          open,
          replica.url,
          replica.max ?? defaults.max,
          defaults,
          name,
          "replica",
          replica.weight,
          probeMs,
        ),
      );
    }
    assertNames(opened);
    await Promise.all(opened.map((endpoint) => detectPosition(endpoint)));
    const replicaEndpoints = opened.filter((endpoint) => endpoint.role === "replica");
    const handle: Handle = {
      closed: false,
      probeMs,
      consistency,
      maxLag,
      hasReplicas: replicaEndpoints.length > 0,
      watermark: undefined,
      positionUnknown: false,
      unknownEpoch: 0,
      primaryLsn: undefined,
      fallback: readFallback(options.routing?.fallback),
      select,
      rrLast: undefined,
      scratch: [],
      onRoute: options.onRoute,
      replicaState: options.replicaState,
      endpoints: opened,
      closing: undefined,
    };
    await Promise.all([
      ...replicaEndpoints.map((endpoint) => sample(handle, endpoint)),
      samplePrimary(handle),
    ]);
    for (const endpoint of replicaEndpoints) {
      endpoint.nextDelayMs = delayFor(probeMs, endpoint);
      schedule(handle, endpoint);
    }
    schedulePrimary(handle);
    const primary = opened[0];
    if (primary === undefined) {
      throw new OkmError("OKM1120", "A topology needs one primary URL.");
    }
    const shared = {
      http: options.errors?.http,
      includeValues: options.errors?.includeValues,
      logger: options.logger,
      signal: options.signal,
      timeout: options.timeout,
      timeouts: options.timeouts,
      hookm: options.hookm,
      catalog: options.catalog,
      catalogDir: options.catalogDir,
      requireMeta: options.requireMeta,
      generators: options.generators,
    };
    const router = routePool(handle);
    const client = createClient(options.schema, router, { ownsPool: true, ...shared });
    const routed = client as RoutedClient<S>;
    routed.using = (route) => derive(options.schema, handle, router, shared, route);
    handles.set(routed, handle);
    return routed;
  } catch (error) {
    for (const endpoint of opened) {
      if (endpoint.timer !== undefined) clearTimeout(endpoint.timer);
      endpoint.timer = undefined;
    }
    await Promise.all(opened.map((endpoint) => endpoint.pool.close()));
    throw error;
  }
}

/**
 * Reads the endpoints recorded for a client this module built.
 *
 * A string `connect` has no record. Routing does not call this.
 *
 * @param client - The value `connect` returned
 * @returns The endpoints, or `undefined` when `client` is not a topology client
 */
export function readTopology(client: object): TopologyView | undefined {
  const handle = handles.get(client);
  if (handle === undefined) return undefined;
  return {
    endpoints: handle.endpoints.map((endpoint) => ({
      name: endpoint.name,
      role: endpoint.role,
      weight: endpoint.weight,
      max: endpoint.max,
      position: endpoint.position,
      circuit: endpoint.circuit,
      failures: endpoint.failures,
      replayLsn: endpoint.replayLsn,
      nextDelayMs: endpoint.nextDelayMs,
    })),
  };
}

function refuseRouting(routing: TopologyOptions["routing"]): void {
  if (routing === undefined) return;
  if (typeof routing !== "object" || routing === null || Array.isArray(routing)) {
    throw new OkmError("OKM1120", `routing must be an object. Accepted keys: ${ROUTING_KEYS}.`);
  }
  for (const key of Object.keys(routing)) {
    if (
      key === "probe" ||
      key === "fallback" ||
      key === "select" ||
      key === "consistency" ||
      key === "maxLag"
    ) {
      continue;
    }
    throw new OkmError(
      "OKM1120",
      `routing.${key} is not a routing option. Accepted keys: ${ROUTING_KEYS}.`,
    );
  }
}

/**
 * `routing.select`. Omitted means smooth weighted round-robin.
 *
 * @param value - The option the caller passed
 * @returns The strategy
 */
function readSelect(value: unknown): SelectChoice {
  if (value === undefined) return "weighted";
  if (typeof value === "function") return value as SelectChoice;
  if (typeof value === "string" && isSelectName(value)) return value;
  throw new OkmError(
    "OKM1120",
    `routing.select must be "${SELECT_NAMES.join('", "')}", or a function.`,
  );
}

/** One of the built-in strategy names. */
function isSelectName(value: string): value is SelectName {
  return (SELECT_NAMES as readonly string[]).includes(value);
}

/**
 * `routing.consistency`. Omitted means `"session"`.
 *
 * @param value - The option the caller passed
 * @returns The mode
 */
function readConsistency(value: unknown): Consistency {
  if (value === undefined || value === "session") return "session";
  if (value === "eventual") return "eventual";
  throw new OkmError(
    "OKM1120",
    `routing.consistency must be "session" or "eventual". ${shown(value)} is not one of those.`,
  );
}

/**
 * `routing.maxLag`. Omitted means no lag filter.
 *
 * A bare number is rejected: the unit would be ambiguous.
 *
 * @param value - The option the caller passed
 * @returns The filter, or `undefined` when omitted
 */
function readMaxLag(value: unknown): MaxLag | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new OkmError("OKM1120", maxLagMessage(shown(value)));
  }
  const text = value.trim();
  const time = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(text);
  if (time !== null) {
    const amount = Number(time[1]);
    const unit = time[2];
    if (!Number.isFinite(amount) || amount < 0 || unit === undefined) {
      throw new OkmError("OKM1120", maxLagMessage(value));
    }
    const ms = unit === "ms" ? amount : unit === "s" ? amount * 1_000 : amount * 60_000;
    return { kind: "time", ms };
  }
  const size = /^(\d+(?:\.\d+)?)(B|KB|MB|GB)$/.exec(text);
  if (size !== null) {
    const amount = Number(size[1]);
    const unit = size[2];
    if (!Number.isFinite(amount) || amount < 0 || unit === undefined) {
      throw new OkmError("OKM1120", maxLagMessage(value));
    }
    return { kind: "bytes", bytes: scaleBytes(amount, unit) };
  }
  throw new OkmError("OKM1120", maxLagMessage(value));
}

/** The OKM1120 text for a `maxLag` value. */
function maxLagMessage(value: string): string {
  return `routing.maxLag must be a duration ("5s", "500ms", "2m") or a size ("16MB", "512KB", "1GB", "4096B"). ${value} is not one of those forms.`;
}

/** `amount` in `unit`, as bytes. `KB` is 1024. */
function scaleBytes(amount: number, unit: string): bigint {
  const scale =
    unit === "B" ? 1n : unit === "KB" ? 1024n : unit === "MB" ? 1_048_576n : 1_073_741_824n;
  if (Number.isInteger(amount)) return BigInt(amount) * scale;
  return BigInt(Math.trunc(amount * Number(scale)));
}

function readPrimary(target: object): string {
  const value = fields(target);
  for (const key of Object.keys(value)) {
    if (key !== "primary" && key !== "replicas") {
      throw new OkmError(
        "OKM1120",
        `Topology key ${key} is not accepted. Accepted keys: primary, replicas.`,
      );
    }
  }
  const primary = value.primary;
  if (typeof primary !== "string" || primary.length === 0) {
    throw new OkmError(
      "OKM1120",
      "A topology needs one primary URL. Accepted shape: { primary, replicas }.",
    );
  }
  return primary;
}

type ParsedReplica = {
  readonly url: string;
  readonly weight: number;
  readonly name: string | undefined;
  readonly max: number | undefined;
};

function readReplicas(target: object): readonly ParsedReplica[] {
  const value = fields(target).replicas;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new OkmError(
      "OKM1120",
      "replicas must be an array of URLs or { url, weight, name, pool }.",
    );
  }
  return value.map((entry, index) => readReplica(entry, index));
}

function readReplica(entry: unknown, index: number): ParsedReplica {
  if (typeof entry === "string") {
    if (entry.length === 0) {
      throw new OkmError("OKM1120", `replicas[${String(index)}] is an empty URL.`);
    }
    return { url: entry, weight: 1, name: undefined, max: undefined };
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new OkmError(
      "OKM1120",
      `replicas[${String(index)}] must be a URL or { url, weight, name, pool }.`,
    );
  }
  const value = fields(entry);
  for (const key of Object.keys(value)) {
    if (key !== "url" && key !== "weight" && key !== "name" && key !== "pool") {
      throw new OkmError(
        "OKM1120",
        `replicas[${String(index)}].${key} is not accepted. Accepted keys: url, weight, name, pool.`,
      );
    }
  }
  const url = value.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new OkmError("OKM1120", `replicas[${String(index)}] needs a url.`);
  }
  return {
    url,
    weight: readWeight(value.weight, index),
    name: readName(value.name, index),
    max: readPoolMax(value.pool, index),
  };
}

function readWeight(value: unknown, index: number): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new OkmError("OKM1120", `replicas[${String(index)}].weight must be a positive number.`);
  }
  return value;
}

function readName(value: unknown, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new OkmError("OKM1120", `replicas[${String(index)}].name must be a non-empty string.`);
  }
  return value;
}

function readPoolMax(value: unknown, index: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OkmError("OKM1120", `replicas[${String(index)}].pool must be { max }.`);
  }
  const pool = fields(value);
  for (const key of Object.keys(pool)) {
    if (key !== "max") {
      throw new OkmError(
        "OKM1120",
        `replicas[${String(index)}].pool.${key} is not accepted. Accepted key: max.`,
      );
    }
  }
  const max = pool.max;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    throw new OkmError(
      "OKM1120",
      `replicas[${String(index)}].pool.max must be a positive integer.`,
    );
  }
  return max;
}

function readProbe(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_PROBE_MS;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new OkmError("OKM1120", "routing.probe must be a positive number of milliseconds.");
    }
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined) {
    throw new OkmError(
      "OKM1120",
      'routing.probe must be a number of milliseconds, or "1s", "500ms", or "1m".',
    );
  }
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new OkmError("OKM1120", "routing.probe must be positive.");
  }
  if (unit === "ms") return parsed;
  if (unit === "s") return parsed * 1_000;
  return parsed * 60_000;
}

function assertNames(endpoints: readonly Endpoint[]): void {
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.name)) {
      throw new OkmError("OKM1120", `Endpoint name ${endpoint.name} is used twice.`);
    }
    seen.add(endpoint.name);
  }
}

type DriverFields = {
  readonly max: number | undefined;
  readonly timeouts: DriverTimeouts | undefined;
  readonly prepared: "named" | "unnamed" | undefined;
  readonly searchPath: string | undefined;
  readonly ssl: unknown;
};

function driverFields(options: object): DriverFields {
  const value = fields(options);
  const prepared = value.prepared;
  return {
    max: typeof value.max === "number" ? value.max : undefined,
    timeouts:
      typeof value.timeouts === "object" && value.timeouts !== null
        ? (value.timeouts as DriverTimeouts)
        : undefined,
    prepared: prepared === "named" || prepared === "unnamed" ? prepared : undefined,
    searchPath: typeof value.searchPath === "string" ? value.searchPath : undefined,
    ssl: value.ssl,
  };
}

async function openEndpoint(
  open: EndpointOpen,
  url: string,
  max: number | undefined,
  defaults: DriverFields,
  name: string,
  role: "primary" | "replica",
  weight: number,
  probeMs: number,
): Promise<Endpoint> {
  const pool = await open({
    url,
    dataDir: url,
    ...(max !== undefined ? { max } : {}),
    ...(defaults.timeouts !== undefined ? { timeouts: defaults.timeouts } : {}),
    ...(defaults.prepared !== undefined ? { prepared: defaults.prepared } : {}),
    ...(defaults.searchPath !== undefined ? { searchPath: defaults.searchPath } : {}),
    ...(defaults.ssl !== undefined ? { ssl: defaults.ssl } : {}),
  });
  return {
    name,
    role,
    weight,
    max,
    pool,
    position: false,
    circuit: "closed",
    failures: 0,
    replayLsn: null,
    replayPos: undefined,
    replayAt: null,
    nextDelayMs: role === "replica" ? probeMs : 0,
    timer: undefined,
    current: 0,
    inflight: 0,
    latencyMs: null,
  };
}

async function detectPosition(endpoint: Endpoint): Promise<void> {
  try {
    const result = await endpoint.pool.execute(CAPABILITY_SQL);
    endpoint.position = truth(result.rows[0]?.[0]);
  } catch {
    endpoint.position = false;
  }
}

async function sample(handle: Handle, endpoint: Endpoint): Promise<void> {
  try {
    const sampled = await readPosition(handle, endpoint);
    endpoint.failures = 0;
    endpoint.circuit = "closed";
    applySample(endpoint, sampled);
  } catch {
    endpoint.failures += 1;
    if (endpoint.failures >= CIRCUIT_AT) endpoint.circuit = "open";
  }
}

/** One probe or on-demand reading of a replica. */
type Sampled = {
  readonly lsn: string | null;
  readonly time: string | null;
};

async function readPosition(handle: Handle, endpoint: Endpoint): Promise<Sampled> {
  const state = handle.replicaState;
  const started = performance.now();
  if (state === undefined) {
    const sql = handle.maxLag?.kind === "time" ? HEALTH_TIME_SQL : HEALTH_SQL;
    const result = await endpoint.pool.execute(sql);
    observe(endpoint, performance.now() - started);
    const row = result.rows[0];
    return { lsn: row?.[1] ?? null, time: row?.[2] ?? null };
  }
  await endpoint.pool.execute(PING_SQL);
  observe(endpoint, performance.now() - started);
  const lsn = await state.replayLsn({ name: endpoint.name });
  if (typeof lsn !== "string" && lsn !== null) {
    throw new OkmError("OKM1120", "ReplicaState.replayLsn must return a WAL position or null.");
  }
  return { lsn, time: await seamTime(handle, endpoint, state) };
}

/** The seam's replay timestamp, when `maxLag` is a duration and the seam provides one. */
async function seamTime(
  handle: Handle,
  endpoint: Endpoint,
  state: ReplicaState,
): Promise<string | null> {
  if (handle.maxLag?.kind !== "time" || state.replayTime === undefined) return null;
  const value = await state.replayTime({ name: endpoint.name });
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || value === null) return value;
  throw new OkmError("OKM1120", "ReplicaState.replayTime must return a timestamp or null.");
}

/** Stores a replay position when it moves forward, and a replay timestamp when present. */
function applySample(endpoint: Endpoint, sampled: Sampled): void {
  if (sampled.lsn !== null) noteReplay(endpoint, sampled.lsn);
  if (sampled.time !== null) noteTime(endpoint, sampled.time);
}

/** Keeps the higher replay LSN. A later lower reading is not a safe bound. */
function noteReplay(endpoint: Endpoint, text: string): void {
  const pos = parseLsn(text);
  if (pos === undefined) return;
  if (endpoint.replayPos !== undefined && pos < endpoint.replayPos) return;
  endpoint.replayPos = pos;
  endpoint.replayLsn = text.trim();
}

/** Stores a replay timestamp. */
function noteTime(endpoint: Endpoint, text: string): void {
  const parsed = parseTime(text);
  if (parsed === undefined) return;
  endpoint.replayAt = parsed;
}

/**
 * Records one round trip.
 *
 * The first sample is stored as itself. Later samples use {@link LATENCY_ALPHA}.
 *
 * @param endpoint - The replica that answered
 * @param sampleMs - Elapsed milliseconds
 */
function observe(endpoint: Endpoint, sampleMs: number): void {
  const previous = endpoint.latencyMs;
  endpoint.latencyMs =
    previous === null ? sampleMs : LATENCY_ALPHA * sampleMs + (1 - LATENCY_ALPHA) * previous;
}

function delayFor(probeMs: number, endpoint: Endpoint): number {
  if (endpoint.circuit === "closed") return probeMs;
  const steps = Math.min(Math.max(endpoint.failures - 1, 1), 8);
  const delay = probeMs * 2 ** steps;
  return delay > BACKOFF_CAP_MS ? BACKOFF_CAP_MS : delay;
}

function schedule(handle: Handle, endpoint: Endpoint): void {
  if (handle.closed || endpoint.role !== "replica") return;
  const timer = setTimeout(() => {
    endpoint.timer = undefined;
    void runProbe(handle, endpoint);
  }, endpoint.nextDelayMs);
  timer.unref();
  endpoint.timer = timer;
}

/** Samples the primary insert LSN on the same interval as the replica probes. */
function schedulePrimary(handle: Handle): void {
  const primary = handle.endpoints[0];
  if (handle.closed || primary === undefined || !probesPrimary(handle)) return;
  const timer = setTimeout(() => {
    primary.timer = undefined;
    void runPrimary(handle);
  }, handle.probeMs);
  timer.unref();
  primary.timer = timer;
}

async function runPrimary(handle: Handle): Promise<void> {
  if (handle.closed) return;
  await samplePrimary(handle);
  if (handle.closed) return;
  schedulePrimary(handle);
}

/**
 * Reads `pg_current_wal_insert_lsn()` on the primary.
 *
 * A success refreshes the lag baseline. It may also clear `position unknown`
 * when this probe started while that flag was set and nothing has marked a
 * newer generation since. A query issued earlier can sit below the commit
 * whose position read failed, so that result does not move the watermark.
 *
 * @param handle - Primary pool and watermark
 */
async function samplePrimary(handle: Handle): Promise<void> {
  if (!probesPrimary(handle)) return;
  const primary = handle.endpoints[0];
  if (primary === undefined) return;
  const epoch = handle.unknownEpoch;
  const wasUnknown = handle.positionUnknown;
  try {
    const lsn = await readInsertLsn(primary.pool);
    if (lsn === undefined) return;
    if (wasUnknown && handle.unknownEpoch === epoch && handle.positionUnknown) {
      raiseWatermark(handle, lsn);
      return;
    }
    notePrimary(handle, lsn);
  } catch {
    // The last sample stays. A later probe or write can recover.
  }
}

/** The primary insert LSN is useful for session recovery and for `maxLag`. */
function probesPrimary(handle: Handle): boolean {
  if (!handle.hasReplicas) return false;
  const primary = handle.endpoints[0];
  if (primary === undefined || !primary.position) return false;
  return handle.consistency === "session" || handle.maxLag !== undefined;
}

async function runProbe(handle: Handle, endpoint: Endpoint): Promise<void> {
  if (handle.closed) return;
  await sample(handle, endpoint);
  if (handle.closed) return;
  endpoint.nextDelayMs = delayFor(handle.probeMs, endpoint);
  schedule(handle, endpoint);
}

function closeHandle(handle: Handle): Promise<void> {
  handle.closing ??= shutdown(handle);
  return handle.closing;
}

async function shutdown(handle: Handle): Promise<void> {
  handle.closed = true;
  for (const endpoint of handle.endpoints) {
    if (endpoint.timer !== undefined) clearTimeout(endpoint.timer);
    endpoint.timer = undefined;
  }
  await Promise.all(handle.endpoints.map((endpoint) => endpoint.pool.close()));
}

type Choice = {
  endpoint: Endpoint;
  op: RouteEvent["op"];
  reason: string;
};

type ClientOpts = Parameters<typeof createClient>[2];

/**
 * Routes one statement. The session is this handle: one per `connect`, shared
 * by `for()` and by a connection from `reserve()`.
 *
 * @param handle - Pools, the watermark, and `onRoute`
 * @returns The pool `createClient` holds
 */
function routePool(handle: Handle): DriverPool {
  const primary = handle.endpoints[0];
  if (primary === undefined) {
    throw new OkmError("OKM1120", "A topology needs one primary URL.");
  }
  const pool: DriverPool = {
    capabilities: primary.pool.capabilities,
    execute: async (text, params, options) => {
      if (handle.closed) closed();
      const choice = await choose(handle, text, options?.route);
      const result = await attempt(handle, choice, (endpoint) =>
        endpoint.pool.execute(text, params, strip(options)),
      );
      if (choice.op === "write") await noteWrite(handle, primary.pool);
      return result;
    },
    batch: async (statements, options) => {
      if (handle.closed) closed();
      if (options?.route === "replica") replicaRefused();
      const reason = options?.route === "primary" ? "constraint:primary" : "primary-required";
      tell(handle, { op: "write", endpoint: primary.name, reason });
      const result = await primary.pool.batch(statements, strip(options));
      await noteWrite(handle, primary.pool);
      return result;
    },
    stats: () => primary.pool.stats(),
    close: () => closeHandle(handle),
  };
  if (primary.pool.reserve !== undefined) {
    pool.reserve = async () => {
      if (handle.closed) closed();
      tell(handle, { op: "tx", endpoint: primary.name, reason: "primary-required" });
      return wrap(handle, await primary.pool.reserve!());
    };
  }
  if (primary.pool.describe !== undefined) {
    pool.describe = async (text, params) => {
      const choice = await choose(handle, text, undefined);
      tell(handle, { op: choice.op, endpoint: choice.endpoint.name, reason: choice.reason });
      if (choice.endpoint.pool.describe !== undefined) {
        return choice.endpoint.pool.describe(text, params);
      }
      return primary.pool.describe!(text, params);
    };
  }
  if (primary.pool.stream !== undefined) {
    pool.stream = (text, params) => readStream(handle, text, undefined, params, primary.pool);
  }
  if (primary.pool.listen !== undefined) {
    pool.listen = (channel, onNotify) => {
      tell(handle, { op: "read", endpoint: primary.name, reason: "primary-required" });
      return primary.pool.listen!(channel, onNotify);
    };
  }
  if (primary.pool.cancel !== undefined) {
    pool.cancel = () => {
      for (const endpoint of handle.endpoints) endpoint.pool.cancel?.();
    };
  }
  return pool;
}

/**
 * A client that forces one route. It does not own the pools.
 *
 * @param schema - The same schema as the root
 * @param handle - The root session. Scoped clients share it
 * @param router - The shared router
 * @param shared - Logger, timeouts, and catalog options
 * @param route - `"primary"` or `"replica"`. Anything else is OKM1120
 * @returns A client with no `close` and no `using`
 */
function derive<S extends QuerySchema>(
  schema: S,
  handle: Handle,
  router: DriverPool,
  shared: Omit<ClientOpts, "ownsPool">,
  route: unknown,
): Omit<Connected<S>, "close"> {
  const name = readRoute(route);
  const client = createClient(schema, force(handle, router, name), { ...shared, ownsPool: false });
  delete (client as { close?: unknown }).close;
  return client;
}

/**
 * Injects `route` into every statement. `reserve` on a replica scope is OKM1840.
 *
 * @param handle - Used when a call has no options slot, such as `stream`
 * @param router - The shared router
 * @param route - The forced route
 * @returns A pool that does not close the endpoints
 */
function force(handle: Handle, router: DriverPool, route: RouteName): DriverPool {
  const pool: DriverPool & { forcedRoute: RouteName } = {
    forcedRoute: route,
    capabilities: router.capabilities,
    execute: (text, params, options) => router.execute(text, params, { ...options, route }),
    batch: (statements, options) => router.batch(statements, { ...options, route }),
    stats: () => router.stats(),
    close: () => Promise.resolve(),
  };
  if (router.reserve !== undefined) {
    pool.reserve = () => {
      if (route === "replica") replicaRefused();
      return router.reserve!();
    };
  }
  if (router.describe !== undefined) {
    pool.describe = async (text, params) => {
      const choice = await choose(handle, text, route);
      tell(handle, { op: choice.op, endpoint: choice.endpoint.name, reason: choice.reason });
      if (choice.endpoint.pool.describe !== undefined) {
        return choice.endpoint.pool.describe(text, params);
      }
      return router.describe!(text, params);
    };
  }
  if (router.stream !== undefined) {
    pool.stream = (text, params) => readStream(handle, text, route, params, router);
  }
  if (router.listen !== undefined) {
    pool.listen = (channel, onNotify) => {
      if (route === "replica") replicaRefused();
      return router.listen!(channel, onNotify);
    };
  }
  if (router.cancel !== undefined) pool.cancel = () => router.cancel!();
  return pool;
}

/** Classifies a statement from its text. A `with` stays on the primary. */
function classOf(text: string): RouteEvent["op"] {
  const head = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (/^(begin|start transaction|commit|rollback|savepoint|release|set|reset)\b/.test(head)) {
    return "tx";
  }
  if (head.includes("pg_advisory")) return "lock";
  if (/\sfor (no key update|key share|update|share)\b/.test(head)) return "lock";
  if (
    /^(insert|update|delete|refresh|with|create|alter|drop|truncate|grant|revoke|comment|vacuum|analyze|reindex|copy)\b/.test(
      head,
    )
  ) {
    return "write";
  }
  return "read";
}

/**
 * Picks an endpoint.
 *
 * The consistency stage may check a replica's replay position. That check
 * finishes before this promise resolves.
 *
 * @param handle - Watermark, lag, and replica health
 * @param text - Statement text
 * @param route - Caller hint. Absent means classify
 * @returns The endpoint, the class, and the reason
 */
async function choose(handle: Handle, text: string, route: string | undefined): Promise<Choice> {
  if (route !== undefined && route !== "primary" && route !== "replica") {
    throw new OkmError("OKM1120", 'route must be "primary" or "replica".');
  }
  const op = classOf(text);
  const primary = handle.endpoints[0];
  if (primary === undefined) throw new OkmError("OKM1120", "A topology needs one primary URL.");
  // The dialect check is not a user read. It always uses the primary.
  if (text.trimStart().toLowerCase().startsWith("select current_setting")) {
    return { endpoint: primary, op: "read", reason: "primary-required" };
  }
  if (route === "replica" && op !== "read") replicaRefused();
  if (op !== "read") {
    return {
      endpoint: primary,
      op,
      reason: route === "primary" ? "constraint:primary" : "primary-required",
    };
  }
  if (route === "primary") return { endpoint: primary, op, reason: "constraint:primary" };
  if (handle.positionUnknown && handle.consistency === "session" && handle.hasReplicas) {
    if (route === "replica") noReplica();
    if (handle.fallback === "error") fallbackRefused("position-unknown");
    return { endpoint: primary, op, reason: "fallback:position-unknown" };
  }
  const explicit = route === "replica";
  const gated = await gate(handle, undefined, !explicit);
  const replica = pick(handle, gated.ready, !explicit);
  if (replica !== undefined) {
    return {
      endpoint: replica,
      op,
      reason: explicit ? "constraint:replica" : `auto:${replica.name}`,
    };
  }
  if (explicit) noReplica();
  if (handle.fallback === "error") fallbackRefused(gated.miss);
  return { endpoint: primary, op, reason: `fallback:${gated.miss}` };
}

/**
 * Yields rows from the endpoint chosen for `text`.
 *
 * @param handle - Watermark and replicas
 * @param text - Statement text
 * @param route - Forced route, or absent
 * @param params - Wire parameters
 * @param fallback - Pool whose stream runs when the chosen pool has none
 * @returns Row chunks
 */
async function* readStream(
  handle: Handle,
  text: string,
  route: string | undefined,
  params: readonly WireValue[] | undefined,
  fallback: DriverPool,
): AsyncGenerator<readonly (readonly WireValue[])[]> {
  const choice = await choose(handle, text, route);
  tell(handle, { op: choice.op, endpoint: choice.endpoint.name, reason: choice.reason });
  const pool = choice.endpoint.pool.stream !== undefined ? choice.endpoint.pool : fallback;
  if (pool.stream === undefined) return;
  yield* pool.stream(text, params);
}

/**
 * Runs a read once, then once more on another eligible replica after a
 * connection failure. A replica constraint does not continue to the primary.
 *
 * @param handle - Notified of the choice
 * @param choice - Endpoint and reason
 * @param run - The pool call
 * @returns The statement result
 */
async function attempt(
  handle: Handle,
  choice: Choice,
  run: (endpoint: Endpoint) => Promise<Awaited<ReturnType<DriverPool["execute"]>>>,
): Promise<Awaited<ReturnType<DriverPool["execute"]>>> {
  tell(handle, { op: choice.op, endpoint: choice.endpoint.name, reason: choice.reason });
  try {
    return await tracked(choice.endpoint, choice.op === "read", () => run(choice.endpoint));
  } catch (error) {
    if (choice.op !== "read" || !isUnreachable(error)) throw error;
    const next = await retryOf(handle, choice);
    if (next === undefined) throw error;
    tell(handle, { op: "read", endpoint: next.endpoint.name, reason: next.reason });
    return tracked(next.endpoint, true, () => run(next.endpoint));
  }
}

/** Chain depth the unreachable check walks. A driver wraps once or twice. */
const CHAIN_DEPTH = 8;

/**
 * Reports whether a read failed because its endpoint refused or dropped the connection (QA-M1).
 *
 * Looks through `cause`, through each entry of an `AggregateError`'s `errors`
 * (one per address on a failed connect), and through nested `code` and `errno`.
 * Bun.sql sends only its own `ERR_POSTGRES_CONNECTION_*` code. A cycle or a chain
 * past {@link CHAIN_DEPTH} stops the walk. Lives here so the startup graph keeps
 * the shallow check.
 *
 * @param error - Caught value
 * @returns True when the next endpoint should be tried
 */
function isUnreachable(error: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (typeof value !== "object" || value === null || depth > CHAIN_DEPTH) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (unreachableNode(value)) return true;
    if (visit(Reflect.get(value, "cause"), depth + 1)) return true;
    const errors: unknown = Reflect.get(value, "errors");
    return Array.isArray(errors) && errors.some((item) => visit(item, depth + 1));
  };
  return visit(error, 0);
}

/**
 * Reports whether one node of the chain is an unreachable connection by its own fields.
 *
 * @param node - One error in the chain
 * @returns True for a connection SQLSTATE, errno or code, a Bun.sql connection code, or a connection message
 */
function unreachableNode(node: object): boolean {
  for (const key of ["sqlstate", "code", "errno"] as const) {
    const code: unknown = Reflect.get(node, key);
    if (typeof code !== "string" || code.length === 0) continue;
    if (isConnectionSqlstate(code) || isConnectionErrno(code)) return true;
    if (code.startsWith("ERR_POSTGRES_CONNECTION_")) return true;
    if (code === "ERR_POSTGRES_IDLE_TIMEOUT" || code === "ERR_POSTGRES_LIFETIME_TIMEOUT") {
      return true;
    }
  }
  if (!(node instanceof Error)) return false;
  return (
    node.message.includes("ECONNREFUSED") ||
    node.message.includes("ECONNRESET") ||
    node.message.includes("CONNECTION_CLOSED") ||
    node.message.includes("terminating connection") ||
    node.message.includes("The pool is closed")
  );
}

/**
 * Counts an in-flight replica statement and times a successful read.
 *
 * The counter moves before the first await so a concurrent choose sees it.
 *
 * @param endpoint - Where the statement runs
 * @param time - Record round-trip time when the call succeeds
 * @param run - The pool call
 * @returns The statement result
 */
async function tracked(
  endpoint: Endpoint,
  time: boolean,
  run: () => Promise<Awaited<ReturnType<DriverPool["execute"]>>>,
): Promise<Awaited<ReturnType<DriverPool["execute"]>>> {
  const replica = endpoint.role === "replica";
  if (replica) endpoint.inflight += 1;
  const started = replica && time ? performance.now() : 0;
  try {
    const result = await run();
    if (replica && time) observe(endpoint, performance.now() - started);
    return result;
  } finally {
    if (replica) endpoint.inflight -= 1;
  }
}

/** The next eligible replica, or the primary when an automatic read may fall back. */
async function retryOf(handle: Handle, choice: Choice): Promise<Choice | undefined> {
  if (choice.endpoint.role === "replica") noteFailure(choice.endpoint);
  const explicit = choice.reason.startsWith("constraint:");
  const gated = await gate(handle, choice.endpoint, !explicit);
  const replica = pick(handle, gated.ready, !explicit);
  if (replica !== undefined) {
    return {
      endpoint: replica,
      op: "read",
      reason: explicit ? "constraint:replica" : `auto:${replica.name}`,
    };
  }
  if (explicit) return undefined;
  if (handle.fallback === "error") fallbackRefused(gated.miss);
  const primary = handle.endpoints[0];
  if (primary === undefined) return undefined;
  return { endpoint: primary, op: "read", reason: `fallback:${gated.miss}` };
}

/**
 * Replicas that can take this read, in config order.
 *
 * Health keeps a closed circuit. Consistency and lag may check a replay
 * position. Capacity skips a saturated pool. `route: "replica"` does not
 * apply capacity. `except` is the replica a connection failure just left.
 * The shared scratch array is cleared before any await.
 *
 * @param handle - Endpoints, watermark, and the reused list
 * @param except - Skip this replica
 * @param capacity - Apply the saturation check
 * @returns The candidates, and why the list is empty
 */
async function gate(
  handle: Handle,
  except: Endpoint | undefined,
  capacity: boolean,
): Promise<{ readonly ready: Endpoint[]; readonly miss: string }> {
  const healthy = takeHealthy(handle, except);
  if (healthy.length === 0) return { ready: healthy, miss: emptyReason(handle, capacity) };
  const lagged = await consistent(handle, healthy);
  if (lagged.length === 0) return { ready: lagged, miss: "behind" };
  if (!capacity) return { ready: lagged, miss: "behind" };
  const room: Endpoint[] = [];
  for (const endpoint of lagged) {
    if (!saturated(endpoint)) room.push(endpoint);
  }
  if (room.length === 0) return { ready: room, miss: "saturated" };
  return { ready: room, miss: "behind" };
}

/**
 * Copies closed-circuit replicas off the shared scratch list.
 *
 * The scratch list is empty again before the caller awaits.
 *
 * @param handle - Endpoints and the reused list
 * @param except - Skip this replica
 * @returns A private list
 */
function takeHealthy(handle: Handle, except: Endpoint | undefined): Endpoint[] {
  const scratch = handle.scratch;
  scratch.length = 0;
  for (const endpoint of handle.endpoints) {
    if (endpoint.role !== "replica" || endpoint === except || endpoint.circuit !== "closed") {
      continue;
    }
    scratch.push(endpoint);
  }
  const copy = scratch.slice();
  scratch.length = 0;
  return copy;
}

/**
 * Consistency and lag.
 *
 * A cached replay position that already satisfies the watermark and `maxLag`
 * needs no round trip. Otherwise one on-demand check runs, through the same
 * seam as the probe, and then the next candidate.
 *
 * @param handle - Watermark, primary position, and `maxLag`
 * @param healthy - Replicas whose circuit is closed. Not the shared scratch list
 * @returns The replicas that satisfy the watermark and `maxLag`
 */
async function consistent(handle: Handle, healthy: Endpoint[]): Promise<Endpoint[]> {
  if (!filters(handle)) return healthy;
  const kept: Endpoint[] = [];
  for (const endpoint of healthy) {
    if (freshEnough(handle, endpoint)) {
      kept.push(endpoint);
      continue;
    }
    if (!endpoint.position) continue;
    try {
      applySample(endpoint, await readPosition(handle, endpoint));
    } catch (error) {
      if (error instanceof OkmError) throw error;
      noteFailure(endpoint);
      continue;
    }
    if (freshEnough(handle, endpoint)) kept.push(endpoint);
  }
  return kept;
}

/** Whether this read has a watermark or a lag ceiling to apply. */
function filters(handle: Handle): boolean {
  if (handle.maxLag !== undefined) return true;
  return handle.consistency === "session" && handle.watermark !== undefined;
}

/** The cached position already satisfies the watermark and `maxLag`. */
function freshEnough(handle: Handle, endpoint: Endpoint): boolean {
  return coversWatermark(handle, endpoint) && coversLag(handle, endpoint);
}

/** A session watermark is met when the cached replay position has reached it. */
function coversWatermark(handle: Handle, endpoint: Endpoint): boolean {
  if (handle.consistency !== "session" || handle.watermark === undefined) return true;
  if (!endpoint.position) return false;
  const replay = endpoint.replayPos;
  if (replay === undefined) return false;
  return replay >= handle.watermark;
}

/** `maxLag` is met. A caught-up replica has lag zero. */
function coversLag(handle: Handle, endpoint: Endpoint): boolean {
  const lag = handle.maxLag;
  if (lag === undefined) return true;
  if (!endpoint.position) return false;
  if (lag.kind === "bytes") {
    const diff = byteLag(handle, endpoint);
    return diff !== null && diff <= lag.bytes;
  }
  const ms = timeLag(handle, endpoint);
  return ms !== null && ms <= lag.ms;
}

/**
 * A pool with no idle connection, at its configured max, and at least one waiter.
 *
 * No `max` means the ceiling is unknown, so the replica is not treated as saturated.
 *
 * @param endpoint - Replica under consideration
 * @returns Whether an automatic read should skip it
 */
function saturated(endpoint: Endpoint): boolean {
  const max = endpoint.max;
  if (max === undefined) return false;
  const stats: DriverStats = endpoint.pool.stats();
  return stats.idle === 0 && stats.waiting > 0 && stats.size >= max;
}

/**
 * Why an automatic read found nobody to run on.
 *
 * @param handle - Configured endpoints
 * @param capacity - Whether saturation counts
 * @returns The `fallback:` suffix
 */
function emptyReason(handle: Handle, capacity: boolean): string {
  let replicas = 0;
  let healthy = 0;
  let room = 0;
  for (const endpoint of handle.endpoints) {
    if (endpoint.role !== "replica") continue;
    replicas += 1;
    if (endpoint.circuit !== "closed") continue;
    healthy += 1;
    if (!capacity || !saturated(endpoint)) room += 1;
  }
  if (replicas === 0) return "no-replicas";
  if (healthy === 0) return "unhealthy";
  if (capacity && room === 0) return "saturated";
  return "unhealthy";
}

/**
 * One replica from `candidates`, using the handle's strategy.
 *
 * A custom function runs only for an automatic read with two or more
 * candidates. One candidate skips the call. Weights are positive: P60 rejects
 * `0` at connect, so `weighted` only sees those.
 *
 * @param handle - Strategy and round-robin cursor
 * @param candidates - Pipeline output, in config order
 * @param automatic - `false` for `route: "replica"` and `using("replica")`
 * @returns The replica, or `undefined` when the pipeline kept none
 */
function pick(
  handle: Handle,
  candidates: readonly Endpoint[],
  automatic: boolean,
): Endpoint | undefined {
  if (candidates.length === 0) return undefined;
  const select = handle.select;
  if (typeof select === "function") {
    if (!automatic || candidates.length < 2) return candidates[0];
    return fromSelect(handle, select, candidates);
  }
  if (select === "roundRobin") return roundRobin(handle, candidates);
  if (select === "leastConnections") return leastConnections(candidates);
  if (select === "latencyAware") return latencyAware(candidates);
  return weighted(handle, candidates);
}

/**
 * Smooth weighted round-robin (nginx).
 *
 * Current weight increases by the configured weight. The largest current
 * weight wins, then loses the total of the weights that took part. A replica
 * that did not take part has its current weight cleared, so a value left over
 * from an earlier round cannot put it first when it becomes eligible again.
 * Equal weights rotate in config order. Every weight is positive.
 *
 * @param handle - Endpoints, including ones the pipeline left out
 * @param candidates - Eligible replicas, at least one
 * @returns The winner
 */
function weighted(handle: Handle, candidates: readonly Endpoint[]): Endpoint {
  const live = new Set(candidates);
  for (const endpoint of handle.endpoints) {
    if (endpoint.role === "replica" && !live.has(endpoint)) endpoint.current = 0;
  }
  const first = candidates[0];
  if (first === undefined) throw new Error("selection saw no candidate");
  let best = first;
  let total = 0;
  for (const endpoint of candidates) {
    endpoint.current += endpoint.weight;
    total += endpoint.weight;
    if (endpoint.current > best.current) best = endpoint;
  }
  best.current -= total;
  return best;
}

/**
 * Next replica after the previous pick, ignoring weights.
 *
 * @param handle - Remembers the previous replica
 * @param candidates - Eligible replicas, in config order
 * @returns The next replica
 */
function roundRobin(handle: Handle, candidates: readonly Endpoint[]): Endpoint {
  const next = after(handle, handle.rrLast, candidates);
  handle.rrLast = next;
  return next;
}

/**
 * The candidate that follows `last` in config order, wrapping around.
 *
 * @param handle - Full endpoint list, primary included
 * @param last - Previous pick. Absent on the first call
 * @param candidates - Who may be chosen now
 * @returns That replica
 */
function after(
  handle: Handle,
  last: Endpoint | undefined,
  candidates: readonly Endpoint[],
): Endpoint {
  const first = candidates[0];
  if (first === undefined) throw new Error("selection saw no candidate");
  if (last === undefined) return first;
  const start = handle.endpoints.indexOf(last);
  if (start === -1) return first;
  for (let step = 1; step <= handle.endpoints.length; step += 1) {
    const endpoint = handle.endpoints[(start + step) % handle.endpoints.length];
    if (endpoint !== undefined && candidates.includes(endpoint)) return endpoint;
  }
  return first;
}

/**
 * Fewest in-flight statements. Ties stay with the earlier replica.
 *
 * @param candidates - Eligible replicas, in config order
 * @returns The replica
 */
function leastConnections(candidates: readonly Endpoint[]): Endpoint {
  let best = candidates[0];
  if (best === undefined) throw new Error("selection saw no candidate");
  for (let index = 1; index < candidates.length; index += 1) {
    const endpoint = candidates[index];
    if (endpoint !== undefined && endpoint.inflight < best.inflight) best = endpoint;
  }
  return best;
}

/**
 * Lowest EWMA. A replica with no sample loses to one that has one.
 * Ties stay with the earlier replica.
 *
 * @param candidates - Eligible replicas, in config order
 * @returns The replica
 */
function latencyAware(candidates: readonly Endpoint[]): Endpoint {
  let best = candidates[0];
  if (best === undefined) throw new Error("selection saw no candidate");
  for (let index = 1; index < candidates.length; index += 1) {
    const endpoint = candidates[index];
    if (endpoint !== undefined && lowerLatency(endpoint, best)) best = endpoint;
  }
  return best;
}

/** `endpoint` has a strictly better sample than `best`. */
function lowerLatency(endpoint: Endpoint, best: Endpoint): boolean {
  if (endpoint.latencyMs === null) return false;
  if (best.latencyMs === null) return true;
  return endpoint.latencyMs < best.latencyMs;
}

/**
 * Runs a custom select. A throw leaves this function unchanged.
 *
 * @param handle - Supplies each candidate's byte lag
 * @param select - The caller's function
 * @param candidates - Two or more replicas
 * @returns The replica it named
 */
function fromSelect(
  handle: Handle,
  select: (
    candidates: readonly ReplicaCandidate[],
    ctx: ReplicaSelectContext,
  ) => ReplicaCandidate | string,
  candidates: readonly Endpoint[],
): Endpoint {
  const endpoints = candidates.slice();
  const offered: ReplicaCandidate[] = [];
  for (const endpoint of endpoints) {
    offered.push({
      name: endpoint.name,
      weight: endpoint.weight,
      inflight: endpoint.inflight,
      latencyMs: endpoint.latencyMs,
      lag: byteLagNumber(handle, endpoint),
    });
  }
  const returned: unknown = select(offered, { op: "read" });
  if (typeof returned === "string") {
    const endpoint = endpoints.find((item) => item.name === returned);
    if (endpoint !== undefined) return endpoint;
  } else if (offered.includes(returned as ReplicaCandidate)) {
    const index = offered.indexOf(returned as ReplicaCandidate);
    const endpoint = endpoints[index];
    if (endpoint !== undefined) return endpoint;
  }
  throw new OkmError(
    "OKM1120",
    `routing.select returned ${shown(returned)}. It must return a candidate or its name.`,
  );
}

/** A short name for a value a custom select returned. */
function shown(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    const name: unknown = Reflect.get(value, "name");
    if (typeof name === "string") return `an object named ${JSON.stringify(name)}`;
    return "an object";
  }
  return typeof value;
}

/** Counts a connection failure toward the circuit. */
function noteFailure(endpoint: Endpoint): void {
  endpoint.failures += 1;
  if (endpoint.failures >= CIRCUIT_AT) endpoint.circuit = "open";
}

/** Drops `route` before a driver sees the options. */
function strip(options: ExecuteOptions | undefined): ExecuteOptions | undefined {
  if (options === undefined || options.route === undefined) return options;
  const { route: _route, ...rest } = options;
  if (rest.signal === undefined && rest.timeout === undefined) return undefined;
  return rest;
}

/** Reads the commit position after a successful write, before the write's promise resolves. */
async function noteWrite(
  handle: Handle,
  runner: { execute(text: string): Promise<ExecuteResult> },
): Promise<void> {
  if (!tracks(handle)) return;
  const primary = handle.endpoints[0];
  if (primary === undefined || !primary.position) {
    markUnknown(handle);
    return;
  }
  try {
    const lsn = await readInsertLsn(runner);
    if (lsn === undefined) {
      markUnknown(handle);
      return;
    }
    raiseWatermark(handle, lsn);
  } catch {
    markUnknown(handle);
  }
}

/** Sets `position unknown` and starts a new generation for in-flight probes. */
function markUnknown(handle: Handle): void {
  handle.positionUnknown = true;
  handle.unknownEpoch += 1;
}

/** Session consistency with replicas configured. `"eventual"` and a lone primary do not track. */
function tracks(handle: Handle): boolean {
  return handle.hasReplicas && handle.consistency === "session";
}

/** `pg_current_wal_insert_lsn()` parsed as a bigint, or `undefined` when the row is empty. */
async function readInsertLsn(runner: {
  execute(text: string): Promise<ExecuteResult>;
}): Promise<bigint | undefined> {
  const result = await runner.execute(INSERT_LSN_SQL);
  const text = result.rows[0]?.[0];
  if (text === null || text === undefined) return undefined;
  return parseLsn(text);
}

/** Moves the primary insert LSN forward. */
function notePrimary(handle: Handle, lsn: bigint): void {
  if (handle.primaryLsn === undefined || lsn > handle.primaryLsn) handle.primaryLsn = lsn;
}

/**
 * Moves the watermark forward and clears `position unknown`.
 *
 * A smaller reading is ignored. The primary insert LSN moves with it.
 *
 * @param handle - Client-wide watermark
 * @param lsn - A position read after a commit, or a recovering primary probe
 */
function raiseWatermark(handle: Handle, lsn: bigint): void {
  notePrimary(handle, lsn);
  if (handle.watermark === undefined || lsn > handle.watermark) handle.watermark = lsn;
  handle.positionUnknown = false;
}

/** Primary insert LSN minus the replica replay LSN. Zero when the replica has caught up. */
function byteLag(handle: Handle, endpoint: Endpoint): bigint | null {
  const primary = handle.primaryLsn;
  const replay = endpoint.replayPos;
  if (primary === undefined || replay === undefined) return null;
  if (replay >= primary) return 0n;
  return primary - replay;
}

/** Byte lag as a number, or `null` when either position is unknown. */
function byteLagNumber(handle: Handle, endpoint: Endpoint): number | null {
  const diff = byteLag(handle, endpoint);
  if (diff === null) return null;
  if (diff > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(diff);
}

/**
 * Time lag in milliseconds.
 *
 * Zero when the replica's replay position has reached the primary. Otherwise
 * the age of the replica's replay timestamp. `null` when that timestamp is unknown.
 *
 * @param handle - Primary insert LSN
 * @param endpoint - Replay position and timestamp
 * @returns The lag, or `null`
 */
function timeLag(handle: Handle, endpoint: Endpoint): number | null {
  const primary = handle.primaryLsn;
  const replay = endpoint.replayPos;
  if (primary === undefined || replay === undefined) return null;
  if (replay >= primary) return 0;
  if (endpoint.replayAt === null) return null;
  const lag = Date.now() - endpoint.replayAt;
  return lag < 0 ? 0 : lag;
}

/** `X/Y` hex LSN as a bigint. Anything else is undefined. */
function parseLsn(text: string): bigint | undefined {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(text.trim());
  const high = match?.[1];
  const low = match?.[2];
  if (high === undefined || low === undefined) return undefined;
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
}

/** A timestamp string as epoch milliseconds. */
function parseTime(text: string): number | undefined {
  const direct = Date.parse(text);
  if (!Number.isNaN(direct)) return direct;
  const iso = Date.parse(text.replace(" ", "T"));
  if (!Number.isNaN(iso)) return iso;
  return undefined;
}

/** `COMMIT`, a full `ROLLBACK`, or anything else (including `ROLLBACK TO`). */
function controlKind(text: string): "commit" | "rollback" | "other" {
  const head = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (/^commit\b/.test(head)) return "commit";
  if (/^rollback\b/.test(head) && !/^rollback\s+to\b/.test(head)) return "rollback";
  return "other";
}

/**
 * Watches a reserved connection.
 *
 * A write inside the transaction is pending until `COMMIT`. The position is
 * read on this connection after that commit succeeds. `ROLLBACK` drops the
 * pending write. `ROLLBACK TO` does not.
 *
 * @param handle - Client-wide watermark
 * @param conn - The reserved connection
 * @returns The connection `tx()` holds
 */
function wrap(handle: Handle, conn: DriverConnection): DriverConnection {
  let pending = false;
  return {
    execute: async (text, params, options) => {
      if (options?.route === "replica") replicaRefused();
      const result = await conn.execute(text, params, strip(options));
      const kind = controlKind(text);
      if (kind === "commit") {
        if (pending) {
          pending = false;
          await noteWrite(handle, conn);
        }
      } else if (kind === "rollback") {
        pending = false;
      } else if (classOf(text) === "write") {
        pending = true;
      }
      return result;
    },
    batch: async (statements, options) => {
      if (options?.route === "replica") replicaRefused();
      const result = await conn.batch(statements, strip(options));
      pending = true;
      return result;
    },
    release: () => conn.release(),
    ...(conn.cancel !== undefined ? { cancel: () => conn.cancel!() } : {}),
  };
}

/** Calls `onRoute`. A throw is ignored. */
function tell(handle: Handle, event: RouteEvent): void {
  if (handle.onRoute === undefined) return;
  try {
    handle.onRoute(event);
  } catch {
    // The listener must not change the operation.
  }
}

/** `"primary"` or `"replica"`. */
function readRoute(route: unknown): RouteName {
  if (route === "primary" || route === "replica") return route;
  throw new OkmError("OKM1120", 'using takes "primary" or "replica".');
}

/** `routing.fallback`. Omitted means the primary absorbs an automatic read. */
function readFallback(value: unknown): "primary" | "error" {
  if (value === undefined || value === "primary") return "primary";
  if (value === "error") return "error";
  throw new OkmError("OKM1120", 'routing.fallback must be "primary" or "error".');
}

/** The root `close()` has already shut the pools. */
function closed(): never {
  throw new OkmError("OKM1120", "The client is closed.");
}

/** OKM1840. A replica cannot run this operation. */
function replicaRefused(): never {
  throw new OkmError("OKM1840", "This operation needs the primary.", {
    fix: {
      summary:
        "Run the operation on the primary. Writes, batch, locks, and tx() never go to a replica.",
    },
  });
}

/** OKM1843. `route: "replica"` does not read the primary. */
function noReplica(): never {
  throw new OkmError("OKM1843", "No replica is eligible. This call does not read the primary.", {
    fix: {
      summary: "Configure a replica or drop the route. This call does not read the primary.",
    },
  });
}

/** OKM1844. An automatic read will not use the primary. */
function fallbackRefused(why: string): never {
  throw new OkmError("OKM1844", `No replica is eligible (${why}) and fallback is error.`, {
    fix: {
      summary:
        "Restore a replica, or set fallback to primary if the primary should absorb the read.",
    },
  });
}

function truth(value: string | null | undefined): boolean {
  return value === "t" || value === "true" || value === "1";
}

function fields(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export default connectTopology;
