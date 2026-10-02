/**
 * Topology client.
 *
 * `connectTopology` opens one pool per endpoint through the driver adapter,
 * probes health, and routes each operation once. Endpoint selection does not
 * pick a connection. The pool does that, and a transaction keeps the
 * connection it reserved.
 */

import { openPostgresJs } from "../drivers/postgresjs.js";
import { isConnectionLoss } from "../drivers/errors.js";
import type { DriverPool, ExecuteResult, Statement } from "../drivers/types.js";
import { lagBytes, lagTimeMs, parseMaxLag, parseProbe } from "./lag.js";
import {
  openEndpointPool,
  type EndpointPool,
  type HeldConnection,
  type PoolStats,
  type StatementEvent,
} from "./pool.js";
import { applyProbe, initialProbe, type ProbeState } from "./probe.js";
import { decideRoute } from "./route.js";
import { emptyMark, markUnknown, noteCommit, type SessionMark } from "./session.js";
import {
  initialSelectState,
  type Consistency,
  type Decision,
  type EndpointRole,
  type Fallback,
  type OperationKind,
  type ReplicaView,
  type RouteConstraint,
  type RoutingPolicy,
  type SelectFn,
  type SelectName,
  type SelectState,
} from "./types.js";

/** One endpoint passed to `connectTopology`. A string is a URL. */
export type EndpointConfig =
  | string
  | {
      /** Connection URL. */
      readonly url: string;
      /** Stable name. The primary is always `primary`. */
      readonly name?: string | undefined;
      /** Selection weight. Defaults to 1. */
      readonly weight?: number | undefined;
      /** Pool limit for this endpoint. */
      readonly pool?: { readonly max?: number | undefined } | undefined;
    };

/** How to open the topology. */
export type TopologyOptions = {
  /** Primary URL or endpoint. */
  readonly primary: EndpointConfig;
  /** Replica URLs or endpoints. Omitted means every operation uses the primary. */
  readonly replicas?: readonly EndpointConfig[] | undefined;
  /** Routing policy. Omitted keys use the spec defaults. */
  readonly routing?:
    | {
        readonly select?: SelectName | SelectFn | undefined;
        readonly consistency?: Consistency | undefined;
        readonly fallback?: Fallback | undefined;
        readonly maxLag?: string | undefined;
        readonly probe?: string | undefined;
      }
    | undefined;
  /** Acquire timeout in milliseconds. Defaults to 1000. */
  readonly timeouts?: { readonly acquire?: number | undefined } | undefined;
  /** Opens one adapter pool. Defaults to postgres.js. */
  readonly open?: ((url: string) => DriverPool) | undefined;
  /** Random source for the `random` strategy. */
  readonly random?: (() => number) | undefined;
  /** Called with each SQL string and the endpoint that sent it. */
  readonly onStatement?: ((event: StatementEvent) => void) | undefined;
};

/** Result of one routed operation. */
export type CallResult = {
  /** Endpoint and reason. */
  readonly decision: Decision;
  /** One result per statement, in order. */
  readonly results: readonly ExecuteResult[];
  /** Time spent in `decideRoute`, in microseconds. */
  readonly decideUs: number;
};

/** A connection inside `tx()`. Statements share it. */
export type TxConnection = {
  /**
   * Runs one statement on the transaction connection.
   *
   * @param text - SQL
   * @param params - Wire parameters
   * @returns The statement result
   */
  execute(text: string, params?: readonly (string | null)[]): Promise<ExecuteResult>;
  /**
   * Runs statements on a savepoint. A failure rolls back to it.
   *
   * @param statements - Statements in order
   * @returns One result per statement
   */
  batch(statements: readonly Statement[]): Promise<readonly ExecuteResult[]>;
};

/** Result of `tx()`, including the connection identity. */
export type TxResult<T> = CallResult & {
  /** Callback result. */
  readonly value: T;
  /** `pg_backend_pid()` on the reserved connection. */
  readonly pid: string;
  /** `pg_is_in_recovery()` text. */
  readonly recovery: string;
  /** Replica slot name, or empty on the primary. */
  readonly slot: string;
};

