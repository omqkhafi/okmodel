/**
 * Level-triggered `watch`.
 *
 * NOTIFY is a hint. The handler runs at start, after a wake, after reconnect,
 * and at least every `every`. A live read calls `find` on the same session
 * and invokes the handler when the hashed rows differ from the last run that
 * finished. Identical reads in one process share one query per wake.
 *
 * The listen connection, the heartbeat, and the reconnect live in one hub per
 * process and URL. A driver without a push mark, a failed delivery self-test,
 * or a lost socket degrades to `poll` and warns once.
 */

import type { DriverPool, ExecuteResult } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import { sha256 } from "../contracts/sha256.js";
import { PUSH_DRIVER } from "../adapters/capabilities.js";
import { watchChannel } from "../dialects/pg/watch-channel.js";
import { openRegisteredListen, runRead, type ListenSocket, type Session } from "./client.js";
import type { CallScope } from "./plan.js";
import type { WatchOptions, WatchState, WatchStats, WatchSubscription } from "./types.js";

/** How long a delivery self-test waits for its private ping. */
const SELF_TEST_MS = 800;

/** Heartbeat interval on the listen connection. */
const HEARTBEAT_MS = 30_000;

/** A heartbeat that takes longer than this drops the socket. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

/** Default maximum lag. */
const EVERY_DEFAULT_MS = 30_000;

/** `every` cannot be shorter than this, and cannot be turned off. */
const EVERY_MIN_MS = 1_000;

const FIND_KEYS = new Set([
  "where",
  "select",
  "orderBy",
  "include",
  "ignore",
  "computed",
  "limit",
  "offset",
  "search",
  "distinct",
  "distinctOn",
  "lock",
  "wait",
]);

type Live = {
  readonly query: Record<string, unknown>;
  readonly handler: (rows: unknown) => unknown;
};

type Wake = {
  readonly handler: () => unknown;
};

type Parsed = {
  readonly live: Live | undefined;
  readonly wake: Wake | undefined;
  readonly channel: string | undefined;
  readonly options: WatchOptions;
};

type Counts = { runs: number; errors: number; wakes: number; queries: number };

type Hub = {
  readonly key: string;
  readonly url: string | undefined;
  readonly pool: DriverPool;
  readonly kind: 1 | 2 | 3 | undefined;
  socket: ListenSocket | undefined;
  mode: "push" | "poll";
  readonly channels: Map<string, Set<(payload: string) => void>>;
  readonly subs: Set<Registration>;
  heart: ReturnType<typeof setInterval> | undefined;
  connecting: Promise<{ readonly ok: boolean; readonly reason: string }> | undefined;
  attempt: number;
  generation: number;
  closed: boolean;
  proof: { readonly ok: boolean; readonly reason: string } | undefined;
};

type Registration = {
  readonly channel: string;
  readonly token: string | undefined;
  readonly kick: () => void;
  readonly counts: Counts;
  on: boolean;
};

const hubs = new Map<string, Hub>();
const flights = new Map<string, Promise<unknown>>();
const poolIds = new WeakMap<DriverPool, number>();
let poolSeq = 1;
let warned = false;

/**
 * Starts a table watch or a signal watch.
 *
 * `table` is the model name. Absent, `args` is a signal channel. The handle
 * is synchronous. The first run and the delivery self-test happen in the
 * background. `run()` awaits them.
 *
 * @param session - The client the caller used, including its scope
 * @param table - Table name, or `undefined` for `db.watch(channel)`
 * @param args - The arguments the method received
 * @returns The subscription
 */
export function startWatch(
  session: Session,
  table: string | undefined,
  args: readonly unknown[],
): WatchSubscription {
  const parsed = parseArgs(table, args);
  return openSubscription(session, table, parsed);
}

/**
 * Resolves with the first matching row, or rejects when `timeout` elapses.
 *
 * The read is a `find` on the same session. `limit` defaults to 1. A missing
 * row waits for a wake or for the one-second floor. The timeout is kind
 * `timeout`.
 *
 * @param session - The client the caller used
 * @param table - Table name
 * @param args - The query, then `{ timeout, signal }`
 * @returns The first row
 */
