/**
 * `watch` on real Postgres: wake, live read, signals, until, drift, and liveness.
 *
 * NOTIFY is a hint. Each proof reads the table, or waits on the subscription,
 * and does not treat a payload as the row.
 */

import { expect } from "bun:test";
import net from "node:net";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { fragment, schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { replicaUrl } from "../packages/harness/src/topology.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { queryObserver } from "../src/runtime/observe.js";
import { columnTenancy, rlsTenancy } from "../src/runtime/tenancy/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { watchDoctorText } from "../src/tooling/migrate/doctor-watch.js";

const gate = await loadPostgresGate();

const orders = table("orders", { id: t.integer().primaryKey(), status: t.text() }, { watch: true });
const jobs = table("jobs", { id: t.integer().primaryKey(), status: t.text() }, { watch: true });
const app = schema({ casing: "snake", tables: [orders, jobs] });

postgresTest(gate, "proof:watch.wake", async () => {
  await withApp(app, async (db) => {
    let hold = false;
    let release: () => void = () => undefined;
    let calls = 0;
    const sub = db.orders.watch(async () => {
      calls += 1;
      if (hold) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    try {
      await sub.run();
      expect(calls).toBe(1);
      expect(sub.state).toBe("push");
      hold = true;
      await db.orders.insert({ id: 1, status: "open" });
      await waitFor(() => calls === 2);
      await db.orders.insert({ id: 2, status: "open" });
      await db.orders.insert({ id: 3, status: "open" });
      await db.orders.insert({ id: 4, status: "open" });
      release();
      await sleep(250);
      expect(calls).toBe(3);
      const before = calls;
      try {
        await db.tx(async (tx) => {
          await tx.orders.insert({ id: 9, status: "nope" });
          throw new Error("rollback");
        });
      } catch {
        // The insert is undone. The trigger's NOTIFY goes with it.
      }
      await sleep(200);
      expect(calls).toBe(before);
    } finally {
      hold = false;
      release();
      await sub.stop();
    }
  });
});

postgresTest(gate, "proof:watch.liveRead", async () => {
  let finds = 0;
  await withApp(
    app,
    async (db) => {
      await db.orders.insert({ id: 1, status: "open" });
      const seen: number[] = [];
      const left = db.orders.watch({ where: { status: "open" }, limit: 10 }, (rows) => {
        seen.push(rows.length);
      });
      const right = db.orders.watch({ where: { status: "open" }, limit: 10 }, () => undefined);
      await left.run();
      await right.run();
      const afterStart = finds;
      await db.orders.insert({ id: 2, status: "open" });
      await waitFor(() => seen.length >= 2 && seen[seen.length - 1] === 2);
      expect(finds - afterStart).toBe(1);
      let failed = 0;
      const retry = db.orders.watch({ where: { status: "paid" }, limit: 5 }, () => {
        failed += 1;
        if (failed === 1) throw new Error("handler failed");
      });
      await retry.run();
      expect(failed).toBe(1);
      await retry.run();
      expect(failed).toBe(2);
      await left.stop();
      await right.stop();
      await retry.stop();
    },
    (event) => {
      if (event.op === "find") finds += 1;
    },
  );
});

postgresTest(gate, "proof:watch.signal", async () => {
  await withApp(app, async (db) => {
    let calls = 0;
    const sub = db.watch("cache:users", () => {
      calls += 1;
    });
    await sub.run();
    expect(calls).toBe(1);
    await db.tx(async (tx) => {
      await tx.notify("cache:users");
    });
    await waitFor(() => calls === 2);
    try {
      await db.tx(async (tx) => {
        await tx.notify("cache:users");
        throw new Error("rollback");
      });
    } catch {
      // Rollback sends nothing.
    }
    await sleep(200);
    expect(calls).toBe(2);
    await sub.stop();
  });
});

postgresTest(
  gate,
  "proof:watch.until",
  async () => {
    await withApp(app, async (db) => {
      let caught: unknown;
      try {
        await db.orders.until({ where: { id: 99 } }, { timeout: "200ms" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      if (caught instanceof OkmError) expect(caught.kind).toBe("timeout");
      const pending = db.orders.until({ where: { id: 7, status: "paid" } }, { timeout: "5s" });
      await sleep(30);
      await db.orders.insert({ id: 7, status: "paid" });
      const row = await pending;
      expect(row).toMatchObject({ id: 7, status: "paid" });
    });
  },
  8_000,
);

postgresTest(gate, "watch reads the row that existed before LISTEN", async () => {
  await withApp(app, async (db) => {
    await db.jobs.insert({ id: 1, status: "open" });
    let seen = 0;
    const sub = db.jobs.watch(async () => {
      const rows = await db.jobs.find({ where: { status: "open" }, limit: 10 });
      seen = rows.length;
    });
    await sub.run();
    expect(seen).toBe(1);
    await sub.stop();
  });
});

postgresTest(
  gate,
  "a scoped live read hides another tenant, including under a policy",
  async () => {
    const notes = table(
      "notes",
      { id: t.integer().primaryKey(), title: t.text() },
      { watch: true },
    );
    const columned = schema({
      casing: "snake",
      tenancy: columnTenancy({ key: "tenantId", type: "text" }),
      tables: [notes],
    });
    const acme = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
    const beta = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
    const secured = table(
      "secured",
      { id: t.uuid().primaryKey(), title: t.text() },
      { watch: true },
    );
    const guarded = schema({
      casing: "snake",
      tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
      tables: [secured],
    });
    await withApp(columned, async (db) => {
      await db.for({ tenantId: "acme" }).notes.insert({ id: 1, title: "acme" });
      await db.for({ tenantId: "beta" }).notes.insert({ id: 2, title: "beta" });
      let titles: string[] = [];
      const sub = db.for({ tenantId: "acme" }).notes.watch({ limit: 10 }, (rows) => {
        titles = rows.map((row) => row.title);
      });
      await sub.run();
      expect(titles).toEqual(["acme"]);
      await sub.stop();
    });
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const role = `okm_watch_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      for (const statement of renderCatalog(guarded.catalog, "public"))
        await admin.unsafe(statement);
      await admin.unsafe(
        `create role ${role} login password 'watch-plain' nosuperuser nobypassrls`,
      );
      const name = new URL(database.url).pathname.slice(1);
      await admin.unsafe(`grant connect on database ${name} to ${role}`);
      await admin.unsafe(`grant usage on schema public to ${role}`);
      await admin.unsafe(
        `grant select, insert, update, delete on all tables in schema public to ${role}`,
      );
      const roleUrl = new URL(database.url);
      roleUrl.username = role;
      roleUrl.password = "watch-plain";
      const db = connect(roleUrl.href, { schema: guarded, max: 2 });
      try {
        await db.for({ tenantId: acme }).secured.insert({ id: acme, title: "acme" });
        await db.for({ tenantId: beta }).secured.insert({ id: beta, title: "beta" });
        let titles: string[] = [];
        const sub = db.for({ tenantId: acme }).secured.watch({ limit: 10 }, (rows) => {
          titles = rows.map((row) => row.title);
        });
        await sub.run();
        expect(titles).toEqual(["acme"]);
        await sub.stop();
      } finally {
        await db.close();
      }
    } finally {
      await admin.unsafe(`drop role if exists ${role}`).catch(() => undefined);
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
);

postgresTest(
  gate,
  "a tenant payload over 7900 bytes wakes every scoped watcher",
  async () => {
    const notes = table("wide", { id: t.integer().primaryKey() }, { watch: true });
    const columned = schema({
      casing: "snake",
      tenancy: columnTenancy({ key: "tenantId", type: "text" }),
      tables: [notes],
    });
    await withApp(columned, async (db, url) => {
      let wakes = 0;
      const sub = db.for({ tenantId: "zzzz-not-in-the-statement" }).wide.watch(() => {
        wakes += 1;
      });
      await sub.run();
      const base = wakes;
      const sql = openPostgres(url);
      await sql.unsafe(
        `insert into wide (id, tenant_id) select i, 'other-' || i from generate_series(1, 40) s(i)`,
      );
      await sleep(200);
      expect(wakes).toBe(base);
      const fat = Array.from(
        { length: 600 },
        (_, index) => `k${String(index).padStart(5, "0")}-pad-value`,
      );
      await sql.unsafe(
        `insert into wide (id, tenant_id) select 1000 + i, v from unnest($1::text[]) with ordinality as u(v, i)`,
        [fat],
      );
      await waitFor(() => wakes > base);
      await sql.end({ timeout: 5 });
      await sub.stop();
    });
  },
  15_000,
);

postgresTest(
  gate,
  "throttle keeps a minimum gap between runs",
  async () => {
    await withApp(app, async (db) => {
      const stamps: number[] = [];
      const sub = db.orders.watch({ every: "1s", throttle: "1s" }, () => {
        stamps.push(Date.now());
      });
      await sub.run();
      await db.orders.insert({ id: 1, status: "open" });
      await db.orders.insert({ id: 2, status: "open" });
      await db.orders.insert({ id: 3, status: "open" });
      await sleep(1_500);
      expect(stamps.length).toBeGreaterThanOrEqual(2);
      expect(stamps.length).toBeLessThanOrEqual(3);
      const gap = (stamps[1] ?? 0) - (stamps[0] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(900);
      await sub.stop();
    });
  },
  8_000,
);

postgresTest(gate, "introspect then re-plan of a watch trigger is zero steps", async () => {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await sql.unsafe(statement);
    const live = await introspectSchema(queryOf(sql), "public", "public");
    const again = planMigration({
      before: live,
      after: app.catalog,
      schema: "public",
      name: "again",
    });
    expect(again.steps.map((step) => `${step.kind} ${step.sql}`)).toEqual([]);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(
  gate,
  "push false installs no trigger and push required fails on a pooler",
  async () => {
    const hot = table("hot", { id: t.integer().primaryKey() }, { watch: { push: false } });
    const quiet = schema({ casing: "snake", tables: [hot] });
    await withApp(quiet, async (db) => {
      const sub = db.hot.watch(() => undefined);
      await sub.run();
      expect(sub.state).toBe("poll");
      await sub.stop();
    });
  },
);

postgresTest(
  gate,
  "terminating the listen backend reconnects and the handler runs again",
  async () => {
    await withApp(app, async (db, url) => {
      let calls = 0;
      const sub = db.orders.watch(() => {
        calls += 1;
      });
      await sub.run();
      expect(sub.state).toBe("push");
      const sql = openPostgres(url);
      const rows = await sql<
        { pid: number }[]
      >`select pid from pg_stat_activity where application_name = 'okm-listen'`;
      expect(rows.length).toBeGreaterThan(0);
      const pid = rows[0]?.pid;
      await sql.unsafe(`select pg_terminate_backend(${String(pid)})`);
      await sql.end({ timeout: 5 });
      await waitFor(() => calls >= 2, 8_000);
      expect(sub.state).toBe("push");
      await sub.stop();
    });
  },
  15_000,
);

postgresTest(
  gate,
  "a TCP blackhole on postgres.js is caught by the heartbeat and recovers",
  async () => {
    await blackhole(connect, 16541);
  },
  70_000,
);

postgresTest(
  gate,
  "a TCP blackhole on pg is caught by the heartbeat and recovers",
  async () => {
    await blackhole(connectPg, 16542);
  },
  70_000,
);

postgresTest(
  gate,
  "PgBouncer transaction mode polls and session mode pushes",
  async () => {
    const database = await createIsolatedDatabase();
    const tx = await bouncer("okm-bouncer-tx", 16432, "transaction", database.url);
    const session = await bouncer("okm-bouncer-session", 16433, "session", database.url);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const sql = openPostgres(database.url);
      for (const statement of renderCatalog(app.catalog, "public")) await sql.unsafe(statement);
      await sql.end({ timeout: 5 });
      const healthy = await watchDoctorText(database.url);
      expect(healthy).toContain("watch: push works on this URL");
      expect(healthy).not.toContain("127.0.0.1");
      const pooled = connect(tx.url, { schema: app, max: 2 });
      const sub = pooled.orders.watch(() => undefined);
      await sub.run();
      expect(sub.state).toBe("poll");
      const polling = warnings.filter((line) => line.includes("okmodel: watch is polling"));
      // The process warns once. An earlier degrade in this file may already have printed it.
      expect(polling.length).toBeLessThanOrEqual(1);
      const required = pooled.orders.watch(() => undefined, { push: "required" });
      let refused: unknown;
      try {
        await required.run();
      } catch (error) {
        refused = error;
      }
      expect(refused).toMatchObject({ code: "OKM1934" });
      await sub.stop();
      await required.stop();
      const doctor = await watchDoctorText(tx.url);
      expect(doctor).toContain("push does not work on this URL");
      expect(doctor).not.toContain("16432");
      await pooled.close();

      const direct = connect(session.url, { schema: app, max: 2 });
      const pushed = direct.orders.watch(() => undefined);
      await pushed.run();
      expect(pushed.state).toBe("push");
      await pushed.stop();
      await direct.close();
    } finally {
      console.warn = warn;
      await tx.close();
      await session.close();
      await database.close();
    }
  },
  40_000,
);

postgresTest(
  gate,
  "LISTEN on a hot standby",
  async () => {
    const sql = openPostgres(replicaUrl("a"));
    let server = "";
    try {
      await sql.unsafe("listen okm_standby_probe");
      server = "accepted LISTEN";
      await sql.unsafe("unlisten okm_standby_probe");
    } catch (error) {
      server = error instanceof Error ? error.message : "LISTEN failed";
    } finally {
      await sql.end({ timeout: 5 });
    }
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    try {
      for (const statement of renderCatalog(app.catalog, "public")) await admin.unsafe(statement);
      await admin.end({ timeout: 5 });
      const replica = new URL(replicaUrl("a"));
      const target = new URL(database.url);
      replica.pathname = target.pathname;
      const db = connect(replica.href, { schema: app, max: 1 });
      const sub = db.orders.watch(() => undefined);
      let failed = "";
      try {
        await sub.run();
      } catch (error) {
        failed = error instanceof Error ? error.message : "watch failed";
      }
      expect(server).toContain("cannot execute LISTEN during recovery");
      expect(sub.state).toBe("poll");
      expect(failed).toBe("");
      await sub.stop();
      await db.close();
    } finally {
      await database.close();
    }
  },
  20_000,
);

postgresTest(
  gate,
  "statement trigger write cost against no trigger and push false",
  async () => {
    const plain = schema({
      casing: "snake",
      tables: [table("plain_cost", { id: t.integer().primaryKey(), n: t.integer() })],
    });
    const pushed = schema({
      casing: "snake",
      tables: [
        table("push_cost", { id: t.integer().primaryKey(), n: t.integer() }, { watch: true }),
      ],
    });
    const quiet = schema({
      casing: "snake",
      tables: [
        table(
          "quiet_cost",
          { id: t.integer().primaryKey(), n: t.integer() },
          { watch: { push: false } },
        ),
      ],
    });
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      for (const statement of [
        ...renderCatalog(plain.catalog, "public"),
        ...renderCatalog(pushed.catalog, "public"),
        ...renderCatalog(quiet.catalog, "public"),
      ]) {
        await sql.unsafe(statement);
      }
      const sample = 20_000;
      const none = await timedCommits(sql, "plain_cost", sample);
      const trigger = await timedCommits(sql, "push_cost", sample);
      const off = await timedCommits(sql, "quiet_cost", sample);
      const workers = 8;
      const each = 2_500;
      const noneParallel = await timedParallel(database.url, "plain_cost", workers, each);
      const triggerParallel = await timedParallel(database.url, "push_cost", workers, each);
      const offParallel = await timedParallel(database.url, "quiet_cost", workers, each);
      expect(none).toBeGreaterThan(0);
      expect(trigger).toBeGreaterThan(0);
      expect(off).toBeGreaterThan(0);
      expect(noneParallel).toBeGreaterThan(0);
      expect(triggerParallel).toBeGreaterThan(0);
      expect(offParallel).toBeGreaterThan(0);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "a wake during a shared read reaches a subscriber that joins late",
  async () => {
    await withApp(app, async (db, url) => {
      const sql = openPostgres(url);
      try {
        await installNap(sql, 6);
        const slow = { where: { status: fragment`(select okm_nap())` }, limit: 20 };
        const seen: string[][] = [];
        const left = db.orders.watch(slow, { every: "10m" }, (rows) => {
          seen.push(rows.map((row) => row.status));
        });
        await waitForSleep(url);
        await db.orders.insert({ id: 1, status: "open" });
        await sleep(800);
        if (left.stats.wakes < 1) {
          throw new Error(
            `no wake state=${left.state} wakes=${String(left.stats.wakes)} runs=${String(left.stats.runs)} errors=${String(left.stats.errors)} queries=${String(left.stats.queries)}`,
          );
        }
        const joined: string[][] = [];
        const right = db.orders.watch(slow, { every: "10m" }, (rows) => {
          joined.push(rows.map((row) => row.status));
        });
        await waitFor(() => joined.some((rows) => rows.includes("open")), 3_000);
        await waitFor(() => seen.some((rows) => rows.includes("open")), 12_000);
        expect(right.stats.queries).toBeGreaterThan(0);
        await left.stop();
        await right.stop();
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
  25_000,
);

postgresTest(
  gate,
  "until does not join a read that started before the wake",
  async () => {
    await withApp(app, async (db, url) => {
      const sql = openPostgres(url);
      try {
        await installNap(sql, 6);
        const slow = { where: { status: fragment`(select okm_nap())` }, limit: 1 };
        const left = db.orders.watch(slow, { every: "10m" }, () => undefined);
        await waitForSleep(url);
        await db.orders.insert({ id: 7, status: "open" });
        await waitFor(() => left.stats.wakes >= 1);
        const started = Date.now();
        const row = await db.orders.until(slow, { timeout: "8s" });
        expect(Date.now() - started).toBeLessThan(2_500);
        expect(row).toMatchObject({ id: 7, status: "open" });
        await left.stop();
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
  20_000,
);

postgresTest(
  gate,
  "identical subscriptions share one query when no wake lands during the read",
  async () => {
    let finds = 0;
    await withApp(
      app,
      async (db) => {
        const query = { where: { status: "open" }, limit: 10 };
        const left = db.orders.watch(query, { every: "10m" }, () => undefined);
        const right = db.orders.watch(query, { every: "10m" }, () => undefined);
        await left.run();
        await right.run();
        const before = finds;
        await db.orders.insert({ id: 1, status: "open" });
        await waitFor(() => finds >= before + 1);
        await sleep(300);
        expect(finds - before).toBe(1);
        expect(left.stats.queries + right.stats.queries).toBe(finds);
        await left.stop();
        await right.stop();
      },
      (event) => {
        if (event.op === "find") finds += 1;
      },
    );
  },
  15_000,
);

postgresTest(
  gate,
  "scoped clients do not share a live read",
  async () => {
    const notes = table(
      "notes",
      { id: t.integer().primaryKey(), title: t.text() },
      { watch: true },
    );
    const columned = schema({
      casing: "snake",
      tenancy: columnTenancy({ key: "tenantId", type: "text" }),
      tables: [notes],
    });
    const acme = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
    const beta = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
    await withApp(columned, async (db, url) => {
      const sql = openPostgres(url);
      try {
        await installNap(sql, 4);
        const slow = { where: { title: fragment`(select okm_nap())` }, limit: 5 };
        const left = db
          .for({ tenantId: acme })
          .notes.watch(slow, { every: "10m" }, () => undefined);
        await waitForSleep(url);
        const started = Date.now();
        const right = db
          .for({ tenantId: beta })
          .notes.watch(slow, { every: "10m" }, () => undefined);
        await right.run();
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(left.stats.queries + right.stats.queries).toBe(2);
        await left.stop();
        await right.stop();
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
  20_000,
);

postgresTest(
  gate,
  "stop waits for the handler and nothing runs after the pool closes",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const db = connect(database.url, { schema: app, max: 2 }) as unknown as Client;
    let calls = 0;
    let finished = false;
    let errors = 0;
    try {
      for (const statement of renderCatalog(app.catalog, "public")) await sql.unsafe(statement);
      {
        await using updates = db.orders.watch(
          async () => {
            calls += 1;
            await sleep(400);
            finished = true;
          },
          {
            every: "10m",
            onError: () => {
              errors += 1;
            },
          },
        );
        await waitFor(() => calls === 1);
        void updates;
      }
      expect(finished).toBe(true);
      const after = calls;
      await db.close();
      await sleep(500);
      expect(calls).toBe(after);
      expect(errors).toBe(0);
      let thrown = false;
      const again = connect(database.url, { schema: app, max: 1 }) as unknown as Client;
      try {
        let seen: unknown;
        const sub = again.orders.watch(
          () => {
            thrown = true;
            throw new Error("handler failed");
          },
          {
            every: "10m",
            onError: (error: unknown) => {
              seen = error;
            },
          },
        );
        await sub.run();
        await sub.stop();
        expect(thrown).toBe(true);
        expect(seen).toBeInstanceOf(Error);
      } finally {
        await again.close();
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  15_000,
);

postgresTest(
  gate,
  "stop inside a push handler resolves and nothing runs after",
  async () => {
    await withApp(app, async (db) => {
      let calls = 0;
      let mode = "";
      let handle!: Handle;
      handle = db.orders.watch(
        async () => {
          calls += 1;
          mode = handle.state;
          if (calls === 1) return;
          await sleep(20);
          await handle.stop();
        },
        { every: "10m" },
      );
      await handle.run();
      await waitFor(() => handle.state === "push");
      expect(calls).toBe(1);
      await db.orders.insert({ id: 1, status: "open" });
      await waitFor(() => handle.state === "stopped");
      expect(mode).toBe("push");
      expect(calls).toBe(2);
      await db.orders.insert({ id: 2, status: "open" });
      await sleep(300);
      expect(calls).toBe(2);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "truncate wakes a live read",
  async () => {
    await withApp(app, async (db, url) => {
      await db.orders.insert({ id: 1, status: "open" });
      const seen: number[] = [];
      const sub = db.orders.watch({ limit: 10 }, { every: "10m" }, (rows) => {
        seen.push(rows.length);
      });
      await sub.run();
      expect(seen.at(-1)).toBe(1);
      const sql = openPostgres(url);
      try {
        const triggers = await sql.unsafe(
          `select tgname from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           where c.relname = 'orders' and t.tgname like 'okm_watch_%' and not t.tgisinternal
           order by 1`,
        );
        expect(triggers.map((row) => String(row.tgname))).toEqual([
          "okm_watch_delete",
          "okm_watch_insert",
          "okm_watch_truncate",
          "okm_watch_update",
        ]);
        await sql.unsafe("truncate orders");
      } finally {
        await sql.end({ timeout: 5 });
      }
      await waitFor(() => seen.at(-1) === 0, 3_000);
      await sub.stop();
    });
  },
  15_000,
);

postgresTest(gate, "truncate on a partitioned parent wakes and replans clean", async () => {
  const events = table(
    "events",
    { id: t.integer(), tenantId: t.integer(), body: t.text() },
    {
      primaryKey: ["id", "tenantId"],
      watch: true,
      partition: { by: "hash", key: "tenantId", count: 4 },
    },
  );
  const partitioned = schema({ casing: "snake", tables: [events] });
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  const db = connect(database.url, { schema: partitioned, max: 2 }) as unknown as Client & {
    events: TableApi;
  };
  try {
    const plan = planMigration({
      before: catalog([]),
      after: partitioned.catalog,
      schema: "public",
      name: "create",
    });
    for (const step of plan.steps) await sql.unsafe(step.sql);
    await db.events.insert({ id: 1, tenantId: 1, body: "a" });
    const seen: number[] = [];
    const sub = db.events.watch({ limit: 10 }, { every: "10m" }, (rows) => {
      seen.push(rows.length);
    });
    await sub.run();
    expect(seen.at(-1)).toBe(1);
    await sql.unsafe("truncate events");
    await waitFor(() => seen.at(-1) === 0, 3_000);
    await sub.stop();
    const live = await introspectSchema(queryOf(sql), "public", "public");
    const again = planMigration({
      before: live,
      after: partitioned.catalog,
      schema: "public",
      name: "again",
    });
    expect(again.steps.map((step) => `${step.kind} ${step.sql}`)).toEqual([]);
    await db.close();
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

async function installNap(sql: ReturnType<typeof openPostgres>, seconds: number): Promise<void> {
  await sql.unsafe(
    `create sequence if not exists okm_nap_seq;
     create or replace function okm_nap() returns boolean language plpgsql volatile as $fn$
     begin
       if nextval('okm_nap_seq') = 1 then
         perform pg_sleep(${String(seconds)});
       end if;
       return true;
     end
     $fn$`,
  );
}

async function waitForSleep(url: string): Promise<void> {
  const sql = openPostgres(url);
  const deadline = Date.now() + 5_000;
  try {
    for (;;) {
      const rows = await sql.unsafe(
        `select query from pg_stat_activity
         where state = 'active' and query ilike '%okm_nap%' and query not ilike '%pg_stat_activity%'`,
      );
      if (rows.length > 0) return;
      if (Date.now() > deadline) {
        const active = await sql.unsafe(
          `select state, left(query, 180) as query from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid()`,
        );
        throw new Error(`okm_nap did not start: ${JSON.stringify(active)}`);
      }
      await sleep(20);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function blackhole(open: typeof connect, port: number): Promise<void> {
  const database = await createIsolatedDatabase();
  const proxy = await tcpProxy(port);
  const sql = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await sql.unsafe(statement);
    const target = new URL(database.url);
    target.hostname = "127.0.0.1";
    target.port = String(port);
    const db = open(target.href, { schema: app, max: 2 });
    let calls = 0;
    const sub = db.orders.watch(() => {
      calls += 1;
    });
    await sub.run();
    expect(sub.state).toBe("push");
    proxy.freeze();
    await waitFor(() => sub.state === "poll", 50_000);
    const mid = calls;
    proxy.resume();
    await waitFor(() => sub.state === "push" && calls > mid, 15_000);
    await sub.stop();
    await db.close();
  } finally {
    await sql.end({ timeout: 5 });
    await proxy.close();
    await database.close();
  }
}

async function timedCommits(
  sql: ReturnType<typeof openPostgres>,
  tableName: string,
  sample: number,
): Promise<number> {
  await sql.unsafe(
    `create or replace procedure okm_bench(n int) language plpgsql as $p$
     declare i int;
     begin
       for i in 1..n loop
         insert into ${tableName}(id, n) values (i, 1);
         commit;
       end loop;
     end
     $p$`,
  );
  const started = await sql.unsafe(`select clock_timestamp() as t`);
  await sql.unsafe(`call okm_bench(${String(sample)})`);
  const ended = await sql.unsafe(`select clock_timestamp() as t`);
  return millis(ended[0]?.t) - millis(started[0]?.t);
}

type Rows = { id: number; status: string; title: string };
type Handle = {
  readonly state: string;
  readonly stats: {
    readonly runs: number;
    readonly errors: number;
    readonly wakes: number;
    readonly queries: number;
  };
  run(): Promise<void>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
type TableApi = {
  insert(row: object): Promise<unknown>;
  find(options: object): Promise<Rows[]>;
  watch(handler: () => unknown, options?: object): Handle;
  watch(query: object, handler: (rows: Rows[]) => unknown): Handle;
  watch(query: object, options: object, handler: (rows: Rows[]) => unknown): Handle;
  until(query: object, options: object): Promise<Rows>;
};
type Client = {
  orders: TableApi;
  jobs: TableApi;
  notes: TableApi;
  wide: TableApi;
  hot: TableApi;
  secured: TableApi;
  watch(channel: string, handler: () => void): Handle;
  notify(channel: string): Promise<void>;
  for(input: { tenantId: string }): Client;
  tx<T>(fn: (tx: Client) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

async function withApp(
  built: { readonly catalog: Catalog },
  run: (db: Client, url: string) => Promise<void>,
  onQuery?: (event: { readonly op: string }) => void,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  const db = connect(database.url, {
    schema: built as never,
    max: 4,
    ...(onQuery !== undefined ? { onQuery: queryObserver({ query: onQuery }) } : {}),
  }) as unknown as Client;
  try {
    for (const statement of renderCatalog(built.catalog, "public")) await sql.unsafe(statement);
    await run(db, database.url);
  } finally {
    await db.close();
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

function queryOf(sql: ReturnType<typeof openPostgres>): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

function tcpProxy(
  port: number,
): Promise<{ freeze(): void; resume(): void; close(): Promise<void> }> {
  let drop = false;
  const server = net.createServer((client) => {
    const upstream = net.connect(55432, "127.0.0.1");
    const forward = (from: net.Socket, to: net.Socket): void => {
      from.on("data", (chunk) => {
        if (!drop) to.write(chunk);
      });
      from.on("error", () => undefined);
      from.on("close", () => to.end());
    };
    forward(client, upstream);
    forward(upstream, client);
  });
  return new Promise((resolve, reject) => {
    (server as unknown as { on(event: string, listener: (error: unknown) => void): void }).on(
      "error",
      reject,
    );
    server.listen(port, "127.0.0.1", () => {
      resolve({
        freeze() {
          drop = true;
        },
        resume() {
          drop = false;
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function bouncer(
  name: string,
  port: number,
  mode: "transaction" | "session",
  upstream: string,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const parsed = new URL(upstream);
  await run(["docker", "rm", "-f", name]);
  const created = await run([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--add-host=host.docker.internal:host-gateway",
    "-p",
    `${String(port)}:5432`,
    "-e",
    `DATABASE_URL=postgres://${parsed.username}:${parsed.password}@host.docker.internal:${parsed.port}${parsed.pathname}`,
    "-e",
    `POOL_MODE=${mode}`,
    "-e",
    "AUTH_TYPE=plain",
    "-e",
    `DB_USER=${parsed.username}`,
    "-e",
    `DB_PASSWORD=${parsed.password}`,
    "-e",
    "IGNORE_STARTUP_PARAMETERS=extra_float_digits",
    "edoburu/pgbouncer:latest",
  ]);
  if (created.code !== 0) throw new Error(`pgbouncer ${mode} did not start`);
  const url = `postgres://${parsed.username}:${parsed.password}@127.0.0.1:${String(port)}${parsed.pathname}`;
  const deadline = Date.now() + 10_000;
  let last = "";
  while (Date.now() < deadline) {
    const probe = openPostgres(url);
    try {
      await probe`select 1`;
      await probe.end({ timeout: 5 });
      return {
        url,
        async close() {
          await run(["docker", "rm", "-f", name]);
        },
      };
    } catch (error) {
      last = error instanceof Error ? error.message : "not ready";
      await probe.end({ timeout: 1 }).catch(() => undefined);
      await sleep(200);
    }
  }
  throw new Error(`pgbouncer ${mode} did not accept a connection (${last})`);
}

function run(args: string[]): Promise<{ readonly code: number }> {
  return new Promise((resolve) => {
    Bun.spawn(args, {
      stdout: "ignore",
      stderr: "ignore",
      onExit(_proc, code) {
        resolve({ code: code ?? 1 });
      },
    });
  });
}

async function waitFor(ready: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

async function timedParallel(
  url: string,
  tableName: string,
  workers: number,
  each: number,
): Promise<number> {
  const clients = Array.from({ length: workers }, () => openPostgres(url));
  try {
    await clients[0]?.unsafe(
      `create or replace procedure okm_bench_range(start_id int, n int) language plpgsql as $p$
       declare i int;
       begin
         for i in start_id..start_id + n - 1 loop
           insert into ${tableName}(id, n) values (i, 1);
           commit;
         end loop;
       end
       $p$`,
    );
    const started = performance.now();
    await Promise.all(
      clients.map((client, worker) =>
        client.unsafe(`call okm_bench_range(${String(worker * each + 100_000)}, ${String(each)})`),
      ),
    );
    return performance.now() - started;
  } finally {
    await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
  }
}

function millis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