/** A read that can require the primary or a replica. */
export class ReadCall {
  private constraint: RouteConstraint = { kind: "auto" };
  private readonly client: TopologyClient;
  private readonly mark: SessionMark;
  private readonly kind: "read" | "internal-read";
  private readonly statements: readonly string[];

  /**
   * @param client - Topology that will run the read
   * @param mark - Session watermark
   * @param kind - Ordinary read or internal read-only transaction
   * @param statements - SQL to run on the chosen endpoint
   */
  constructor(
    client: TopologyClient,
    mark: SessionMark,
    kind: "read" | "internal-read",
    statements: readonly string[],
  ) {
    this.client = client;
    this.mark = mark;
    this.kind = kind;
    this.statements = statements;
  }

  /**
   * Requires the primary.
   *
   * @returns This call
   */
  primary(): this {
    this.constraint = { kind: "primary" };
    return this;
  }

  /**
   * Requires a replica. Session consistency still applies unless opted out.
   *
   * @param options - `eventual` skips the session watermark
   * @returns This call
   */
  replica(options?: { readonly consistency?: Consistency | undefined }): this {
    this.constraint = { kind: "replica", consistency: options?.consistency };
    return this;
  }

  /**
   * Routes the read once and runs every statement on that endpoint.
   *
   * @returns Rows and the decision
   */
  run(): Promise<CallResult> {
    return this.client.run(
      {
        kind: this.kind,
        statements: this.statements.map((text) => ({ text })),
        constraint: this.constraint,
      },
      this.mark,
    );
  }
}

/** Reads, writes, and session watermarks bound to one session. */
export type SessionClient = {
  /** Automatic read, or a constrained one after `.primary()` / `.replica()`. */
  read(sql: string): ReadCall;
  /** Several statements, one endpoint, one connection. */
  readMany(sql: readonly string[]): ReadCall;
  /** Internal read-only transaction. Follows the read's routing. */
  internalRead(sql: readonly string[]): ReadCall;
  /** Committed write on the primary. */
  write(sql: string): Promise<CallResult>;
  /** Atomic batch on the primary. */
  batch(sql: readonly string[]): Promise<CallResult>;
  /** Records a commit position. A lower value does not move the watermark back. */
  noteCommit(lsn: string): void;
  /** The position read failed. Later session reads use the primary. */
  markPositionUnknown(): void;
  /** Current watermark, or null. */
  watermark(): string | null;
  /** Whether the last position read failed. */
  positionUnknown(): boolean;
};

/** Request executed by {@link TopologyClient.run}. */
export type RunRequest = {
  /** Operation class. */
  readonly kind: OperationKind;
  /** Statements. Empty when the test only checks the decision error. */
  readonly statements: readonly Statement[];
  /** Constraint. Defaults to automatic. */
  readonly constraint?: RouteConstraint | undefined;
};

type Slot = {
  readonly pool: EndpointPool;
  probe: ProbeState;
};

const FAILURES_TO_OPEN = 2;

const PRIMARY_PROBE = "SELECT pg_current_wal_insert_lsn()::text";
const REPLICA_PROBE =
  "SELECT pg_last_wal_replay_lsn()::text, EXTRACT(EPOCH FROM pg_last_xact_replay_timestamp())::text";
const IDENTITY =
  "SELECT pg_backend_pid()::text, pg_is_in_recovery()::text, COALESCE((SELECT slot_name FROM pg_stat_wal_receiver LIMIT 1), '')";

/**
 * Opens pools, probes once, and returns the client.
 *
 * @param options - Primary, replicas, and routing policy
 * @returns A client that routes each operation once
 */
export async function connectTopology(options: TopologyOptions): Promise<TopologyClient> {
  const client = new TopologyClient(options);
  try {
    await client.probe();
  } catch (error) {
    await client.close();
    throw error;
  }
  client.startProbes();
  return client;
}

/**
 * Primary, replicas, router, and sessions.
 */
