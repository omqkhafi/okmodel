/**
 * Replica selection (spec §15.1).
 *
 * Health, then consistency and lag, then capacity, then the strategy.
 * Weights, in-flight counts, and latency live on the topology handle.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import type { DriverPool, DriverStats } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import {
  connectTopology,
  type ReplicaCandidate,
  type RouteEvent,
} from "../src/runtime/topology.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

type ReplicaSpec = {
  readonly name: string;
  readonly weight?: number;
  readonly max?: number;
  /** Wait before a timed statement. Probes wait only when `timeProbes` is set. */
  readonly delayMs?: () => number;
  readonly timeProbes?: boolean;
  /** Throw ECONNREFUSED on the next user statement when this returns true. */
  readonly fail?: () => boolean;
  readonly stats?: () => DriverStats;
};

test(
  "weighted follows smooth round-robin, and equal weights rotate",
  async () => {
    const heavy = await sequence(
      [
        { name: "a", weight: 3 },
        { name: "b", weight: 1 },
        { name: "c", weight: 1 },
      ],
      { select: "weighted" },
      15,
    );
    expect(heavy).toEqual(repeat("abaca", 3));

    const even = await sequence(
      [
        { name: "a", weight: 4 },
        { name: "b", weight: 4 },
        { name: "c", weight: 4 },
      ],
      { select: "weighted" },
      9,
    );
    expect(even).toEqual(repeat("abc", 3));
  },
  { timeout: 20_000 },
);

test(
  "roundRobin ignores weights",
  async () => {
    const picks = await sequence(
      [
        { name: "a", weight: 5 },
        { name: "b", weight: 1 },
        { name: "c", weight: 1 },
      ],
      { select: "roundRobin" },
      6,
    );
    expect(picks).toEqual(repeat("abc", 2));
  },
  { timeout: 20_000 },
);

test(
  "leastConnections breaks ties in config order and leaves a slow replica",
  async () => {
    const ties = await sequence(
      [
        { name: "a", weight: 9 },
        { name: "b", weight: 1 },
      ],
      { select: "leastConnections" },
      4,
    );
    expect(ties).toEqual(["a", "a", "a", "a"]);

    const seen: string[] = [];
    const db = await openTopology(
      [
        {
          name: "east",
          delayMs: () => 400,
        },
        { name: "west" },
      ],
      { select: "leastConnections" },
      (endpoint) => {
        seen.push(endpoint);
      },
    );
    try {
      await db.connected;
      seen.length = 0;
      const slow = Promise.resolve(db.notes.find({ limit: 1 }));
      const started = Date.now();
      while (seen.length < 1 && Date.now() - started < 1_000) await pause(5);
      expect(seen).toEqual(["east"]);
      for (let index = 0; index < 4; index += 1) await db.notes.find({ limit: 1 });
      await slow;
      expect(seen).toEqual(["east", "west", "west", "west", "west"]);
    } finally {
      await db.close();
    }
  },
  { timeout: 20_000 },
);

test("latencyAware prefers the faster replica and follows it when that changes", async () => {
  let eastMs = 80;
  let westMs = 0;
  const picks: string[] = [];
  const db = await openTopology(
    [
      { name: "east", delayMs: () => eastMs, timeProbes: true },
      { name: "west", delayMs: () => westMs, timeProbes: true },
    ],
    { select: "latencyAware", probe: 30 },
    (endpoint) => {
      picks.push(endpoint);
    },
  );
  try {
    await db.connected;
    picks.length = 0;
    for (let index = 0; index < 4; index += 1) {
      await db.notes.find({ limit: 1 });
    }
    expect(picks).toEqual(["west", "west", "west", "west"]);

    eastMs = 0;
    westMs = 200;
    picks.length = 0;
    const switched = await waitForPick(async () => {
      await db.notes.find({ limit: 1 });
      return picks.at(-1) === "east";
    });
    expect(switched).toBe(true);
    expect(picks.at(-1)).toBe("east");
  } finally {
    await db.close();
  }
}, 20_000);