export function tableUntil(
  session: Session,
  table: string,
  args: readonly unknown[],
): Promise<unknown> {
  const query = isRecord(args[0]) ? args[0] : undefined;
  if (query === undefined) fail("OKM1121", "until() needs find() options.");
  const extra = isRecord(args[1]) ? args[1] : {};
  const timeoutMs = extra.timeout === undefined ? undefined : durationMs(extra.timeout, "timeout");
  if (timeoutMs === undefined) fail("OKM1121", "until() needs a timeout.");
  const signal = extra.signal instanceof AbortSignal ? extra.signal : undefined;
  const limited = query.limit === undefined ? { ...query, limit: 1 } : query;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void sub.stop();
      run();
    };
    const sub = openSubscription(session, table, {
      live: {
        query: limited,
        handler: (rows) => {
          if (Array.isArray(rows) && rows.length > 0) finish(() => resolve(rows[0]));
        },
      },
      wake: undefined,
      channel: undefined,
      options: {
        every: EVERY_MIN_MS,
        ...(signal !== undefined ? { signal } : {}),
        onError: (error) => finish(() => reject(error)),
      },
    });
    const timer = setTimeout(() => {
      finish(() => reject(new OkmError("timeout", "watch until timed out.", { kind: "timeout" })));
    }, timeoutMs);
    if (signal?.aborted === true) {
      finish(() =>
        reject(new OkmError("cancelled", "watch until was aborted.", { kind: "cancelled" })),
      );
    }
  });
}

/**
 * Delivery self-test and notification-queue fraction for `okm doctor`.
 *
 * The text does not include the host. The socket is closed before this returns.
 *
 * @param pool - A pool that can run `pg_notify`
 * @param url - Direct URL, when the driver needs one
 * @returns Whether a private ping came back, why, and the queue fraction
 */
export async function explainDelivery(
  pool: DriverPool,
  url: string | undefined,
): Promise<{ readonly ok: boolean; readonly reason: string; readonly queue: number | undefined }> {
  const queue = await readQueue(pool);
  const kind = pushKind(pool);
  if (kind === undefined) {
    return { ok: false, reason: "this driver does not keep a listen connection", queue };
  }
  if (kind !== 3 && (url === undefined || url.length === 0)) {
    return { ok: false, reason: "no direct URL for listen", queue };
  }
  const channel = pingChannel();
  let socket: ListenSocket | undefined;
  try {
    let got = false;
    socket = await openSocket(
      kind,
      url,
      pool,
      (name) => {
        if (name === channel) got = true;
      },
      () => undefined,
    );
    await socket.listen(channel);
    await notify(pool, channel);
    const ok = await waitUntil(() => got, SELF_TEST_MS);
    return {
      ok,
      reason: ok ? "a private ping was delivered" : "the delivery self-test received nothing",
      queue,
    };
  } catch (error) {
    return { ok: false, reason: publicReason(error, url), queue };
  } finally {
    await socket?.close().catch(() => undefined);
  }
}

/**
 * The doctor line for a notification queue at or above half.
 *
 * @param usage - `pg_notification_queue_usage()`, when the read succeeded
 * @returns The warning, or `undefined` under one half
 */
export function queueWarning(usage: number | undefined): string | undefined {
  if (usage === undefined || !Number.isFinite(usage) || usage < 0.5) return undefined;
  return "OKM2212: pg_notification_queue_usage is at least half full.";
}