export class TopologyClient implements SessionClient {
  private readonly policy: RoutingPolicy;
  private readonly acquireMs: number;
  private readonly random: () => number;
  private readonly opener: (url: string) => DriverPool;
  private readonly onStatement: ((event: StatementEvent) => void) | undefined;
  private readonly primary: Slot;
  private readonly replicas: Slot[];
  private readonly root = emptyMark();
  private readonly sessions = new Map<string, SessionMark>();
  private selectState: SelectState = initialSelectState();
  private last: Decision | null = null;
  private primaryLsn: string | null = null;
  private primaryPositionCapable = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  /**
   * @param options - Connection and routing options
   */
  constructor(options: TopologyOptions) {
    this.policy = policyFrom(options);
    this.acquireMs = options.timeouts?.acquire ?? 1000;
    this.random = options.random ?? Math.random;
    this.opener = options.open ?? openPostgresJs;
    this.onStatement = options.onStatement;
    this.primary = this.slot(options.primary, "primary", "primary");
    const replicas = options.replicas ?? [];
    const names = new Set<string>(["primary"]);
    this.replicas = replicas.map((config, index) => {
      const name = endpointName(config, `replica-${String(index + 1)}`);
      if (names.has(name)) throw new Error(`Duplicate endpoint name '${name}'.`);
      names.add(name);
      return this.slot(config, name, "replica");
    });
  }

  /**
   * Automatic read of one statement.
   *
   * @param sql - SQL
   * @returns A call that can still take `.primary()` or `.replica()`
   */
  read(sql: string): ReadCall {
    return new ReadCall(this, this.root, "read", [sql]);
  }

  /**
   * Several statements on one endpoint and one connection.
   *
   * @param sql - Statements in order
   * @returns A call that can still take `.primary()` or `.replica()`
   */
  readMany(sql: readonly string[]): ReadCall {
    return new ReadCall(this, this.root, "read", sql);
  }

  /**
   * Internal read-only transaction. It follows this read's routing.
   *
   * @param sql - Statements inside `BEGIN READ ONLY`
   * @returns A call that can still take `.primary()` or `.replica()`
   */
  internalRead(sql: readonly string[]): ReadCall {
    return new ReadCall(this, this.root, "internal-read", sql);
  }

  /**
   * Committed write on the primary.
   *
   * @param sql - One statement inside a transaction
   * @returns The decision and the result
   */
  write(sql: string): Promise<CallResult> {
    return this.run({ kind: "write", statements: [{ text: sql }] }, this.root);
  }

  /**
   * Atomic batch on the primary.
   *
   * @param sql - Statements in order
   * @returns The decision and one result per statement
   */
  batch(sql: readonly string[]): Promise<CallResult> {
    return this.run({ kind: "batch", statements: sql.map((text) => ({ text })) }, this.root);
  }

  /**
   * Locking read on the primary, inside a transaction.
   *
   * @param sql - Statement, including its lock clause
   * @returns The decision and the result
   */
  lockingRead(sql: string): Promise<CallResult> {
    return this.run({ kind: "locking-read", statements: [{ text: sql }] }, this.root);
  }

  /**
   * Transaction-scoped advisory lock on the primary.
   *
   * @param key - Lock key
   * @returns The decision
   */
  advisoryLock(key: number): Promise<CallResult> {
    if (!Number.isSafeInteger(key)) throw new Error("Advisory lock key must be a safe integer.");
    return this.run(
      {
        kind: "advisory-lock",
        statements: [{ text: `SELECT pg_advisory_xact_lock(${String(key)})` }],
      },
      this.root,
    );
  }

  /**
   * User transaction on one primary connection.
   *
   * Savepoints and batches inside the callback use that connection.
   *
   * @param fn - Work bound to the connection
   * @returns The callback value, the decision, and the backend pid
   */
  tx<T>(fn: (connection: TxConnection) => Promise<T>): Promise<TxResult<T>> {
    return this.txOn(this.root, fn);
  }

  /**
   * A named session with its own watermark.
   *
   * @param id - Session key
   * @returns Reads and writes bound to that watermark
   */
  for(id: string): SessionClient {
    return this.bind(this.markFor(id));
  }

  /**
   * The root session. `unscoped()` shares the root watermark.
   *
   * @returns The root session
   */
  unscoped(): SessionClient {
    return this.bind(this.root);
  }

  /** @inheritdoc */
  noteCommit(lsn: string): void {
    noteCommit(this.root, lsn);
  }

  /** @inheritdoc */
  markPositionUnknown(): void {
    markUnknown(this.root);
  }

