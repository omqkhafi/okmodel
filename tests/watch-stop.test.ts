/**
 * `stop()` from inside a watch handler must not wait for that handler.
 *
 * Callers outside the subscription still wait. PGlite covers the cases that
 * do not need a listen connection. The push path is in `watch-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import type { WatchSubscription } from "../src/runtime/types.js";

const orders = table(
  "orders",
  { id: t.integer().primaryKey(), status: t.text() },
  { watch: { push: false } },
);
const app = schema({ casing: "snake", tables: [orders] });

type Db = Awaited<ReturnType<typeof connectPglite<typeof app>>>;

test("stop after an await inside the handler resolves", async () => {
  await withDb(async (db) => {
    let calls = 0;
    let after = false;
    let handle!: WatchSubscription;
    handle = db.orders.watch(
      async () => {
        calls += 1;
        await sleep(20);
        await handle.stop();
        after = true;
      },
      { every: "1s" },
    );
    expect(await settle(handle.run())).toBe("resolved");
    expect(after).toBe(true);
    expect(handle.state).toBe("stopped");
    await sleep(1_100);
    expect(calls).toBe(1);
  });
});

test("stop inside onError resolves and nothing runs after", async () => {
  await withDb(async (db) => {
    let calls = 0;
    let seen = false;
    let handle!: WatchSubscription;
    handle = db.orders.watch(
      async () => {
        calls += 1;
        await sleep(15);
        throw new Error("boom");
      },
      {
        every: "1s",
        onError: async () => {
          seen = true;
          await sleep(15);
          await handle.stop();
        },
      },
    );
    expect(await settle(handle.run())).toBe("resolved");
    expect(seen).toBe(true);
    expect(handle.state).toBe("stopped");
    await sleep(1_100);
    expect(calls).toBe(1);
  });
});

test("stop from outside waits while the handler runs", async () => {
  await withDb(async (db) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const sub = db.orders.watch(
      async () => {
        entered = true;
        await gate;
      },
      { every: "10m" },
    );
    const running = sub.run();
    await waitFor(() => entered);
    let finished = false;
    const stopping = sub.stop().then(() => {
      finished = true;
    });
    await sleep(60);
    expect(finished).toBe(false);
    release();
    await stopping;
    await running;
    expect(sub.state).toBe("stopped");
    expect(sub.stats.runs).toBe(1);
  });
});

test("await using scope exit waits for the handler", async () => {
  await withDb(async (db) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const scope = (async () => {
      await using updates = db.orders.watch(
        async () => {
          entered = true;
          await gate;
        },
        { every: "10m" },
      );
      await waitFor(() => entered);
      void updates;
    })();
    await waitFor(() => entered);
    const raced = await Promise.race([
      scope.then(() => "done" as const),
      sleep(80).then(() => "waiting" as const),
    ]);
    expect(raced).toBe("waiting");
    release();
    await scope;
  });
});

test("await using created inside a handler does not hang", async () => {
  await withDb(async (db) => {
    let childCalls = 0;
    const parent = db.orders.watch(
      async () => {
        let child!: WatchSubscription;
        child = db.orders.watch(
          async () => {
            childCalls += 1;
            await sleep(30);
            await child.stop();
          },
          { every: "1s" },
        );
        await using held = child;
        await held.run();
      },
      { every: "10m" },
    );
    expect(await settle(parent.run())).toBe("resolved");
    expect(childCalls).toBe(1);
    await parent.stop();
    await sleep(1_100);
    expect(childCalls).toBe(1);
  });
});

test("until resolves and the subscription does not keep running", async () => {
  await withDb(async (db) => {
    await db.orders.insert({ id: 1, status: "open" });
    const row = await db.orders.until({ where: { id: 1 } }, { timeout: "2s" });
    expect(row).toMatchObject({ id: 1, status: "open" });
    const pending = db.orders.until({ where: { id: 2 } }, { timeout: "3s" });
    await db.orders.insert({ id: 2, status: "paid" });
    const next = await pending;
    expect(next).toMatchObject({ id: 2, status: "paid" });
  });
});

test("aborting the signal inside the handler stops the watch", async () => {
  await withDb(async (db) => {
    const controller = new AbortController();
    let calls = 0;
    const sub = db.orders.watch(
      async () => {
        calls += 1;
        await sleep(15);
        controller.abort();
      },
      { every: "1s", signal: controller.signal },
    );
    expect(await settle(sub.run())).toBe("resolved");
    expect(sub.state).toBe("stopped");
    await sleep(1_100);
    expect(calls).toBe(1);
  });
});

test("a live read does not query again after stop from the handler", async () => {
  await withDb(async (db) => {
    await db.orders.insert({ id: 1, status: "open" });
    let handle!: WatchSubscription;
    handle = db.orders.watch({ limit: 5 }, { every: "1s" }, async () => {
      await sleep(15);
      await handle.stop();
    });
    expect(await settle(handle.run())).toBe("resolved");
    const queries = handle.stats.queries;
    const runs = handle.stats.runs;
    expect(queries).toBeGreaterThan(0);
    await sleep(1_100);
    expect(handle.stats.queries).toBe(queries);
    expect(handle.stats.runs).toBe(runs);
    expect(handle.state).toBe("stopped");
  });
});

/**
 * Opens a memory database, runs `body`, and closes both ends.
 *
 * @param body - Test body
 */
async function withDb(body: (db: Db) => Promise<void>): Promise<void> {
  const pool = await openPglite();
  try {
    await pool.execute("create table orders (id integer primary key, status text)");
    const db = await connectPglite(pool, { schema: app });
    await db.connected;
    try {
      await body(db);
    } finally {
      await db.close();
    }
  } finally {
    await pool.close();
  }
}

/**
 * Fails the test when `work` does not settle. A hung `stop()` used to do that.
 *
 * @param work - The promise that must finish
 */
function settle(work: Promise<void>): Promise<"resolved" | "timeout"> {
  return Promise.race([
    work.then(() => "resolved" as const),
    sleep(3_000).then(() => "timeout" as const),
  ]);
}

/**
 * Resolves after `ms`.
 *
 * @param ms - Delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polls until `ready` is true.
 *
 * @param ready - Condition
 */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}