function openSubscription(
  session: Session,
  table: string | undefined,
  parsed: Parsed,
): WatchSubscription {
  const options = parsed.options;
  const everyMs =
    options.every === undefined ? EVERY_DEFAULT_MS : durationMs(options.every, "every");
  if (everyMs < EVERY_MIN_MS) {
    fail("OKM1121", "watch every must be at least 1s and cannot be disabled.");
  }
  const throttleMs = options.throttle === undefined ? 0 : durationMs(options.throttle, "throttle");
  if (throttleMs < 0) fail("OKM1121", "watch throttle must be at least 0.");
  const counts: Counts = { runs: 0, errors: 0, wakes: 0, queries: 0 };
  const model = table === undefined ? undefined : session.schema.model[table]?.watch;
  const wantsPush = parsed.channel !== undefined || model?.push !== false;
  const required = options.push === "required";
  let stopped = false;
  let running = false;
  let again = false;
  let last = 0;
  let done: string | undefined;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let registration: Registration | undefined;
  const channel =
    parsed.channel ??
    (table === undefined ? undefined : watchChannel(session.schema.model[table]?.sql ?? table));
  const token = tenantToken(session.scope, model?.tenant);
  const hub = wantsPush ? hubFor(session) : undefined;

  const invoke = async (): Promise<void> => {
    counts.runs += 1;
    try {
      if (parsed.live !== undefined && table !== undefined) {
        const key = flightKey(session, table, parsed.live.query);
        const rows = await sharedRead(key, () => {
          counts.queries += 1;
          return runRead(session, table, parsed.live?.query ?? {});
        });
        const hash = sha256(stable(rows));
        if (hash === done) return;
        await parsed.live.handler(rows);
        done = hash;
        return;
      }
      await parsed.wake?.handler();
    } catch (error) {
      counts.errors += 1;
      try {
        options.onError?.(error);
      } catch {
        // A throwing onError stays on the subscription. It does not escape.
      }
    }
  };

  const drain = (): Promise<void> => {
    if (running) return chain;
    running = true;
    chain = (async () => {
      do {
        again = false;
        last = Date.now();
        await invoke();
        if (again && throttleMs > 0 && !stopped) await sleep(throttleMs);
      } while (again && !stopped);
    })().finally(() => {
      running = false;
    });
    return chain;
  };

  const schedule = (): Promise<void> => {
    if (stopped) return chain;
    if (running) {
      again = true;
      return chain;
    }
    if (waiting !== undefined) return chain;
    const wait = last === 0 || throttleMs === 0 ? 0 : Math.max(0, throttleMs - (Date.now() - last));
    if (wait === 0) return drain();
    chain = new Promise((resolve) => {
      waiting = setTimeout(() => {
        waiting = undefined;
        resolve(drain());
      }, wait);
    });
    return chain;
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (waiting !== undefined) clearTimeout(waiting);
    waiting = undefined;
    clearInterval(timer);
    if (registration !== undefined && hub !== undefined) {
      forget(hub, registration);
      registration = undefined;
    }
  };

  if (hub !== undefined && channel !== undefined) {
    registration = {
      channel,
      token,
      counts,
      on: true,
      kick: () => {
        void schedule();
      },
    };
    remember(hub, registration);
  }

  const timer = setInterval(() => {
    void schedule();
  }, everyMs);

  let first: Promise<void> | undefined;
  const started = (async () => {
    await schedule();
    if (hub === undefined) return;
    const proof = await (hub.connecting ??
      Promise.resolve(hub.proof ?? { ok: false, reason: "push was not opened" }));
    if (required && !proof.ok && !stopped) {
      await stop();
      throw new OkmError(
        "OKM1934",
        `watch push is required, and this URL cannot deliver notifications (${proof.reason}).`,
        { kind: "unavailable" },
      );
    }
  })();
  first = started;
  started.catch((error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Same as a handler error: it stays here.
    }
  });

  options.signal?.addEventListener(
    "abort",
    () => {
      void stop();
    },
    { once: true },
  );

  const handle = {
    get state(): WatchState {
      if (stopped) return "stopped";
      if (hub?.mode === "push") return "push";
      return "poll";
    },
    get stats(): WatchStats {
      return { ...counts };
    },
    run: () => {
      const current = first;
      first = undefined;
      return current ?? schedule();
    },
    stop,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
  return handle;
}

function hubFor(session: Session): Hub {
  const pool = innerPool(session.pool);
  const kind = pushKind(pool);
  const url = session.listenUrl;
  const key = kind === 3 ? `pglite:${poolId(pool)}` : `${String(kind ?? 0)}:${url ?? ""}`;
  const found = hubs.get(key);
  if (found !== undefined && !found.closed) return found;
  const hub: Hub = {
    key,
    url,
    pool,
    kind,
    socket: undefined,
    mode: "poll",
    channels: new Map(),
    subs: new Set(),
    heart: undefined,
    connecting: undefined,
    attempt: 0,
    generation: 0,
    closed: false,
    proof: undefined,
  };
  hubs.set(key, hub);
  hub.connecting = connectHub(hub);
  return hub;
}

