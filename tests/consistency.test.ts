/**
 * Commit-position consistency (spec §15.1).
 *
 * Replica replay positions come from `ReplicaState`. The primary insert
 * position is `pg_current_wal_insert_lsn()` on the endpoint. One test repeats
 * a write on the Docker primary and records the extra round trip.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import type { DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import type { QuerySchema } from "../src/dialects/pg/model.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import {
  connectTopology,
  type ReplicaCandidate,
  type ReplicaState,
  type RouteEvent,
  type RoutedClient,
} from "../src/runtime/topology.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const tenantNotes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const tenantApp = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tenantNotes],
});

const AHEAD = "FFFFFFFF/FFFFFFFF";
const BEHIND = "0/1";

type Hit = { endpoint: string; text: string };

type Counted = {
  readonly db: RoutedClient<typeof app>;
  readonly hits: Hit[];
  lsn: number;
  /** Milliseconds of each insert-LSN query after connect. */
  readonly samples: number[];
};

test("accepted maxLag forms connect, and a bare number or garbage is OKM1120", async () => {
  for (const maxLag of ["5s", "500ms", "2m", "16MB", "512KB", "1GB", "4096B"]) {
    const db = await connectTopology(
      { primary: "postgres://primary/db", replicas: ["postgres://east/db"] },
      { schema: app, routing: { maxLag, probe: 60_000, consistency: "eventual" } },
      () => recordingPool(),
    );
    await db.connected;
    await db.close();
  }
  const session = await connectTopology(
    { primary: "postgres://primary/db" },
    { schema: app, routing: { consistency: "session", probe: 60_000 } },
    () => recordingPool(),
  );
  await session.connected;
  await session.close();
  await expectCode(
    () =>
      connectTopology(
        { primary: "postgres://primary/db" },
        { schema: app, routing: { maxLag: 5 as unknown as string } },
        () => recordingPool(),
      ),
    "OKM1120",
  );
  for (const maxLag of ["5", "soon", "16mb", "5 s"]) {
    await expectCode(
      () =>
        connectTopology(
          { primary: "postgres://primary/db" },
          { schema: app, routing: { maxLag } },
          () => recordingPool(),
        ),
      "OKM1120",
    );
  }
  const bad = await rejection(
    connectTopology(
      { primary: "postgres://primary/db" },
      { schema: app, routing: { consistency: "strong" as "session" } },
      () => recordingPool(),
    ),
  );
  expect(bad).toBeInstanceOf(OkmError);
  if (bad instanceof OkmError) {
    expect(bad.code).toBe("OKM1120");
    expect(bad.message).toContain('"session"');
    expect(bad.message).toContain('"eventual"');
  }
});