  /** @inheritdoc */
  watermark(): string | null {
    return this.root.lsn;
  }

  /** @inheritdoc */
  positionUnknown(): boolean {
    return this.root.unknown;
  }

  /**
   * Routes and runs an operation on the root session.
   *
   * Primary-required kinds reject `.replica()` with OKM1840 before any SQL.
   *
   * @param request - Kind, statements, and constraint
   * @returns The decision and results
   */
  run(request: RunRequest): Promise<CallResult>;
  /**
   * Routes and runs an operation on one session.
   *
   * @param request - Kind, statements, and constraint
   * @param mark - Session watermark
   * @returns The decision and results
   */
  run(request: RunRequest, mark: SessionMark): Promise<CallResult>;
  run(request: RunRequest, mark: SessionMark = this.root): Promise<CallResult> {
    return this.dispatch(request, mark);
  }

  /**
   * Last decision, for `inspect()`.
   *
   * @returns The decision, or null before the first operation
   */
  inspect(): Decision | null {
    return this.last;
  }

  /**
   * Probes every endpoint.
   *
   * A replica that fails the position read and answers `SELECT 1` stays
   * healthy and loses position capability.
   */
  async probe(): Promise<void> {
    await this.probeSlot(this.primary, "primary");
    if (!this.primary.probe.healthy) throw new Error("Primary probe failed.");
    this.primaryLsn = this.primary.probe.replayLsn;
    this.primaryPositionCapable = this.primary.probe.positionCapable;
    for (const replica of this.replicas) await this.probeSlot(replica, "replica");
  }

  /**
   * Reserves a connection from one endpoint.
   *
   * The caller releases it. This does not route.
   *
   * @param name - Endpoint name
   * @param timeoutMs - Acquire timeout. Defaults to the client timeout
   * @returns The reserved connection
   */
  acquire(name: string, timeoutMs = this.acquireMs): Promise<HeldConnection> {
    return this.poolByName(name).acquire(timeoutMs);
  }

  /**
   * Pool counters for one endpoint.
   *
   * @param name - Endpoint name
   * @returns Size, idle, in-flight, and waiting
   */
  stats(name: string): PoolStats {
    return this.poolByName(name).stats();
  }