async function connectHub(hub: Hub): Promise<{ readonly ok: boolean; readonly reason: string }> {
  const generation = hub.generation;
  if (
    hub.kind === undefined ||
    (hub.kind !== 3 && (hub.url === undefined || hub.url.length === 0))
  ) {
    const reason =
      hub.kind === undefined
        ? "this driver does not keep a listen connection"
        : "no direct URL for listen";
    hub.proof = { ok: false, reason };
    hub.mode = "poll";
    warnOnce(reason);
    return hub.proof;
  }
  const reconnecting = hub.attempt > 0 || hub.generation > 0;
  try {
    const socket = await openSocket(
      hub.kind,
      hub.url,
      hub.pool,
      (channel, payload) => {
        deliver(hub, channel, payload);
      },
      () => {
        if (hub.generation !== generation) return;
        lose(hub, "the listen connection closed");
      },
    );
    if (hub.closed || hub.generation !== generation) {
      await socket.close().catch(() => undefined);
      return hub.proof ?? { ok: false, reason: "the listen connection closed" };
    }
    hub.socket = socket;
    for (const channel of hub.channels.keys()) await socket.listen(channel);
    const proof = await prove(hub, socket);
    if (hub.generation !== generation) return proof;
    hub.proof = proof;
    hub.mode = proof.ok ? "push" : "poll";
    if (!proof.ok) warnOnce(proof.reason);
    else hub.attempt = 0;
    armHeart(hub);
    if (proof.ok && reconnecting) kickAll(hub);
    return proof;
  } catch (error) {
    const reason = publicReason(error, hub.url);
    hub.proof = { ok: false, reason };
    hub.mode = "poll";
    warnOnce(reason);
    await hub.socket?.close().catch(() => undefined);
    hub.socket = undefined;
    if (!hub.closed && !listenRefused(error)) scheduleReconnect(hub);
    return hub.proof;
  }
}

async function prove(
  hub: Hub,
  socket: ListenSocket,
): Promise<{ readonly ok: boolean; readonly reason: string }> {
  const channel = pingChannel();
  let got = false;
  const previous = hub.channels.get(channel);
  hub.channels.set(
    channel,
    new Set([
      (payload) => {
        void payload;
        got = true;
      },
    ]),
  );
  try {
    await socket.listen(channel);
    await notify(hub.pool, channel);
    const ok = await waitUntil(() => got, SELF_TEST_MS);
    return {
      ok,
      reason: ok ? "a private ping was delivered" : "the delivery self-test received nothing",
    };
  } finally {
    if (previous === undefined) hub.channels.delete(channel);
    else hub.channels.set(channel, previous);
    await socket
      .query(`UNLISTEN ${quoteIdent(channel)}`, HEARTBEAT_TIMEOUT_MS)
      .catch(() => undefined);
  }
}

function deliver(hub: Hub, channel: string, payload: string): void {
  const listeners = hub.channels.get(channel);
  if (listeners === undefined) return;
  for (const listener of listeners) listener(payload);
}

function remember(hub: Hub, registration: Registration): void {
  hub.subs.add(registration);
  let listeners = hub.channels.get(registration.channel);
  if (listeners === undefined) {
    listeners = new Set();
    hub.channels.set(registration.channel, listeners);
    const socket = hub.socket;
    if (socket !== undefined) void socket.listen(registration.channel).catch(() => undefined);
  }
  listeners.add((payload) => {
    if (!registration.on || !relevant(payload, registration.token)) return;
    registration.counts.wakes += 1;
    registration.kick();
  });
}

function forget(hub: Hub, registration: Registration): void {
  registration.on = false;
  hub.subs.delete(registration);
  const still = [...hub.subs].some((item) => item.channel === registration.channel);
  if (!still) {
    hub.channels.delete(registration.channel);
    const socket = hub.socket;
    if (socket !== undefined) {
      void socket
        .query(`UNLISTEN ${quoteIdent(registration.channel)}`, 1_000)
        .catch(() => undefined);
    }
  }
  if (hub.subs.size > 0) return;
  hub.closed = true;
  hubs.delete(hub.key);
  if (hub.heart !== undefined) clearInterval(hub.heart);
  const socket = hub.socket;
  hub.socket = undefined;
  void socket?.close().catch(() => undefined);
}

function lose(hub: Hub, reason: string): void {
  if (hub.closed) return;
  hub.mode = "poll";
  hub.generation += 1;
  warnOnce(reason);
  if (hub.heart !== undefined) clearInterval(hub.heart);
  hub.heart = undefined;
  const socket = hub.socket;
  hub.socket = undefined;
  void socket?.close().catch(() => undefined);
  scheduleReconnect(hub);
}

function scheduleReconnect(hub: Hub): void {
  const wait = Math.min(5_000, 200 * 2 ** hub.attempt) + Math.floor(Math.random() * 100);
  hub.attempt += 1;
  setTimeout(() => {
    if (hub.closed) return;
    hub.connecting = connectHub(hub);
  }, wait);
}

