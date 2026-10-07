/**
 * Read routing (spec §15.1).
 *
 * Automatic reads choose an eligible replica. A write on the topology
 * handle, including one through `reserve()`, keeps later reads on the primary.
 * `route` and `using` override that. A string or pool client has one endpoint.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import type { QuerySchema } from "../src/dialects/pg/model.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import {
  connectTopology,
  readTopology,
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

const caughtUp: ReplicaState = { replayLsn: () => "0/1" };

type Hit = { endpoint: string; text: string };

test("reads use the first replica until the session writes", async () => {
  const hits: Hit[] = [];
  const events: RouteEvent[] = [];
  const db = await openTopology(app, hits, {
    replicas: [named("east"), named("west")],
    onRoute(event) {
      events.push(event);
    },
  });
  try {
    await db.connected;
    events.length = 0;
    hits.length = 0;
    expect(await Promise.resolve(db.notes.find({ limit: 1 }))).toEqual([]);
    expect(hits.at(-1)?.endpoint).toBe("east");
    expect(events.at(-1)).toEqual({ op: "read", endpoint: "east", reason: "auto:east" });
    expect(hits.some((hit) => hit.endpoint === "west")).toBe(false);

    events.length = 0;
    hits.length = 0;
    await Promise.resolve(db.notes.insert({ id: "n1", title: "a" }));
    expect(hits.at(-1)?.endpoint).toBe("primary");
    expect(
      events.some((event) => event.op === "write" && event.reason === "primary-required"),
    ).toBe(true);

    events.length = 0;
    hits.length = 0;
    await Promise.resolve(db.notes.find({ limit: 1 }));
    expect(hits.at(-1)?.endpoint).toBe("primary");
    expect(events.at(-1)).toEqual({
      op: "read",
      endpoint: "primary",
      reason: "fallback:behind",
    });

    const seen = await Promise.resolve(db.notes.find({ limit: 1 }).inspect());
    expect(seen.routing).toEqual({
      endpoint: "primary",
      role: "primary",
      reason: "single-endpoint",
    });
  } finally {
    await db.close();
  }
});

test("a transaction write through reserve keeps later reads on the primary", async () => {
  const hits: Hit[] = [];
  const events: RouteEvent[] = [];
  const db = await openTopology(app, hits, {
    replicas: [memory("east")],
    onRoute(event) {
      events.push(event);
    },
  });
  try {
    await db.connected;
    events.length = 0;
    await db.tx(async (tx) => {
      await tx.notes.insert({ id: "n1", title: "a" });
    });
    expect(events.some((event) => event.op === "tx" && event.reason === "primary-required")).toBe(
      true,
    );
    expect(
      hits.some((hit) => hit.text.toLowerCase().startsWith("insert") && hit.endpoint === "primary"),
    ).toBe(true);
    hits.length = 0;
    await Promise.resolve(db.notes.find({ limit: 1 }));
    expect(hits.at(-1)?.endpoint).toBe("primary");
  } finally {
    await db.close();
  }
});

test("for() and unscoped() share the client-wide watermark", async () => {
  const hits: Hit[] = [];
  const db = await openTopology(tenantApp, hits, { replicas: [named("east")] });
  try {
    await db.connected;
    const first = db.for({ tenantId: TENANT });
    hits.length = 0;
    await Promise.resolve(first.notes.find({ limit: 1 }));
    expect(hits.at(-1)?.endpoint).toBe("east");
    await Promise.resolve(first.notes.insert({ id: "n1", title: "a" }));
    const second = db.for({ tenantId: TENANT });
    hits.length = 0;
    await Promise.resolve(second.notes.find({ limit: 1 }));
    expect(hits.at(-1)?.endpoint).toBe("primary");
    hits.length = 0;
    await Promise.resolve(db.unscoped("report").notes.find({ limit: 1 }));
    expect(hits.at(-1)?.endpoint).toBe("primary");
  } finally {
    await db.close();
  }
});

test("route primary and route replica select an endpoint", async () => {
  const hits: Hit[] = [];
  const events: RouteEvent[] = [];
  const db = await openTopology(app, hits, {
    replicas: [memory("east")],
    onRoute(event) {
      events.push(event);
    },
  });
  try {
    await db.connected;
    events.length = 0;
    hits.length = 0;
    await Promise.resolve(db.notes.find({ limit: 1, route: "primary" }));
    expect(hits.at(-1)?.endpoint).toBe("primary");
    expect(events.at(-1)?.reason).toBe("constraint:primary");
    events.length = 0;
    hits.length = 0;
    await Promise.resolve(db.notes.find({ limit: 1, route: "replica" }));
    expect(hits.at(-1)?.endpoint).toBe("east");
    expect(events.at(-1)?.reason).toBe("constraint:replica");
  } finally {
    await db.close();
  }
});

test("a plain client serves route primary and route replica from its endpoint", async () => {
  const pool = await open({ dataDir: memory("plain") });
  for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
  const db = await connect(pool, { schema: app });
  try {
    await db.connected;
    expect("using" in db).toBe(false);
    expect(await Promise.resolve(db.notes.find({ limit: 1, route: "primary" }))).toEqual([]);
    expect(await Promise.resolve(db.notes.find({ limit: 1, route: "replica" }))).toEqual([]);
  } finally {
    await pool.close();
  }
});

test(
  "a missing or unhealthy replica is OKM1843 or OKM1844",
  async () => {
    const none = await openTopology(app, [], { replicas: [] });
    try {
      await none.connected;
      await expectCode(() => none.notes.find({ limit: 1, route: "replica" }), "OKM1843");
      await none.close();
    } finally {
      await none.close();
    }

    const strict = await openTopology(app, [], {
      replicas: [],
      routing: { fallback: "error" },
    });
    try {
      await strict.connected;
      await expectCode(() => strict.notes.find({ limit: 1 }), "OKM1844");
    } finally {
      await strict.close();
    }

    let down = true;
    const state: ReplicaState = {
      replayLsn() {
        if (down) throw new Error("replica down");
        return "0/1";
      },
    };
    const unhealthy = await connect(
      { primary: memory("primary"), replicas: [memory("east")] },
      { schema: app, routing: { probe: 30, fallback: "error" }, replicaState: state },
    );
    try {
      await unhealthy.connected;
      await waitFor(() => readTopology(unhealthy)?.endpoints[1]?.circuit === "open");
      await expectCode(() => unhealthy.notes.find({ limit: 1 }), "OKM1844");
      down = false;
    } finally {
      await unhealthy.close();
    }
  },
  { timeout: 20_000 },
);

test("using replica refuses a write, a transaction, and a locking read", async () => {
  const hits: Hit[] = [];
  const db = await openTopology(app, hits, { replicas: [memory("east")] });
  try {
    await db.connected;
    const replica = db.using("replica");
    const primary = db.using("primary");
    expect("close" in replica).toBe(false);
    expect("using" in replica).toBe(false);
    expect("close" in primary).toBe(false);
    expect("using" in primary).toBe(false);

    hits.length = 0;
    await Promise.resolve(replica.notes.find({ limit: 1 }));
    expect(hits.at(-1)?.endpoint).toBe("east");
    hits.length = 0;
    await Promise.resolve(primary.notes.find({ limit: 1 }));
    expect(hits.at(-1)?.endpoint).toBe("primary");

    await expectCode(() => replica.notes.insert({ id: "n1", title: "a" }), "OKM1840");
    await expectCode(() => replica.tx(async () => undefined), "OKM1840");
    await expectCode(() => replica.notes.find({ limit: 1, lock: "update" }), "OKM1840");
    await expectCode(() => db.using("east" as "primary"), "OKM1120");
  } finally {
    await db.close();
  }
});

test("close from the root stops probes and scoped clients", async () => {
  let calls = 0;
  const db = await connect(
    { primary: memory("primary"), replicas: [named("east")] },
    {
      schema: app,
      routing: { probe: 40 },
      replicaState: {
        replayLsn() {
          calls += 1;
          return "0/1";
        },
      },
    },
  );
  const replica = db.using("replica");
  try {
    await db.connected;
    await replica.connected;
    await waitFor(() => calls >= 1);
    const settled = calls;
    await db.close();
    await delay(160);
    expect(calls).toBe(settled);
    let rejected = false;
    try {
      await Promise.race([
        Promise.resolve(replica.notes.find({ limit: 1 })),
        delay(1_000).then(() => {
          throw new Error("scoped read hung after close");
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === "scoped read hung after close") throw error;
      rejected = true;
    }
    expect(rejected).toBe(true);
  } finally {
    await db.close();
  }
});

test("a table named using is OKM1120", async () => {
  const named = schema({ tables: [notes] });
  const collided = {
    ...named,
    model: { ...named.model, using: named.model.notes },
  };
  await expectCode(
    () =>
      connectTopology(
        { primary: memory("primary"), replicas: [] },
        { schema: collided as typeof named },
        open,
      ),
    "OKM1120",
  );
});

test("a throwing onRoute is swallowed", async () => {
  const db = await openTopology(app, [], {
    replicas: [memory("east")],
    onRoute() {
      throw new Error("listener");
    },
  });
  try {
    await db.connected;
    expect(await Promise.resolve(db.notes.find({ limit: 1 }))).toEqual([]);
  } finally {
    await db.close();
  }
});

test("routing.fallback rejects a value other than primary or error", async () => {
  await expectCode(
    () =>
      connectTopology(
        { primary: memory("primary") },
        { schema: app, routing: { fallback: "replica" as "primary" } },
        open,
      ),
    "OKM1120",
  );
});

/**
 * Opens a topology of independent PGlite databases and records user SQL.
 *
 * @param source - Schema created on every endpoint
 * @param hits - User statements, in arrival order
 * @param input - Replicas, probe, listener, and fallback
 * @returns The topology client
 */