  /** Closes every pool and stops probes. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.primary.pool.close();
    for (const replica of this.replicas) await replica.pool.close();
  }

  /** Starts the background probe when the interval is non-zero. */
  startProbes(): void {
    if (this.policy.probeMs <= 0 || this.closed) return;
    const timer = setInterval(() => {
      void this.probe().catch(() => undefined);
    }, this.policy.probeMs);
    this.timer = timer;
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      const unref = Reflect.get(timer, "unref");
      if (typeof unref === "function") unref.call(timer);
    }
  }

  /**
   * Position read after a committed write, on the committing connection.
   *
   * The routing spike leaves this empty. The commit-position spike fills it.
   *
   * @param _held - Connection that just committed
   * @param _mark - Session that owns the write
   * @param _kind - Operation class
   */
  async rememberCommit(
    _held: HeldConnection,
    _mark: SessionMark,
    _kind: OperationKind,
  ): Promise<void> {}

  private bind(mark: SessionMark): SessionClient {
    return {
      read: (sql) => new ReadCall(this, mark, "read", [sql]),
      readMany: (sql) => new ReadCall(this, mark, "read", sql),
      internalRead: (sql) => new ReadCall(this, mark, "internal-read", sql),
      write: (sql) => this.run({ kind: "write", statements: [{ text: sql }] }, mark),
      batch: (sql) => this.run({ kind: "batch", statements: sql.map((text) => ({ text })) }, mark),
      noteCommit: (lsn) => {
        noteCommit(mark, lsn);
      },
      markPositionUnknown: () => {
        markUnknown(mark);
      },
      watermark: () => mark.lsn,
      positionUnknown: () => mark.unknown,
    };
  }

  private async dispatch(request: RunRequest, mark: SessionMark): Promise<CallResult> {
    const masked = new Set<string>();
    let rerouted = false;
    let previous: unknown;
    for (;;) {
      const started = performance.now();
      const choice = decideRoute(this.routeInput(request, mark, masked));
      this.selectState = choice.state;
      this.last = choice.decision;
      const decideUs = (performance.now() - started) * 1000;
      if (masked.has(choice.decision.endpoint)) {
        if (previous instanceof Error) throw previous;
        throw new Error("No remaining endpoint.");
      }
      const pool = this.poolByName(choice.decision.endpoint);
      let held: HeldConnection | undefined;
      let produced = false;
      try {
        held = await pool.acquire(this.acquireMs);
        const results = await this.executeOn(held, request, mark, () => {
          produced = true;
        });
        return { decision: choice.decision, results, decideUs };
      } catch (error) {
        if (!produced && !rerouted && isConnectionLoss(error)) {
          rerouted = true;
          previous = error;
          masked.add(choice.decision.endpoint);
          continue;
        }
        throw error;
      } finally {
        held?.release();
      }
    }
  }

  private async txOn<T>(
    mark: SessionMark,
    fn: (connection: TxConnection) => Promise<T>,
  ): Promise<TxResult<T>> {
    const masked = new Set<string>();
    let rerouted = false;
    let previous: unknown;
    const request: RunRequest = { kind: "tx", statements: [], constraint: { kind: "auto" } };
    for (;;) {
      const started = performance.now();
      const choice = decideRoute(this.routeInput(request, mark, masked));
      this.selectState = choice.state;
      this.last = choice.decision;
      const decideUs = (performance.now() - started) * 1000;
      if (masked.has(choice.decision.endpoint)) {
        if (previous instanceof Error) throw previous;
        throw new Error("No remaining endpoint.");
      }
      const pool = this.poolByName(choice.decision.endpoint);
      let held: HeldConnection | undefined;
      try {
        held = await pool.acquire(this.acquireMs);
        await held.execute("BEGIN");
        try {
          const identity = await held.execute(IDENTITY);
          const value = await fn({
            execute: (text, params) =>
              held?.execute(text, params) ?? Promise.reject(new Error("released")),
            batch: (statements) =>
              held?.savepointBatch(statements) ?? Promise.reject(new Error("released")),
          });
          await held.execute("COMMIT");
          await this.rememberCommit(held, mark, "tx");
          const row = identity.rows[0];
          return {
            value,
            decision: choice.decision,
            results: [identity],
            decideUs,
            pid: row?.[0] ?? "",
            recovery: row?.[1] ?? "",
            slot: row?.[2] ?? "",
          };
        } catch (error) {
          await held.execute("ROLLBACK").catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (held === undefined && !rerouted && isConnectionLoss(error)) {
          rerouted = true;
          previous = error;
          masked.add(choice.decision.endpoint);
          continue;
        }
        throw error;
      } finally {
        held?.release();
      }
    }
  }

  private async executeOn(
    held: HeldConnection,
    request: RunRequest,
    mark: SessionMark,
    produced: () => void,
  ): Promise<readonly ExecuteResult[]> {
    if (request.kind === "batch") {
      const results = [...(await held.batch(request.statements))];
      if (request.statements.length > 0) produced();
      await this.rememberCommit(held, mark, request.kind);
      return results;
    }
    if (request.kind === "read") {
      const results: ExecuteResult[] = [];
      for (const statement of request.statements) {
        results.push(await held.execute(statement.text, statement.params));
        produced();
      }
      return results;
    }
    const begin = request.kind === "internal-read" ? "BEGIN READ ONLY" : "BEGIN";
    await held.execute(begin);
    const results: ExecuteResult[] = [];
    try {
      for (const statement of request.statements) {
        results.push(await held.execute(statement.text, statement.params));
        produced();
      }
      await held.execute("COMMIT");
    } catch (error) {
      await held.execute("ROLLBACK").catch(() => undefined);
      throw error;
    }
    if (request.kind !== "internal-read") await this.rememberCommit(held, mark, request.kind);
    return results;
  }

  private routeInput(request: RunRequest, mark: SessionMark, masked: ReadonlySet<string>) {
    return {
      kind: request.kind,
      constraint: request.constraint ?? { kind: "auto" as const },
      policy: this.policy,
      replicas: this.views(masked),
      watermark: mark.lsn,
      positionUnknown: mark.unknown,
      positionCapable: this.primaryPositionCapable,
      state: this.selectState,
      random: this.random,
    };
  }

  private views(masked: ReadonlySet<string>): readonly ReplicaView[] {
    const now = Date.now();
    return this.replicas.map((replica) => {
      const stats = replica.pool.stats();
      const bytes = lagBytes(this.primaryLsn, replica.probe.replayLsn);
      const ms = lagTimeMs(bytes, replica.probe.replayedAtMs, now);
      return {
        name: replica.pool.name,
        weight: replica.pool.weight,
        healthy: replica.probe.healthy && !masked.has(replica.pool.name),
        circuitOpen: replica.probe.circuitOpen,
        replayLsn: replica.probe.replayLsn,
        lagBytes: bytes,
        lagMs: ms,
        inflight: stats.inflight,
        waiting: stats.waiting,
        idle: stats.idle,
        saturated: stats.idle === 0,
        latencyMs: replica.probe.latencyMs,
        positionCapable: replica.probe.positionCapable,
      };
    });
  }

  private async probeSlot(slot: Slot, role: EndpointRole): Promise<void> {
    const sample = await sampleEndpoint(slot.pool, role);
    slot.probe = applyProbe(slot.probe, sample, Date.now(), FAILURES_TO_OPEN);
  }

  private poolByName(name: string): EndpointPool {
    if (name === "primary") return this.primary.pool;
    const found = this.replicas.find((replica) => replica.pool.name === name);
    if (found === undefined) throw new Error(`Unknown endpoint '${name}'.`);
    return found.pool;
  }

  private markFor(id: string): SessionMark {
    const found = this.sessions.get(id);
    if (found !== undefined) return found;
    const created = emptyMark();
    this.sessions.set(id, created);
    return created;
  }

  private slot(config: EndpointConfig, fallback: string, role: EndpointRole): Slot {
    const url = typeof config === "string" ? config : config.url;
    const name = role === "primary" ? "primary" : endpointName(config, fallback);
    const weight = typeof config === "string" ? 1 : Math.max(1, config.weight ?? 1);
    const max = typeof config === "string" ? 4 : (config.pool?.max ?? 4);
    const driver = this.opener(url);
    return {
      pool: openEndpointPool({
        name,
        role,
        weight,
        max,
        driver,
        onStatement: this.onStatement,
      }),
      probe: initialProbe(Date.now(), this.policy.probeMs),
    };
  }
}