test(
  "a custom select sees the candidate shape and runs only when it has a choice",
  async () => {
    const seen: ReplicaCandidate[][] = [];
    let byName = false;
    const calls: RouteEvent[] = [];
    const db = await openTopology(
      [
        { name: "east", weight: 3 },
        { name: "west", weight: 1 },
      ],
      {
        select(candidates, ctx) {
          expect(ctx).toEqual({ op: "read" });
          seen.push(candidates.map((candidate) => ({ ...candidate })));
          const west = candidates[1];
          if (west === undefined) throw new Error("missing west");
          return byName ? west.name : west;
        },
        onRoute(event) {
          calls.push(event);
        },
      },
    );
    try {
      await db.connected;
      calls.length = 0;
      await db.notes.find({ limit: 1 });
      expect(calls.at(-1)).toEqual({ op: "read", endpoint: "west", reason: "auto:west" });
      byName = true;
      calls.length = 0;
      await db.notes.find({ limit: 1 });
      expect(calls.at(-1)).toEqual({ op: "read", endpoint: "west", reason: "auto:west" });
      const first = seen[0]?.[0];
      const second = seen[0]?.[1];
      expect(first).toEqual({
        name: "east",
        weight: 3,
        inflight: 0,
        latencyMs: expect.any(Number),
        lag: expect.any(Number),
      });
      expect(second).toMatchObject({ name: "west", weight: 1, inflight: 0 });
      expect(typeof second?.lag).toBe("number");
    } finally {
      await db.close();
    }

    let called = false;
    const alone = await openTopology([{ name: "east" }], {
      select() {
        called = true;
        return "east";
      },
    });
    try {
      await alone.connected;
      await alone.notes.find({ limit: 1 });
      expect(called).toBe(false);
    } finally {
      await alone.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "a custom select that returns something else is OKM1120, and a throw propagates",
  async () => {
    const copy = await openTopology([{ name: "east" }, { name: "west" }], {
      select: () => ({ name: "west", weight: 1, inflight: 0, latencyMs: null, lag: null }),
    });
    try {
      await copy.connected;
      const error = await rejection(copy.notes.find({ limit: 1 }));
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1120");
        expect(error.message).toContain('an object named "west"');
      }
    } finally {
      await copy.close();
    }

    const number = await openTopology([{ name: "east" }, { name: "west" }], {
      select: () => 4 as unknown as string,
    });
    try {
      await number.connected;
      const error = await rejection(number.notes.find({ limit: 1 }));
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1120");
        expect(error.message).toContain("returned 4");
      }
    } finally {
      await number.close();
    }

    const boom = new OkmError("OKM1120", "select blew up");
    const throwing = await openTopology([{ name: "east" }, { name: "west" }], {
      select() {
        throw boom;
      },
    });
    try {
      await throwing.connected;
      const error = await rejection(throwing.notes.find({ limit: 1 }));
      expect(error).toBe(boom);
    } finally {
      await throwing.close();
    }

    const plain = new Error("select blew up");
    const mapped = await openTopology([{ name: "east" }, { name: "west" }], {
      select() {
        throw plain;
      },
    });
    try {
      await mapped.connected;
      const error = await rejection(mapped.notes.find({ limit: 1 }));
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).not.toBe("OKM1120");
        expect(error.cause).toBe(plain);
      }
    } finally {
      await mapped.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "a saturated replica is skipped, and an explicit replica route still uses it",
  async () => {
    const saturated = (): DriverStats => ({ size: 1, idle: 0, inflight: 1, waiting: 2 });
    const free = (): DriverStats => ({ size: 1, idle: 1, inflight: 0, waiting: 0 });
    const events: RouteEvent[] = [];
    const picks: string[] = [];
    const db = await openTopology(
      [
        { name: "east", max: 1, stats: saturated },
        { name: "west", max: 1, stats: free },
      ],
      {
        onRoute(event) {
          events.push(event);
        },
      },
      (endpoint) => {
        picks.push(endpoint);
      },
    );
    try {
      await db.connected;
      events.length = 0;
      picks.length = 0;
      await db.notes.find({ limit: 1 });
      expect(picks).toEqual(["west"]);
      expect(events.at(-1)).toEqual({ op: "read", endpoint: "west", reason: "auto:west" });
      events.length = 0;
      picks.length = 0;
      await db.notes.find({ limit: 1, route: "replica" });
      expect(picks.at(-1)).toBe("east");
      expect(events.at(-1)?.reason).toBe("constraint:replica");
    } finally {
      await db.close();
    }

    const belowMax = await openTopology(
      [{ name: "east", max: 2, stats: () => ({ size: 1, idle: 0, inflight: 1, waiting: 1 }) }],
      {},
      (endpoint) => {
        expect(endpoint).toBe("east");
      },
    );
    try {
      await belowMax.connected;
      await belowMax.notes.find({ limit: 1 });
    } finally {
      await belowMax.close();
    }

    const fullEvents: RouteEvent[] = [];
    const full = await openTopology(
      [
        { name: "east", max: 1, stats: saturated },
        { name: "west", max: 1, stats: saturated },
      ],
      {
        onRoute(event) {
          fullEvents.push(event);
        },
      },
    );
    try {
      await full.connected;
      fullEvents.length = 0;
      await full.notes.find({ limit: 1 });
      expect(fullEvents.at(-1)).toEqual({
        op: "read",
        endpoint: "primary",
        reason: "fallback:saturated",
      });
      fullEvents.length = 0;
      await full.using("replica").notes.find({ limit: 1 });
      expect(fullEvents.at(-1)?.endpoint).not.toBe("primary");
      expect(fullEvents.at(-1)?.reason).toBe("constraint:replica");
      fullEvents.length = 0;
      await full.notes.find({ limit: 1, route: "replica" });
      expect(fullEvents.at(-1)?.endpoint).not.toBe("primary");
      expect(fullEvents.at(-1)?.reason).toBe("constraint:replica");
    } finally {
      await full.close();
    }

    const strict = await openTopology(
      [
        { name: "east", max: 1, stats: saturated },
        { name: "west", max: 1, stats: saturated },
      ],
      { fallback: "error" },
    );
    try {
      await strict.connected;
      const error = await rejection(strict.notes.find({ limit: 1 }));
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1844");
        expect(error.message).toContain("saturated");
      }
    } finally {
      await strict.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "a connection failure retries with the strategy over the replicas that remain",
  async () => {
    let armed = false;
    const events: RouteEvent[] = [];
    const picks: string[] = [];
    const db = await openTopology(
      [
        { name: "a" },
        {
          name: "b",
          fail() {
            if (!armed) return false;
            armed = false;
            return true;
          },
        },
        { name: "c" },
      ],
      {
        select: "roundRobin",
        onRoute(event) {
          events.push(event);
        },
      },
      (endpoint) => {
        picks.push(endpoint);
      },
    );
    try {
      await db.connected;
      events.length = 0;
      picks.length = 0;
      await db.notes.find({ limit: 1 });
      expect(picks).toEqual(["a"]);
      armed = true;
      events.length = 0;
      picks.length = 0;
      await db.notes.find({ limit: 1 });
      expect(picks).toEqual(["b", "c"]);
      expect(events.map((event) => event.reason)).toEqual(["auto:b", "auto:c"]);
    } finally {
      await db.close();
    }
  },
  { timeout: 20_000 },
);

test("an unknown select is OKM1120, and a bare maxLag is OKM1120", async () => {
  await expectCode(
    () =>
      connectTopology(
        { primary: "postgres://primary/db", replicas: ["postgres://east/db"] },
        { schema: app, routing: { select: "random" as unknown as "weighted" } },
        () => {
          throw new Error("open");
        },
      ),
    "OKM1120",
    'routing.select must be "weighted", "roundRobin", "leastConnections", "latencyAware", or a function.',
  );
  await expectCode(
    () =>
      connectTopology(
        { primary: "postgres://primary/db" },
        { schema: app, routing: { select: 1 as unknown as "weighted" } },
        () => {
          throw new Error("open");
        },
      ),
    "OKM1120",
  );
  await expectCode(
    () =>
      connectTopology(
        { primary: "postgres://primary/db", replicas: [{ url: "postgres://east/db", weight: 0 }] },
        { schema: app },
        () => {
          throw new Error("open");
        },
      ),
    "OKM1120",
    "replicas[0].weight must be a positive number.",
  );
  await expectCode(
    () =>
      connectTopology(
        { primary: "postgres://primary/db" },
        { schema: app, routing: { maxLag: 5 as unknown as string } },
        () => {
          throw new Error("open");
        },
      ),
    "OKM1120",
  );
});

/** Reads `count` times and returns the endpoint of each user statement. */
async function sequence(
  replicas: readonly ReplicaSpec[],
  routing: { readonly select: "weighted" | "roundRobin" | "leastConnections" },
  count: number,
): Promise<string[]> {
  const picks: string[] = [];
  const reasons: string[] = [];
  const db = await openTopology(
    replicas,
    {
      select: routing.select,
      onRoute(event) {
        if (event.op === "read" && event.reason.startsWith("auto:")) reasons.push(event.reason);
      },
    },
    (endpoint) => {
      picks.push(endpoint);
    },
  );
  try {
    await db.connected;
    picks.length = 0;
    reasons.length = 0;
    for (let index = 0; index < count; index += 1) {
      await db.notes.find({ limit: 1 });
    }
    expect(reasons).toEqual(picks.map((name) => `auto:${name}`));
    return picks;
  } finally {
    await db.close();
  }
}

/**
 * Opens independent PGlite databases and wraps each replica pool.
 *
 * @param replicas - Names, weights, delays, and stats
 * @param options - Strategy, probe, fallback, and listener
 * @param onUser - Called with the endpoint name for each user statement
 * @returns The topology client
 */
async function openTopology(
  replicas: readonly ReplicaSpec[],
  options: {
    readonly select?:
      | "weighted"
      | "roundRobin"
      | "leastConnections"
      | "latencyAware"
      | ((
          candidates: readonly ReplicaCandidate[],
          ctx: { readonly op: "read" },
        ) => ReplicaCandidate | string);
    readonly probe?: number;
    readonly fallback?: "primary" | "error";
    readonly onRoute?: (event: RouteEvent) => void;
  },
  onUser?: (endpoint: string) => void,
) {
  const catalog = (app as typeof app & { readonly catalog: Catalog }).catalog;
  return connectTopology(
    {
      primary: memory("primary"),
      replicas: replicas.map((replica) => ({
        url: memory(replica.name),
        name: replica.name,
        ...(replica.weight !== undefined ? { weight: replica.weight } : {}),
        ...(replica.max !== undefined ? { pool: { max: replica.max } } : {}),
      })),
    },
    {
      schema: app,
      routing: {
        probe: options.probe ?? 60_000,
        ...(options.select !== undefined ? { select: options.select } : {}),
        ...(options.fallback !== undefined ? { fallback: options.fallback } : {}),
      },
      replicaState: { replayLsn: () => "0/1" },
      ...(options.onRoute !== undefined ? { onRoute: options.onRoute } : {}),
    },
    async (config) => {
      const pool = await open({ dataDir: config.dataDir });
      for (const statement of renderCatalog(catalog, "public")) await pool.execute(statement);
      const name = labelOf(config.url);
      const replica = replicas.find((item) => item.name === name);
      if (replica === undefined) return pool;
      return wrap(name, replica, pool, onUser);
    },
  );
}

/** Delays, fails, or replaces stats on one replica. User statements are reported. */
function wrap(
  name: string,
  replica: ReplicaSpec,
  pool: DriverPool,
  onUser: ((endpoint: string) => void) | undefined,
): DriverPool {
  const run = async (text: string): Promise<void> => {
    if (housekeeping(text)) {
      if (replica.timeProbes === true && isProbe(text) && replica.delayMs !== undefined) {
        await pause(replica.delayMs());
      }
      return;
    }
    onUser?.(name);
    if (replica.fail?.() === true) throw new Error("ECONNREFUSED");
    if (replica.delayMs !== undefined) await pause(replica.delayMs());
  };
  return {
    capabilities: pool.capabilities,
    execute: async (text, params, options) => {
      await run(text);
      return pool.execute(text, params, options);
    },
    batch: (statements, options) => pool.batch(statements, options),
    stats: () => replica.stats?.() ?? pool.stats(),
    close: () => pool.close(),
    ...(pool.reserve !== undefined ? { reserve: () => pool.reserve!() } : {}),
  };
}

/** `SELECT 1` and the replay probe. */
function isProbe(text: string): boolean {
  const head = text.trimStart().toLowerCase();
  return head === "select 1" || head.startsWith("select 1,");
}

/** Probes, the server check, and transaction control. */
function housekeeping(text: string): boolean {
  const head = text.trimStart().toLowerCase();
  return (
    head.startsWith("select current_setting") ||
    head.includes("has_function_privilege") ||
    head.includes("pg_last_wal_replay_lsn") ||
    head === "select 1" ||
    head.startsWith("begin") ||
    head.startsWith("commit") ||
    head.startsWith("rollback") ||
    head.startsWith("savepoint") ||
    head.startsWith("release") ||
    head.startsWith("reset all") ||
    head.includes("pg_advisory_unlock_all")
  );
}

/** The label embedded in a memory URL. */
function labelOf(url: string): string {
  const body = url.slice("memory://".length);
  const dash = body.indexOf("-");
  return dash === -1 ? body : body.slice(0, dash);
}

/** A unique in-memory database. The label is the part before the first dash. */
function memory(label: string): string {
  return `memory://${label}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** `text` repeated `count` times, as one string of endpoint names. */
function repeat(text: string, count: number): string[] {
  return text.repeat(count).split("");
}

function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Asserts the call fails with `code` and, when given, this message. */
async function expectCode(run: () => unknown, code: string, message?: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe(code);
      if (message !== undefined) expect(error.message).toBe(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

/** The rejection of `run`, so the caller can inspect the same error. */
async function rejection(run: unknown): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** Polls until `ready` is true, or five seconds pass. */
async function waitForPick(ready: () => Promise<boolean>): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    if (await ready()) return true;
  }
  return false;
}