async function openTopology<S extends QuerySchema>(
  source: S,
  hits: Hit[],
  input: {
    readonly replicas: readonly (string | { readonly url: string; readonly name: string })[];
    readonly onRoute?: (event: RouteEvent) => void;
    readonly routing?: { readonly fallback?: "primary" | "error" };
    readonly probe?: number;
    readonly replicaState?: ReplicaState;
  },
): Promise<RoutedClient<S>> {
  const catalog = (source as S & { readonly catalog: Catalog }).catalog;
  return connectTopology(
    { primary: memory("primary"), replicas: input.replicas },
    {
      schema: source,
      routing: { probe: input.probe ?? 60_000, ...input.routing },
      replicaState: input.replicaState ?? caughtUp,
      ...(input.onRoute !== undefined ? { onRoute: input.onRoute } : {}),
    },
    async (config) => {
      const pool = await open({ dataDir: config.dataDir });
      for (const statement of renderCatalog(catalog, "public")) await pool.execute(statement);
      return watch(config.url, hits, pool);
    },
  );
}

/** Records statements that are not probes, version checks, or transaction control. */
function watch(url: string, hits: Hit[], pool: DriverPool): DriverPool {
  const endpoint = labelOf(url);
  const note = (text: string): void => {
    if (!housekeeping(text)) hits.push({ endpoint, text });
  };
  const wrapped: DriverPool = {
    capabilities: pool.capabilities,
    execute: async (text, params, options) => {
      note(text);
      return pool.execute(text, params, options);
    },
    batch: async (statements, options) => {
      for (const statement of statements) note(statement.text);
      return pool.batch(statements, options);
    },
    stats: () => pool.stats(),
    close: () => pool.close(),
  };
  if (pool.reserve !== undefined) {
    wrapped.reserve = async () => {
      const conn = await pool.reserve!();
      return {
        execute: async (text, params, options) => {
          note(text);
          return conn.execute(text, params, options);
        },
        batch: async (statements, options) => {
          for (const statement of statements) note(statement.text);
          return conn.batch(statements, options);
        },
        release: () => conn.release(),
        ...(conn.cancel !== undefined ? { cancel: () => conn.cancel!() } : {}),
      };
    };
  }
  return wrapped;
}

/** Probes and the server check are not user statements. */
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

/** A replica whose endpoint name matches the URL label. */
function named(label: string): { url: string; name: string } {
  return { url: memory(label), name: label };
}

/** Asserts the call fails with `code`. */
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2_000) {
    if (ready()) return;
    await delay(15);
  }
  throw new Error("timed out waiting for a probe");
}