test(
  "a replica at the watermark is served from the cache, and one behind is checked once",
  async () => {
    const westCalls: string[] = [];
    const events: RouteEvent[] = [];
    const caught = await openTopology(app, [], {
      replicas: [named("east"), named("west")],
      replay: (name) => (name === "west" ? AHEAD : BEHIND),
      onReplay(name) {
        westCalls.push(name);
      },
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await caught.connected;
      await caught.notes.insert({ id: "n1", title: "a" });
      events.length = 0;
      const before = westCalls.length;
      await caught.notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({ op: "read", endpoint: "west", reason: "auto:west" });
      expect(westCalls.slice(before)).toEqual(["east"]);
    } finally {
      await caught.close();
    }

    const checks: string[] = [];
    const behindEvents: RouteEvent[] = [];
    const behind = await openTopology(app, [], {
      replicas: [named("east")],
      replay: () => BEHIND,
      onReplay(name) {
        checks.push(name);
      },
      onRoute(event) {
        behindEvents.push(event);
      },
    });
    try {
      await behind.connected;
      behindEvents.length = 0;
      const mark = checks.length;
      await behind.notes.insert({ id: "n1", title: "a" });
      await behind.notes.find({ limit: 1 });
      expect(checks.length).toBe(mark + 1);
      expect(behindEvents.at(-1)).toEqual({
        op: "read",
        endpoint: "primary",
        reason: "fallback:behind",
      });
    } finally {
      await behind.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "autocommit, batch, and commit read the position; rollback, eventual, and a lone primary do not",
  async () => {
    const tracked = await counted(app);
    try {
      await tracked.db.connected;
      const base = tracked.lsn;
      await tracked.db.notes.insert({ id: "n1", title: "a" });
      expect(tracked.lsn).toBe(base + 1);
      await tracked.db.batch([tracked.db.notes.insert({ id: "n2", title: "b" })]);
      expect(tracked.lsn).toBe(base + 2);
      await tracked.db.tx(async (tx) => {
        await tx.notes.insert({ id: "n3", title: "c" });
      });
      expect(tracked.lsn).toBe(base + 3);
      const beforeRollback = tracked.lsn;
      let undone = false;
      try {
        await tracked.db.tx(async (tx) => {
          await tx.notes.insert({ id: "n4", title: "d" });
          throw new Error("undo");
        });
      } catch (error) {
        undone = error instanceof Error && error.message === "undo";
      }
      expect(undone).toBe(true);
      expect(tracked.lsn).toBe(beforeRollback);
      await tracked.db.tx(async () => undefined);
      expect(tracked.lsn).toBe(beforeRollback);
    } finally {
      await tracked.db.close();
    }

    const eventual = await counted(app, { consistency: "eventual" });
    try {
      await eventual.db.connected;
      expect(eventual.lsn).toBe(0);
      await eventual.db.notes.insert({ id: "n1", title: "a" });
      expect(eventual.lsn).toBe(0);
      eventual.hits.length = 0;
      await eventual.db.notes.find({ limit: 1 });
      expect(eventual.hits.at(-1)?.endpoint).toBe("east");
    } finally {
      await eventual.db.close();
    }

    const alone = await counted(app, { replicas: [] });
    try {
      await alone.db.connected;
      await alone.db.notes.insert({ id: "n1", title: "a" });
      expect(alone.lsn).toBe(0);
    } finally {
      await alone.db.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "the position read finishes before the write resolves, and two writes keep the high watermark",
  async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arm = false;
    let started = false;
    const events: RouteEvent[] = [];
    const db = await openTopology(app, [], {
      replicas: [named("east")],
      replay: () => BEHIND,
      holdLsn: () => {
        if (!arm) return Promise.resolve();
        started = true;
        return gate;
      },
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await db.connected;
      arm = true;
      let settled = false;
      const write = db.notes.insert({ id: "n1", title: "a" }).finally(() => {
        settled = true;
      });
      await waitFor(() => started);
      expect(settled).toBe(false);
      release();
      await write;
      expect(settled).toBe(true);
      events.length = 0;
      await db.notes.find({ limit: 1 });
      expect(events.at(-1)?.reason).toBe("fallback:behind");
    } finally {
      release();
      await db.close();
    }

    const seen: string[] = [];
    let current = BEHIND;
    const picks: RouteEvent[] = [];
    const both = await openTopology(app, [], {
      replicas: [named("east")],
      replay: () => current,
      onLsn(text) {
        seen.push(text);
      },
      onRoute(event) {
        picks.push(event);
      },
    });
    try {
      await both.connected;
      seen.length = 0;
      await Promise.all([
        both.notes.insert({ id: "a", title: "a" }),
        both.notes.insert({ id: "b", title: "b" }),
      ]);
      expect(seen.length).toBe(2);
      const first = seen[0];
      const second = seen[1];
      if (first === undefined || second === undefined) throw new Error("missing position");
      const low = compareLsn(first, second) <= 0 ? first : second;
      const high = low === first ? second : first;
      current = compareLsn(low, high) === 0 ? BEHIND : low;
      picks.length = 0;
      await both.notes.find({ limit: 1 });
      expect(picks.at(-1)?.endpoint).toBe("primary");
      current = high;
      picks.length = 0;
      await both.notes.find({ limit: 1 });
      expect(picks.at(-1)).toEqual({ op: "read", endpoint: "east", reason: "auto:east" });
    } finally {
      await both.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "a failed position read sticks to the primary until the next successful read",
  async () => {
    let fail = false;
    const events: RouteEvent[] = [];
    let replay = BEHIND;
    const db = await openTopology(app, [], {
      replicas: [named("east")],
      replay: () => replay,
      failLsn: () => fail,
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await db.connected;
      fail = true;
      await db.notes.insert({ id: "n1", title: "a" });
      events.length = 0;
      await db.notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({
        op: "read",
        endpoint: "primary",
        reason: "fallback:position-unknown",
      });
      events.length = 0;
      await expectCode(() => db.notes.find({ limit: 1, route: "replica" }), "OKM1843");
      fail = false;
      replay = AHEAD;
      await db.notes.insert({ id: "n2", title: "b" });
      events.length = 0;
      await db.notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({ op: "read", endpoint: "east", reason: "auto:east" });
    } finally {
      await db.close();
    }

    const strict = await openTopology(app, [], {
      replicas: [named("east")],
      routing: { fallback: "error" },
      replay: () => BEHIND,
      failLsn: () => true,
    });
    try {
      await strict.connected;
      await strict.notes.insert({ id: "n1", title: "a" });
      const error = await rejection(strict.notes.find({ limit: 1 }));
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1844");
        expect(error.message).toContain("position-unknown");
      }
    } finally {
      await strict.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "a primary probe clears position unknown",
  async () => {
    let fail = true;
    let replay = BEHIND;
    const events: RouteEvent[] = [];
    const db = await openTopology(app, [], {
      replicas: [named("east")],
      routing: { probe: 40 },
      replay: () => replay,
      failLsn: () => fail,
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await db.connected;
      await db.notes.insert({ id: "n1", title: "a" });
      events.length = 0;
      await db.notes.find({ limit: 1 });
      expect(events.at(-1)?.reason).toBe("fallback:position-unknown");
      fail = false;
      replay = AHEAD;
      const served = await waitFor(async () => {
        events.length = 0;
        await db.notes.find({ limit: 1 });
        return events.at(-1)?.endpoint === "east";
      });
      expect(served).toBe(true);
      expect(events.at(-1)?.reason).toBe("auto:east");
    } finally {
      await db.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "a missing position capability keeps a written session off that replica",
  async () => {
    const events: RouteEvent[] = [];
    const primaryBlind = await openTopology(app, [], {
      replicas: [named("east")],
      replay: () => AHEAD,
      position: (role) => role === "replica",
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await primaryBlind.connected;
      events.length = 0;
      await primaryBlind.notes.find({ limit: 1 });
      expect(events.at(-1)?.endpoint).toBe("east");
      await primaryBlind.notes.insert({ id: "n1", title: "a" });
      events.length = 0;
      await primaryBlind.notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({
        op: "read",
        endpoint: "primary",
        reason: "fallback:position-unknown",
      });
      await expectCode(() => primaryBlind.notes.find({ limit: 1, route: "replica" }), "OKM1843");
    } finally {
      await primaryBlind.close();
    }

    const replicaBlind = await openTopology(app, [], {
      replicas: [named("east")],
      replay: () => AHEAD,
      position: (role) => role === "primary",
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await replicaBlind.connected;
      events.length = 0;
      await replicaBlind.notes.find({ limit: 1 });
      expect(events.at(-1)?.endpoint).toBe("east");
      await replicaBlind.notes.insert({ id: "n1", title: "a" });
      events.length = 0;
      await replicaBlind.notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({
        op: "read",
        endpoint: "primary",
        reason: "fallback:behind",
      });
      await expectCode(() => replicaBlind.using("replica").notes.find({ limit: 1 }), "OKM1843");
    } finally {
      await replicaBlind.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "eventual ignores the watermark, and maxLag filters bytes and time",
  async () => {
    const events: RouteEvent[] = [];
    let replay = BEHIND;
    let when = new Date(Date.now() - 60 * 60 * 1_000);
    const bytes = await openTopology(app, [], {
      replicas: [named("east"), named("west")],
      routing: { consistency: "eventual", maxLag: "4096B" },
      replay: (name) => (name === "west" ? AHEAD : replay),
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await bytes.connected;
      await bytes.notes.insert({ id: "n1", title: "a" });
      events.length = 0;
      await bytes.notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({ op: "read", endpoint: "west", reason: "auto:west" });
      replay = AHEAD;
    } finally {
      await bytes.close();
    }

    const stale = await openTopology(app, [], {
      replicas: [named("east")],
      routing: { consistency: "eventual", maxLag: "4096B", fallback: "error" },
      replay: () => BEHIND,
    });
    try {
      await stale.connected;
      const error = await rejection(stale.notes.find({ limit: 1 }));
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1844");
        expect(error.message).toContain("behind");
      }
    } finally {
      await stale.close();
    }

    const caughtUp = await openTopology(app, [], {
      replicas: [named("east")],
      routing: { consistency: "eventual", maxLag: "500ms" },
      replay: () => AHEAD,
      replayTime: () => when,
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await caughtUp.connected;
      events.length = 0;
      await caughtUp.notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({ op: "read", endpoint: "east", reason: "auto:east" });
    } finally {
      await caughtUp.close();
    }

    const old = await openTopology(app, [], {
      replicas: [named("east")],
      routing: { consistency: "eventual", maxLag: "1s" },
      replay: () => BEHIND,
      replayTime: () => when,
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await old.connected;
      events.length = 0;
      await old.notes.find({ limit: 1 });
      expect(events.at(-1)?.reason).toBe("fallback:behind");
      when = new Date();
      events.length = 0;
      await old.notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({ op: "read", endpoint: "east", reason: "auto:east" });
    } finally {
      await old.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "route replica and using replica obey the watermark and maxLag",
  async () => {
    const hits: Hit[] = [];
    const behind = await openTopology(app, hits, {
      replicas: [named("east")],
      replay: () => BEHIND,
    });
    try {
      await behind.connected;
      await behind.notes.insert({ id: "n1", title: "a" });
      hits.length = 0;
      await expectCode(() => behind.notes.find({ limit: 1, route: "replica" }), "OKM1843");
      await expectCode(() => behind.using("replica").notes.find({ limit: 1 }), "OKM1843");
      expect(
        hits.some((hit) => hit.endpoint === "primary" && hit.text.toLowerCase().includes("from")),
      ).toBe(false);
    } finally {
      await behind.close();
    }

    const events: RouteEvent[] = [];
    const ahead = await openTopology(app, [], {
      replicas: [named("east")],
      replay: () => AHEAD,
      onRoute(event) {
        events.push(event);
      },
    });
    try {
      await ahead.connected;
      await ahead.notes.insert({ id: "n1", title: "a" });
      events.length = 0;
      await ahead.using("replica").notes.find({ limit: 1 });
      expect(events.at(-1)).toEqual({ op: "read", endpoint: "east", reason: "constraint:replica" });
    } finally {
      await ahead.close();
    }

    const lagged = await openTopology(app, [], {
      replicas: [named("east")],
      routing: { maxLag: "4096B", consistency: "eventual" },
      replay: () => BEHIND,
    });
    try {
      await lagged.connected;
      await expectCode(() => lagged.notes.find({ limit: 1, route: "replica" }), "OKM1843");
    } finally {
      await lagged.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "unscoped() sees a write made through for()",
  async () => {
    const hits: Hit[] = [];
    const db = await openTopology(tenantApp, hits, {
      replicas: [named("east")],
      replay: () => BEHIND,
    });
    try {
      await db.connected;
      const scoped = db.for({ tenantId: TENANT });
      hits.length = 0;
      await scoped.notes.find({ limit: 1 });
      expect(hits.at(-1)?.endpoint).toBe("east");
      await scoped.notes.insert({ id: "n1", title: "a" });
      const other = db.for({ tenantId: TENANT });
      hits.length = 0;
      await other.notes.find({ limit: 1 });
      expect(hits.at(-1)?.endpoint).toBe("primary");
      hits.length = 0;
      await db.unscoped("report").notes.find({ limit: 1 });
      expect(hits.at(-1)?.endpoint).toBe("primary");
    } finally {
      await db.close();
    }
  },
  { timeout: 20_000 },
);

test(
  "a custom select receives lag in bytes",
  async () => {
    const seen: ReplicaCandidate[][] = [];
    const db = await openTopology(app, [], {
      replicas: [named("east"), named("west")],
      replay: (name) => (name === "east" ? AHEAD : BEHIND),
      routing: {
        select(candidates) {
          seen.push(candidates.map((candidate) => ({ ...candidate })));
          return candidates[0]?.name ?? "east";
        },
      },
    });
    try {
      await db.connected;
      await db.notes.find({ limit: 1 });
      const east = seen[0]?.find((candidate) => candidate.name === "east");
      const west = seen[0]?.find((candidate) => candidate.name === "west");
      expect(east?.lag).toBe(0);
      expect(typeof west?.lag).toBe("number");
      expect(west?.lag ?? 0).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  },
  { timeout: 20_000 },
);

const decision = await loadPostgresGate();

postgresTest(
  decision,
  "a committed write on Postgres reads the insert position before it resolves",
  async () => {
    const name = `p63_${Math.random().toString(16).slice(2)}`;
    const row = table(name, { id: t.text().primaryKey(), title: t.text() });
    const source = schema({ tables: [row] });
    const catalog = (source as typeof source & { readonly catalog: Catalog }).catalog;
    const setup = openPostgres({ url: primaryUrl(), max: 1 });
    for (const statement of renderCatalog(catalog, "public")) await setup.execute(statement);
    await setup.close();
    const samples: number[] = [];
    let replayCalls = 0;
    const db = await connectTopology(
      { primary: primaryUrl(), replicas: [{ url: primaryUrl(), name: "east" }] },
      {
        schema: source,
        routing: { probe: 60_000 },
        replicaState: {
          replayLsn() {
            replayCalls += 1;
            return AHEAD;
          },
        },
      },
      async (config) => {
        const pool = openPostgres({ url: config.url, max: 2 });
        return watchLsn(pool, samples);
      },
    );
    try {
      await db.connected;
      const before = samples.length;
      const started = performance.now();
      const rows = db as unknown as Record<
        string,
        {
          insert(row: { id: string; title: string }): Promise<unknown>;
          find(input: { limit: number }): Promise<unknown>;
        }
      >;
      const api = rows[name];
      if (api === undefined) throw new Error("missing table");
      await api.insert({ id: "n1", title: "a" });
      const elapsed = performance.now() - started;
      expect(samples.length).toBe(before + 1);
      const sample = samples.at(-1);
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeGreaterThanOrEqual(sample ?? 0);
      console.info(
        `position-read-ms ${String(sample)} write-ms ${elapsed.toFixed(3)} replay-checks ${String(replayCalls)}`,
      );
      await api.find({ limit: 1 });
    } finally {
      await db.close();
      const drop = openPostgres({ url: primaryUrl(), max: 1 });
      await drop.execute(`drop table if exists ${name}`);
      await drop.close();
    }
  },
  20_000,
);

/**
 * Opens independent PGlite databases and counts insert-LSN queries.
 *
 * @param source - Schema created on every endpoint
 * @param routing - Consistency and lag
 * @returns The client and the query count
 */
async function counted(
  source: typeof app,
  routing: {
    readonly consistency?: "session" | "eventual";
    readonly replicas?: readonly { readonly url: string; readonly name: string }[];
  } = {},
): Promise<Counted> {
  const hits: Hit[] = [];
  const state = {
    db: undefined as unknown as RoutedClient<typeof app>,
    hits,
    lsn: 0,
    samples: [] as number[],
  };
  const replicas = routing.replicas ?? [named("east")];
  state.db = await openTopology(source, hits, {
    replicas,
    ...(routing.consistency !== undefined ? { routing: { consistency: routing.consistency } } : {}),
    replay: () => BEHIND,
    onLsn(_text, ms) {
      state.lsn += 1;
      state.samples.push(ms);
    },
  });
  return state;
}

/**
 * Opens a topology of independent databases.
 *
 * @param source - Schema created on every endpoint
 * @param hits - User statements
 * @param input - Replicas, seam, and faults
 * @returns The client
 */
async function openTopology<S extends QuerySchema>(
  source: S,
  hits: Hit[],
  input: {
    readonly replicas: readonly { readonly url: string; readonly name: string }[];
    readonly routing?: {
      readonly consistency?: "session" | "eventual";
      readonly maxLag?: string;
      readonly fallback?: "primary" | "error";
      readonly probe?: number;
      readonly select?: (candidates: readonly ReplicaCandidate[]) => ReplicaCandidate | string;
    };
    readonly replay?: (name: string) => string | null;
    readonly replayTime?: () => Date | null;
    readonly onReplay?: (name: string) => void;
    readonly onRoute?: (event: RouteEvent) => void;
    readonly position?: (role: "primary" | "replica") => boolean;
    readonly failLsn?: () => boolean;
    readonly holdLsn?: () => Promise<void>;
    readonly onLsn?: (text: string, ms: number) => void;
  },
): Promise<RoutedClient<S>> {
  const catalog = (source as S & { readonly catalog: Catalog }).catalog;
  const seam: ReplicaState = {
    replayLsn(endpoint) {
      input.onReplay?.(endpoint.name);
      return input.replay?.(endpoint.name) ?? AHEAD;
    },
    ...(input.replayTime !== undefined
      ? {
          replayTime() {
            return input.replayTime?.() ?? null;
          },
        }
      : {}),
  };
  return connectTopology(
    { primary: memory("primary"), replicas: input.replicas },
    {
      schema: source,
      routing: { probe: input.routing?.probe ?? 60_000, ...input.routing },
      replicaState: seam,
      ...(input.onRoute !== undefined ? { onRoute: input.onRoute } : {}),
    },
    async (config) => {
      const pool = await open({ dataDir: config.dataDir });
      for (const statement of renderCatalog(catalog, "public")) await pool.execute(statement);
      const role = config.url.includes("primary") ? "primary" : "replica";
      return watch(config.url, hits, pool, {
        position: input.position?.(role) ?? true,
        ...(input.failLsn !== undefined ? { failLsn: input.failLsn } : {}),
        ...(input.holdLsn !== undefined ? { holdLsn: input.holdLsn } : {}),
        ...(input.onLsn !== undefined ? { onLsn: input.onLsn } : {}),
      });
    },
  );
}

/** Records user SQL and can fail or delay the insert-LSN query. */
function watch(
  url: string,
  hits: Hit[],
  pool: DriverPool,
  fault: {
    readonly position: boolean;
    readonly failLsn?: () => boolean;
    readonly holdLsn?: () => Promise<void>;
    readonly onLsn?: (text: string, ms: number) => void;
  },
): DriverPool {
  const endpoint = labelOf(url);
  const run = async (
    target: { execute: DriverPool["execute"] },
    text: string,
    params?: readonly (string | null)[],
    options?: Parameters<DriverPool["execute"]>[2],
  ): Promise<ExecuteResult> => {
    if (text.includes("has_function_privilege") && !fault.position) {
      return { rows: [["f"]], count: 1, notices: [] };
    }
    if (isInsertLsn(text)) {
      if (fault.failLsn?.() === true) throw new Error("position read failed");
      await fault.holdLsn?.();
      const started = performance.now();
      const result = await target.execute(text, params, options);
      const value = result.rows[0]?.[0];
      fault.onLsn?.(value ?? "", performance.now() - started);
      return result;
    }
    if (!housekeeping(text)) hits.push({ endpoint, text });
    return target.execute(text, params, options);
  };
  return {
    capabilities: pool.capabilities,
    execute: (text, params, options) => run(pool, text, params, options),
    batch: (statements, options) => pool.batch(statements, options),
    stats: () => pool.stats(),
    close: () => pool.close(),
    ...(pool.reserve !== undefined
      ? {
          reserve: async () => {
            const conn = await pool.reserve!();
            return {
              execute: (text, params, options) => run(conn, text, params, options),
              batch: (statements, options) => conn.batch(statements, options),
              release: () => conn.release(),
              ...(conn.cancel !== undefined ? { cancel: () => conn.cancel!() } : {}),
            };
          },
        }
      : {}),
  };
}

/** Times insert-LSN queries on a Postgres pool. */
function watchLsn(pool: DriverPool, samples: number[]): DriverPool {
  const execute: DriverPool["execute"] = async (text, params, options) => {
    if (!isInsertLsn(text)) return pool.execute(text, params, options);
    const started = performance.now();
    const result = await pool.execute(text, params, options);
    samples.push(performance.now() - started);
    return result;
  };
  return {
    capabilities: pool.capabilities,
    execute,
    batch: (statements, options) => pool.batch(statements, options),
    stats: () => pool.stats(),
    close: () => pool.close(),
    ...(pool.reserve !== undefined
      ? {
          reserve: async () => {
            const conn = await pool.reserve!();
            return {
              execute: (text, params, options) => execute(text, params, options),
              batch: (statements, options) => conn.batch(statements, options),
              release: () => conn.release(),
              ...(conn.cancel !== undefined ? { cancel: () => conn.cancel!() } : {}),
            };
          },
        }
      : {}),
  };
}

function recordingPool(): DriverPool {
  return {
    capabilities: {
      transactions: "none",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    execute(text) {
      if (text.startsWith("select current_setting")) {
        return Promise.resolve({
          rows: [["170000", "PostgreSQL 17.1", null]],
          count: 1,
          notices: [],
        });
      }
      if (text.includes("has_function_privilege")) {
        return Promise.resolve({ rows: [["f"]], count: 1, notices: [] });
      }
      if (text.includes("pg_last_wal_replay_lsn")) {
        return Promise.resolve({ rows: [["1", AHEAD, null]], count: 1, notices: [] });
      }
      return Promise.resolve({ rows: [], count: 0, notices: [] });
    },
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

function isInsertLsn(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith("select pg_current_wal_insert_lsn");
}

function housekeeping(text: string): boolean {
  const head = text.trimStart().toLowerCase();
  return (
    head.startsWith("select current_setting") ||
    head.includes("has_function_privilege") ||
    head.includes("pg_last_wal_replay_lsn") ||
    head.includes("pg_current_wal_insert_lsn") ||
    head.includes("pg_last_xact_replay_timestamp") ||
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

/** Compares two `X/Y` LSNs. */
function compareLsn(left: string, right: string): number {
  const a = lsnValue(left);
  const b = lsnValue(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function lsnValue(text: string): bigint {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(text.trim());
  const high = match?.[1];
  const low = match?.[2];
  if (high === undefined || low === undefined) return 0n;
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
}

function labelOf(url: string): string {
  const body = url.slice("memory://".length);
  const dash = body.indexOf("-");
  return dash === -1 ? body : body.slice(0, dash);
}

function memory(label: string): string {
  return `memory://${label}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function named(label: string): { url: string; name: string } {
  return { url: memory(label), name: label };
}

async function expectCode(run: () => unknown, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function rejection(run: unknown): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(ready: () => boolean | Promise<boolean>): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < 4_000) {
    if (await ready()) return true;
    await delay(20);
  }
  return false;
}