function armHeart(hub: Hub): void {
  if (hub.heart !== undefined) clearInterval(hub.heart);
  const generation = hub.generation;
  hub.heart = setInterval(() => {
    const socket = hub.socket;
    if (socket === undefined || hub.generation !== generation) return;
    void socket.query("select 1", HEARTBEAT_TIMEOUT_MS).catch(() => {
      if (hub.generation === generation) lose(hub, "the listen heartbeat timed out");
    });
  }, HEARTBEAT_MS);
}

function kickAll(hub: Hub): void {
  for (const registration of hub.subs) registration.kick();
}

async function openSocket(
  kind: 1 | 2 | 3,
  url: string | undefined,
  pool: DriverPool,
  onNotify: (channel: string, payload: string) => void,
  onLost: (error: unknown) => void,
): Promise<ListenSocket> {
  if (kind === 3) return openPglite(pool, onNotify);
  if (url === undefined) throw new Error("no direct URL for listen");
  return openRegisteredListen(kind, url, onNotify, onLost);
}

function openPglite(
  pool: DriverPool,
  onNotify: (channel: string, payload: string) => void,
): ListenSocket {
  const stops = new Map<string, () => Promise<void>>();
  return {
    async listen(channel) {
      if (stops.has(channel) || pool.listen === undefined) return;
      const stop = await pool.listen(channel, (payload) => onNotify(channel, payload));
      stops.set(channel, stop);
    },
    async query(text, timeoutMs) {
      await withTimeout(
        pool.execute(text, []).then(() => undefined),
        timeoutMs,
      );
    },
    async close() {
      for (const stop of stops.values()) await stop().catch(() => undefined);
      stops.clear();
    },
  };
}

function relevant(payload: string, token: string | undefined): boolean {
  if (token === undefined || payload.length === 0) return true;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!Array.isArray(parsed)) return true;
    return parsed.some((item) => String(item) === token);
  } catch {
    return true;
  }
}

function tenantToken(
  scope: CallScope | undefined,
  fields: readonly string[] | undefined,
): string | undefined {
  if (scope === undefined || fields === undefined || fields.length === 0 || "unscoped" in scope) {
    return undefined;
  }
  if (fields.length === 1) return scope.value;
  const values = scope.values ?? {};
  return fields
    .map((field, index) => values[field] ?? (index === 0 ? scope.value : ""))
    .join("\u001f");
}

function parseArgs(table: string | undefined, args: readonly unknown[]): Parsed {
  if (table === undefined) {
    const channel = args[0];
    const handler = args[1];
    if (typeof channel !== "string") fail("OKM1121", "watch() needs a channel name.");
    assertChannel(channel);
    if (typeof handler !== "function") fail("OKM1121", "watch() needs a function.");
    return {
      live: undefined,
      wake: { handler: handler as () => unknown },
      channel,
      options: readOptions(args[2]),
    };
  }
  const first = args[0];
  const second = args[1];
  const third = args[2];
  if (typeof first === "function") {
    return {
      live: undefined,
      wake: { handler: first as () => unknown },
      channel: undefined,
      options: readOptions(second),
    };
  }
  if (!isRecord(first)) fail("OKM1121", "watch() needs a function or find() options.");
  if (typeof second === "function" && typeof third === "function") {
    fail("OKM1121", "watch() takes one function.");
  }
  if (typeof third === "function") {
    if (!isRecord(second)) fail("OKM1121", "watch() options must be an object.");
    return {
      live: { query: first, handler: third as (rows: unknown) => unknown },
      wake: undefined,
      channel: undefined,
      options: readOptions(second),
    };
  }
  if (typeof second !== "function") fail("OKM1121", "watch() needs a function.");
  if (isQuery(first)) {
    return {
      live: { query: first, handler: second as (rows: unknown) => unknown },
      wake: undefined,
      channel: undefined,
      options: {},
    };
  }
  return {
    live: undefined,
    wake: { handler: second as () => unknown },
    channel: undefined,
    options: readOptions(first),
  };
}

function isQuery(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  const find = keys.some((key) => FIND_KEYS.has(key));
  const watch = keys.some(
    (key) => key === "every" || key === "throttle" || key === "onError" || key === "push",
  );
  if (find && watch) fail("OKM1121", "Pass watch options as the argument before the function.");
  return find;
}