async function sampleEndpoint(
  pool: EndpointPool,
  role: EndpointRole,
): Promise<{
  ok: boolean;
  replayLsn: string | null;
  replayedAtMs: number | null;
  latencyMs: number;
  positionCapable: boolean;
}> {
  const started = performance.now();
  try {
    const result = await pool.query(role === "primary" ? PRIMARY_PROBE : REPLICA_PROBE);
    const latencyMs = performance.now() - started;
    const lsn = result.rows[0]?.[0] ?? null;
    const epoch = result.rows[0]?.[1];
    const replayedAtMs =
      epoch === null || epoch === undefined || epoch === "" ? null : Number(epoch) * 1000;
    return {
      ok: true,
      replayLsn: lsn === "" ? null : lsn,
      replayedAtMs: Number.isFinite(replayedAtMs) ? replayedAtMs : null,
      latencyMs,
      positionCapable: true,
    };
  } catch {
    try {
      await pool.query("SELECT 1");
      return {
        ok: true,
        replayLsn: null,
        replayedAtMs: null,
        latencyMs: performance.now() - started,
        positionCapable: false,
      };
    } catch {
      return {
        ok: false,
        replayLsn: null,
        replayedAtMs: null,
        latencyMs: performance.now() - started,
        positionCapable: false,
      };
    }
  }
}

function policyFrom(options: TopologyOptions): RoutingPolicy {
  const routing = options.routing;
  return {
    select: routing?.select ?? "weighted",
    consistency: routing?.consistency ?? "session",
    fallback: routing?.fallback ?? "primary",
    maxLag: routing?.maxLag === undefined ? null : parseMaxLag(routing.maxLag),
    probeMs: routing?.probe === undefined ? 1000 : parseProbe(routing.probe),
  };
}

function endpointName(config: EndpointConfig, fallback: string): string {
  if (typeof config === "string") return fallback;
  return config.name ?? fallback;
}
