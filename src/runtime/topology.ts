/**
 * Primary and replica endpoints (spec §15.1).
 *
 * Loaded only when `connect` is given a topology object. The string and pool
 * paths do not import this module. Until read routing, every operation uses
 * the primary pool. Probes, capability, and pool construction stay here so
 * later routing prompts do not add bytes to `connect`.
 */

import type { DriverPool, DriverTimeouts } from "../contracts/driver.js";
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

const PING_SQL = "select 1";

const LATER_ROUTING = {
  select: "P62",
  consistency: "P63",
  fallback: "P61",
  maxLag: "P63",
} as const;

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
   * `select`, `consistency`, `fallback`, and `maxLag` are refused until the
   * prompts that implement them.
   */
  readonly routing?: {
    readonly probe?: string | number;
    readonly select?: unknown;
    readonly consistency?: unknown;
    readonly fallback?: unknown;
    readonly maxLag?: unknown;
  };
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
  /** Whether `replication.position` was detected. Routing does not read this yet. */
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
  nextDelayMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type Handle = {
  closed: boolean;
  probeMs: number;
  replicaState: ReplicaState | undefined;
  endpoints: Endpoint[];
  closing: Promise<void> | undefined;
};

const handles = new WeakMap<object, Handle>();

/**
 * Opens one pool per endpoint, detects `replication.position`, and starts replica probes.
 *
 * The returned client's queries use the primary. `close()` stops the probes and
 * closes every pool this call opened.
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
): Promise<Connected<S>> {
  refuseRouting(options.routing);
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
    const handle: Handle = {
      closed: false,
      probeMs,
      replicaState: options.replicaState,
      endpoints: opened,
      closing: undefined,
    };
    const replicaEndpoints = opened.filter((endpoint) => endpoint.role === "replica");
    await Promise.all(replicaEndpoints.map((endpoint) => sample(handle, endpoint)));
    for (const endpoint of replicaEndpoints) {
      endpoint.nextDelayMs = delayFor(probeMs, endpoint);
      schedule(handle, endpoint);
    }
    const primary = opened[0];
    if (primary === undefined) {
      throw new OkmError("OKM1120", "A topology needs one primary URL.");
    }
    const client = createClient(
      options.schema,
      gatePrimary(primary.pool, () => closeHandle(handle)),
      {
        ownsPool: true,
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
      },
    );
    handles.set(client, handle);
    return client;
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
    throw new OkmError("OKM1120", "routing must be an object. Accepted key: probe.");
  }
  for (const key of Object.keys(routing)) {
    if (key === "probe") continue;
    const later = LATER_ROUTING[key as keyof typeof LATER_ROUTING];
    if (later !== undefined) {
      throw new OkmError(
        "OKM1061",
        `routing.${key} is not in this version. ${later} adds it. Until then every operation uses the primary.`,
      );
    }
    throw new OkmError("OKM1120", `routing.${key} is not a routing option. Accepted key: probe.`);
  }
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
    nextDelayMs: role === "replica" ? probeMs : 0,
    timer: undefined,
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
    const lsn = await readPosition(handle, endpoint);
    endpoint.failures = 0;
    endpoint.circuit = "closed";
    endpoint.replayLsn = lsn;
  } catch {
    endpoint.failures += 1;
    if (endpoint.failures >= CIRCUIT_AT) endpoint.circuit = "open";
  }
}

async function readPosition(handle: Handle, endpoint: Endpoint): Promise<string | null> {
  const state = handle.replicaState;
  if (state === undefined) {
    const result = await endpoint.pool.execute(HEALTH_SQL);
    return result.rows[0]?.[1] ?? null;
  }
  await endpoint.pool.execute(PING_SQL);
  const lsn = await state.replayLsn({ name: endpoint.name });
  if (typeof lsn !== "string" && lsn !== null) {
    throw new OkmError("OKM1120", "ReplicaState.replayLsn must return a WAL position or null.");
  }
  return lsn;
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

function gatePrimary(primary: DriverPool, close: () => Promise<void>): DriverPool {
  const pool: DriverPool = {
    capabilities: primary.capabilities,
    execute: (text, params, options) => primary.execute(text, params, options),
    batch: (statements, options) => primary.batch(statements, options),
    stats: () => primary.stats(),
    close,
  };
  if (primary.reserve !== undefined) pool.reserve = () => primary.reserve!();
  if (primary.describe !== undefined) {
    pool.describe = (text, params) => primary.describe!(text, params);
  }
  if (primary.stream !== undefined) pool.stream = (text, params) => primary.stream!(text, params);
  if (primary.listen !== undefined) {
    pool.listen = (channel, onNotify) => primary.listen!(channel, onNotify);
  }
  if (primary.cancel !== undefined) pool.cancel = () => primary.cancel!();
  return pool;
}

function truth(value: string | null | undefined): boolean {
  return value === "t" || value === "true" || value === "1";
}

function fields(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export default connectTopology;