function readOptions(value: unknown): WatchOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) fail("OKM1121", "watch() options must be an object.");
  for (const key of Object.keys(value)) {
    if (
      key !== "every" &&
      key !== "throttle" &&
      key !== "signal" &&
      key !== "onError" &&
      key !== "push"
    ) {
      fail("OKM1121", `watch() does not accept ${key}.`);
    }
  }
  if (value.push !== undefined && value.push !== "required") {
    fail("OKM1121", 'watch() push accepts "required".');
  }
  return value as WatchOptions;
}

function assertChannel(channel: string): void {
  if (channel.length === 0 || utf8Size(channel) > 63) {
    fail("OKM1121", "A watch channel must be 1 to 63 bytes.");
  }
}

function durationMs(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("OKM1121", `watch ${label} must be a duration.`);
    return value;
  }
  if (typeof value !== "string") fail("OKM1121", `watch ${label} must be a duration.`);
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value.trim());
  if (match === null) fail("OKM1121", `watch ${label} must be a number of ms, s, or m.`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1_000;
  return amount * 60_000;
}

function flightKey(session: Session, table: string, query: Record<string, unknown>): string {
  const scope = session.scope;
  const scopeText =
    scope === undefined
      ? ""
      : "unscoped" in scope
        ? `u:${scope.unscoped}`
        : `t:${scope.value}:${stable(scope.values ?? {})}`;
  return `${String(poolId(innerPool(session.pool)))}\u0000${table}\u0000${scopeText}\u0000${stable(session.settings ?? [])}\u0000${stable(query)}`;
}

function sharedRead(key: string, load: () => Promise<unknown>): Promise<unknown> {
  const existing = flights.get(key);
  if (existing !== undefined) return existing;
  const pending = load().finally(() => {
    if (flights.get(key) === pending) flights.delete(key);
  });
  flights.set(key, pending);
  return pending;
}

function pushKind(pool: DriverPool): 1 | 2 | 3 | undefined {
  let current: unknown = pool;
  const inner = Symbol.for("okmodel.pool.inner");
  while (current !== undefined && typeof current === "object" && current !== null) {
    const record = current as Record<symbol, unknown> & DriverPool;
    const kind = record[PUSH_DRIVER];
    if (kind === 1 || kind === 2 || kind === 3) return kind;
    current = record[inner];
  }
  return undefined;
}

function innerPool(pool: DriverPool): DriverPool {
  const inner = Symbol.for("okmodel.pool.inner");
  let current = pool;
  for (;;) {
    const next = (current as unknown as Record<symbol, unknown>)[inner];
    if (next === undefined) return current;
    current = next as DriverPool;
  }
}

function poolId(pool: DriverPool): number {
  const found = poolIds.get(pool);
  if (found !== undefined) return found;
  const id = poolSeq;
  poolSeq += 1;
  poolIds.set(pool, id);
  return id;
}

async function notify(pool: DriverPool, channel: string): Promise<void> {
  await pool.execute("select pg_notify($1, '')", [channel]);
}

async function readQueue(pool: DriverPool): Promise<number | undefined> {
  try {
    const result: ExecuteResult = await pool.execute("select pg_notification_queue_usage()");
    const value = result.rows[0]?.[0];
    const usage =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
    return usage !== undefined && Number.isFinite(usage) ? usage : undefined;
  } catch {
    return undefined;
  }
}

function listenRefused(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  return text.includes("listen") || text.includes("pooling");
}

function warnOnce(reason: string): void {
  if (warned) return;
  warned = true;
  console.warn(`okmodel: watch is polling (${reason}).`);
}

function publicReason(error: unknown, url: string | undefined): string {
  let text = error instanceof Error ? error.message : "the connection failed";
  if (text.length === 0) text = "the connection failed";
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.length > 0) text = text.split(parsed.hostname).join("the database host");
      if (parsed.port.length > 0) text = text.split(`:${parsed.port}`).join("");
    } catch {
      // The URL is only used to strip itself from the message.
    }
  }
  return text.replace(/\d{1,3}(?:\.\d{1,3}){3}/g, "the database host");
}

function pingChannel(): string {
  return `okm_p_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new OkmError(code, message, { kind: "invalid" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitUntil(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(pulse);
      resolve(ready());
    }, timeoutMs);
    const pulse = setInterval(() => {
      if (!ready()) return;
      clearTimeout(timer);
      clearInterval(pulse);
      resolve(true);
    }, 20);
  });
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The listen heartbeat timed out.")), timeoutMs);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
