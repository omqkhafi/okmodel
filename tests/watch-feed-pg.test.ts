/**
 * Durable change feed on Postgres.
 *
 * The horizon hides a later commit while an earlier transaction is open.
 * A lease fails over. The cursor commits with `{ tx }`. Retention calls
 * `onResync`. Statement triggers insert once per statement.
 */

import { expect } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { watchDoctorText } from "../src/tooling/migrate/doctor-watch.js";

const gate = await loadPostgresGate();

const products = table(
  "products",
  { id: t.integer().primaryKey() },
  { watch: { feed: { keep: "1d" } } },
);
const audit = table("audit", { id: t.integer().primaryKey(), note: t.text() });
const app = schema({ casing: "snake", tables: [products, audit] });

type Change = { readonly op: string; readonly key: { readonly id?: unknown } };
type Handle = {
  readonly state: string;
  run(): Promise<void>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
type Db = {
  products: {
    insert(row: object): Promise<unknown>;
    find(options?: object): Promise<readonly { readonly id: number }[]>;
    watch(
      options: object,
      handler: (changes: readonly Change[], ctx: { readonly tx: Db }) => unknown,
    ): Handle;
  };
  audit: {
    insert(row: object): Promise<unknown>;
    find(options?: object): Promise<readonly { readonly id: number }[]>;
  };
  for(input: { tenantId: string }): Db;
  close(): Promise<void>;
};

postgresTest(gate, "proof:watch.feed", async () => {
  await withFeed(app, async (db, url, sql) => {
    const hold = openPostgres(url);
    const seen: number[] = [];
    try {
      await hold.unsafe("begin");
      await hold.unsafe("insert into products (id) values (1)");
      await sql.unsafe("insert into products (id) values (2)");
      const sub = db.products.watch({ feed: "search", every: "30s" }, (changes) => {
        for (const change of changes)
          if (typeof change.key.id === "number") seen.push(change.key.id);
      });
      await sub.run();
      expect(seen).toEqual([]);
      await hold.unsafe("commit");
      await sub.run();
      expect(seen).toEqual([1, 2]);
      await sub.stop();
    } finally {
      await hold.end({ timeout: 5 });
    }
  });
});

postgresTest(
  gate,
  "a slow feed handler does not skip a concurrent write",
  async () => {
    await withFeed(app, async (db) => {
      let release: () => void = () => undefined;
      let blocked = false;
      const seen: number[] = [];
      const sub = db.products.watch({ feed: "search", every: "30s" }, async (changes) => {
        for (const change of changes) {
          if (typeof change.key.id === "number") seen.push(change.key.id);
        }
        if (!blocked) {
          blocked = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      });
      await sub.run();
      await db.products.insert({ id: 1 });
      const running = sub.run();
      await waitFor(() => seen.length === 1);
      await db.products.insert({ id: 2 });
      await db.products.insert({ id: 3 });
      release();
      await running;
      await sub.run();
      expect(seen).toEqual([1, 2, 3]);
      await sub.stop();
    });
  },
  20_000,
);

postgresTest(
  gate,
  "two feed names each see every change",
  async () => {
    await withFeed(app, async (db) => {
      const left: number[] = [];
      const right: number[] = [];
      const take = (into: number[]) => (changes: readonly Change[]) => {
        for (const change of changes) {
          if (typeof change.key.id === "number") into.push(change.key.id);
        }
      };
      const a = db.products.watch({ feed: "search", every: "30s" }, take(left));
      const b = db.products.watch({ feed: "cache", every: "30s" }, take(right));
      await a.run();
      await b.run();
      await db.products.insert({ id: 1 });
      await db.products.insert({ id: 2 });
      await a.run();
      await b.run();
      expect(left).toEqual([1, 2]);
      expect(right).toEqual([1, 2]);
      await a.stop();
      await b.stop();
    });
  },
  20_000,
);

postgresTest(
  gate,
  "the feed cursor commits and rolls back with the handler transaction",
  async () => {
    const quiet = schema({
      casing: "snake",
      tables: [
        table(
          "products",
          { id: t.integer().primaryKey() },
          { watch: { push: false, feed: { keep: "1d" } } },
        ),
        table("audit", { id: t.integer().primaryKey(), note: t.text() }),
      ],
    });
    await withFeed(quiet, async (db) => {
      let fail = true;
      const seen: number[] = [];
      const sub = db.products.watch({ feed: "audit", every: "30s" }, async (changes, { tx }) => {
        const id = changes[0]?.key.id;
        if (typeof id !== "number") return;
        seen.push(id);
        await tx.audit.insert({ id, note: "seen" });
        if (fail) throw new Error("rollback the cursor");
      });
      await sub.run();
      await db.products.insert({ id: 7 });
      await sub.run();
      expect(seen).toEqual([7]);
      expect(await db.audit.find({ limit: 10 })).toEqual([]);
      fail = false;
      await sub.run();
      expect(seen).toEqual([7, 7]);
      expect((await db.audit.find({ limit: 10 })).map((row) => row.id)).toEqual([7]);
      await sub.run();
      expect(seen).toEqual([7, 7]);
      await sub.stop();
    });
  },
  20_000,
);

postgresTest(
  gate,
  "feed stop from outside, inside, onError, signal, and await using releases the lease",
  async () => {
    await withFeed(app, async (db, url) => {
      let release: () => void = () => undefined;
      let calls = 0;
      const outside = db.products.watch({ feed: "out", every: "30s" }, async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await outside.run();
      await db.products.insert({ id: 1 });
      const running = outside.run();
      await waitFor(() => calls === 1);
      const stopping = outside.stop();
      await db.products.insert({ id: 2 });
      release();
      await running;
      await stopping;
      await sleep(200);
      expect(calls).toBe(1);
      expect(outside.state).toBe("stopped");
      await expectLeaseFree(url);

      let inside: Handle | undefined;
      let inner = 0;
      inside = db.products.watch({ feed: "in", every: "30s" }, async (changes) => {
        inner += 1;
        if (changes.length > 0) await inside?.stop();
      });
      await inside.run();
      await db.products.insert({ id: 3 });
      await inside.run();
      expect(inside.state).toBe("stopped");
      expect(inner).toBe(1);
      await expectLeaseFree(url);

      let broken: Handle | undefined;
      let errors = 0;
      broken = db.products.watch(
        {
          feed: "err",
          every: "30s",
          onError() {
            errors += 1;
            void broken?.stop();
          },
        },
        async () => {
          throw new Error("handler failed");
        },
      );
      await broken.run();
      await db.products.insert({ id: 4 });
      await broken.run();
      expect(errors).toBe(1);
      expect(broken.state).toBe("stopped");
      await expectLeaseFree(url);

      const ac = new AbortController();
      let signals = 0;
      const flagged = db.products.watch({ feed: "sig", every: "1s", signal: ac.signal }, () => {
        signals += 1;
      });
      await flagged.run();
      const settled = signals;
      await db.products.insert({ id: 5 });
      await flagged.run();
      expect(signals).toBe(settled + 1);
      ac.abort();
      await sleep(50);
      await db.products.insert({ id: 6 });
      await sleep(1_200);
      expect(signals).toBe(settled + 1);
      expect(flagged.state).toBe("stopped");
      await expectLeaseFree(url);

      let disposed = 0;
      let held = 0;
      {
        await using scoped = db.products.watch({ feed: "use", every: "30s" }, () => {
          disposed += 1;
        });
        await scoped.run();
        const base = disposed;
        await db.products.insert({ id: 8 });
        await scoped.run();
        expect(disposed).toBe(base + 1);
        held = disposed;
      }
      await db.products.insert({ id: 9 });
      await sleep(200);
      expect(disposed).toBe(held);
      await expectLeaseFree(url);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a stale feed cursor resyncs, and the default error is OKM1935",
  async () => {
    const brief = schema({
      casing: "snake",
      tables: [
        table("products", { id: t.integer().primaryKey() }, { watch: { feed: { keep: "1s" } } }),
      ],
    });
    await withFeed(brief, async (db, _url, sql) => {
      const sub = db.products.watch({ feed: "search", every: "30s" }, () => undefined);
      await sub.run();
      await db.products.insert({ id: 1 });
      await sub.run();
      await sub.stop();
      await sleep(1_200);
      const prune = db.products.watch({ feed: "search", every: "30s" }, () => undefined);
      await prune.run();
      await prune.stop();
      const left = await sql.unsafe(`select count(*)::text as n from okm_changes`);
      expect(left[0]?.n).toBe("0");
      await sql.unsafe(`update okm_cursors set seq = 0 where name = 'search'`);
      let info = "";
      const again = db.products.watch(
        {
          feed: "search",
          every: "30s",
          onResync(resync: { readonly feed: string; readonly cursor: string }) {
            info = `${resync.feed} ${resync.cursor}`;
          },
        },
        () => undefined,
      );
      await again.run();
      expect(info).toBe("search 0");
      await again.stop();
      await db.products.insert({ id: 2 });
      const after: number[] = [];
      const next = db.products.watch({ feed: "search", every: "30s" }, (changes) => {
        for (const change of changes) {
          if (typeof change.key.id === "number") after.push(change.key.id);
        }
      });
      await next.run();
      expect(after).toEqual([2]);
      await next.stop();

      const errors: unknown[] = [];
      const stale = db.products.watch(
        {
          feed: "other",
          every: "30s",
          onError(error: unknown) {
            errors.push(error);
          },
        },
        () => undefined,
      );
      await stale.run();
      expect(errors[0]).toBeInstanceOf(OkmError);
      if (errors[0] instanceof OkmError) expect(errors[0].code).toBe("OKM1935");
      await stale.stop();
    });
  },
  20_000,
);

postgresTest(
  gate,
  "feed triggers are one insert per statement, including truncate, rollback, tenant, and a partitioned parent",
  async () => {
    await withFeed(app, async (_db, _url, sql) => {
      const superuser = await sql.unsafe(`select current_setting('is_superuser') as s`);
      if (superuser[0]?.s === "on")
        await sql.unsafe(`select set_config('track_functions', 'all', false)`);
      await sql.unsafe(`insert into products (id) select g from generate_series(1, 10000) g`);
      await sql.unsafe(`update products set id = id where id <= 10000`);
      await sql.unsafe(`delete from products where id <= 10000`);
      const counts = await sql.unsafe(
        `select op, count(*)::text as n, count(distinct xid)::text as xids
         from okm_changes group by op order by op`,
      );
      expect(counts.map((row) => `${String(row.op)} ${String(row.n)} ${String(row.xids)}`)).toEqual(
        ["delete 10000 1", "insert 10000 1", "update 10000 1"],
      );
      if (superuser[0]?.s === "on") {
        await sql.unsafe(`select pg_stat_force_next_flush()`);
        const calls = await sql.unsafe(
          `select sum(calls)::text as calls from pg_stat_user_functions where funcname like 'okm_watch_%'`,
        );
        expect(Number(calls[0]?.calls)).toBe(3);
      }
      const mark = await sql.unsafe(`select coalesce(max(seq), 0)::text as seq from okm_changes`);
      await sql.unsafe("begin");
      await sql.unsafe(`insert into products (id) values (42)`);
      await sql.unsafe("rollback");
      const afterRollback = await sql.unsafe(
        `select count(*)::text as n from okm_changes where seq > $1::bigint`,
        [mark[0]?.seq ?? "0"],
      );
      expect(afterRollback[0]?.n).toBe("0");
      await sql.unsafe("truncate products");
      const truncated = await sql.unsafe(
        `select op, key::text as key from okm_changes where op = 'truncate'`,
      );
      expect(truncated.map((row) => `${String(row.op)} ${String(row.key)}`)).toEqual([
        "truncate {}",
      ]);
    });

    const tenanted = schema({
      casing: "snake",
      tenancy: columnTenancy({ key: "tenantId", type: "text" }),
      tables: [
        table("products", { id: t.integer().primaryKey() }, { watch: { feed: { keep: "1d" } } }),
      ],
    });
    await withFeed(tenanted, async (db) => {
      await db.for({ tenantId: "acme" }).products.insert({ id: 1 });
      await db.for({ tenantId: "beta" }).products.insert({ id: 2 });
      const seen: string[] = [];
      const sub = db
        .for({ tenantId: "acme" })
        .products.watch({ feed: "search", every: "30s" }, (changes) => {
          for (const change of changes) seen.push(`${change.op}:${shownId(change.key.id)}`);
        });
      await sub.run();
      expect(seen).toEqual(["insert:1"]);
      await sub.stop();
    });

    const events = table(
      "events",
      { id: t.integer(), tenantId: t.integer(), body: t.text() },
      {
        primaryKey: ["id", "tenantId"],
        watch: { feed: { keep: "1d" } },
        partition: { by: "hash", key: "tenantId", count: 4 },
      },
    );
    const partitioned = schema({ casing: "snake", tables: [events] });
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const db = connect(database.url, { schema: partitioned, max: 4 }) as unknown as Db & {
      events: {
        insert(row: object): Promise<unknown>;
        watch(options: object, handler: (changes: readonly Change[]) => unknown): Handle;
      };
    };
    try {
      const plan = planMigration({
        before: catalog([]),
        after: partitioned.catalog,
        schema: "public",
        name: "create",
      });
      for (const step of plan.steps) await sql.unsafe(step.sql);
      await sql.unsafe(
        `insert into events (id, tenant_id, body) values (1, 1, 'a'), (2, 2, 'b'), (3, 1, 'c')`,
      );
      const seen: string[] = [];
      const sub = db.events.watch({ feed: "search", every: "30s" }, (changes) => {
        for (const change of changes) seen.push(`${change.op}:${shownId(change.key.id)}`);
      });
      await sub.run();
      expect(seen.filter((item) => item.startsWith("insert:")).sort()).toEqual([
        "insert:1",
        "insert:2",
        "insert:3",
      ]);
      await sql.unsafe("truncate events");
      await sub.run();
      expect(seen).toContain("truncate:");
      await sub.stop();
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const again = planMigration({
        before: live,
        after: partitioned.catalog,
        schema: "public",
        name: "again",
      });
      expect(again.steps.map((step) => step.sql)).toEqual([]);
      await db.close();
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "feed and notify write overhead against no trigger",
  async () => {
    const plain = schema({
      casing: "snake",
      tables: [table("products", { id: t.integer().primaryKey() })],
    });
    const wake = schema({
      casing: "snake",
      tables: [table("products", { id: t.integer().primaryKey() }, { watch: true })],
    });
    const fed = schema({
      casing: "snake",
      tables: [
        table("products", { id: t.integer().primaryKey() }, { watch: { feed: { keep: "1d" } } }),
      ],
    });
    const samples = 500;
    const none = await timedInserts(plain, samples);
    const notified = await timedInserts(wake, samples);
    const stored = await timedInserts(fed, samples);
    const line = `feed overhead sample ${String(samples)} single-row inserts: none ${String(none)}ms, notify ${String(notified)}ms, feed ${String(stored)}ms`;
    console.info(line);
    appendFileSync("/tmp/feed-overhead.txt", `${line}\n`);
  },
  60_000,
);

postgresTest(
  gate,
  "doctor reports a healthy feed, a lagging feed, and a held horizon",
  async () => {
    await withFeed(app, async (db, url, sql) => {
      await db.products.insert({ id: 1 });
      const sub = db.products.watch({ feed: "search", every: "30s" }, () => undefined);
      await sub.run();
      await sub.stop();
      const healthy = await watchDoctorText(url);
      expect(healthy).toContain("feed products/search: cursor ");
      expect(healthy).toContain("lag 0s.");
      expect(healthy).toContain("feed horizon: no open transaction holds the snapshot.");
      await db.products.insert({ id: 2 });
      await db.products.insert({ id: 3 });
      await sleep(1_100);
      const lagging = await watchDoctorText(url);
      expect(lagging).toContain("feed products/search:");
      expect(lagging).not.toContain("lag 0s.");
      const hold = openPostgres(url);
      try {
        await hold.unsafe("begin");
        await hold.unsafe("insert into products (id) values (9)");
        const held = await watchDoctorText(url);
        expect(held).toContain("feed horizon: oldest open transaction is pid ");
        await hold.unsafe("rollback");
      } finally {
        await hold.end({ timeout: 5 });
      }
      await sql.unsafe(`delete from okm_cursors`);
      const empty = await watchDoctorText(url);
      expect(empty).toContain("feed: no consumers.");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a feed handler transaction on a transaction pooler is OKM1936",
  async () => {
    await withFeed(app, async (db, url) => {
      const pooled = await bouncer("okm-feed-bouncer", 6543, "transaction", url);
      const client = connect(pooled.url, {
        schema: app,
        max: 2,
        listenUrl: url,
      }) as unknown as Db;
      try {
        await db.products.insert({ id: 1 });
        const errors: unknown[] = [];
        const refused = client.products.watch(
          {
            feed: "search",
            every: "30s",
            onError(error: unknown) {
              errors.push(error);
            },
          },
          async (_changes, { tx }) => {
            await tx.products.find({});
          },
        );
        await refused.run();
        expect(errors[0]).toBeInstanceOf(OkmError);
        if (errors[0] instanceof OkmError) expect(errors[0].code).toBe("OKM1936");
        await refused.stop();
        const seen: number[] = [];
        const polled = client.products.watch({ feed: "cache", every: "30s" }, (changes) => {
          for (const change of changes) {
            if (typeof change.key.id === "number") seen.push(change.key.id);
          }
        });
        await polled.run();
        expect(seen).toEqual([1]);
        await polled.stop();
      } finally {
        await client.close();
        await pooled.close();
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "a killed feed holder hands the lease to the standby in order",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const db = connect(database.url, { schema: app, max: 4 }) as unknown as Db;
    const dir = mkdtempSync(join(tmpdir(), "okm-feed-lease-"));
    const log = join(dir, "seen.log");
    const procs: Bun.Subprocess[] = [];
    try {
      for (const statement of renderCatalog(app.catalog, "public")) await sql.unsafe(statement);
      for (let index = 0; index < 2; index += 1) {
        procs.push(
          Bun.spawn([process.execPath, "tests/feed-lease.worker.ts", database.url, log], {
            cwd: join(import.meta.dir, ".."),
            stdout: "ignore",
            stderr: "pipe",
          }),
        );
      }
      await sleep(800);
      await db.products.insert({ id: 1 });
      await db.products.insert({ id: 2 });
      await db.products.insert({ id: 3 });
      await waitFor(() => readLog(log).some((row) => row.id === "3"), 8_000);
      const active = readLog(log).find((row) => row.id === "1")?.pid;
      const victim = procs.find((proc) => String(proc.pid) === active);
      victim?.kill("SIGKILL");
      await db.products.insert({ id: 4 });
      await db.products.insert({ id: 5 });
      await waitFor(() => readLog(log).some((row) => row.id === "5"), 8_000);
      const ids = readLog(log).map((row) => row.id);
      expect(ids.filter((id, index) => ids.indexOf(id) === index)).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
      ]);
      const standby = readLog(log).find((row) => row.id === "5")?.pid;
      expect(standby).not.toBe(active);
    } finally {
      for (const proc of procs) proc.kill("SIGKILL");
      await db.close();
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

async function withFeed(
  built: { readonly catalog: Catalog },
  run: (db: Db, url: string, sql: ReturnType<typeof openPostgres>) => Promise<void>,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  const db = connect(database.url, { schema: built as never, max: 4 }) as unknown as Db;
  try {
    for (const statement of renderCatalog(built.catalog, "public")) await sql.unsafe(statement);
    await run(db, database.url, sql);
  } finally {
    await db.close();
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

async function timedInserts(
  built: { readonly catalog: Catalog },
  samples: number,
): Promise<number> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(built.catalog, "public")) await sql.unsafe(statement);
    const started = Date.now();
    for (let id = 1; id <= samples; id += 1) {
      await sql.unsafe(`insert into products (id) values (${String(id)})`);
    }
    return Date.now() - started;
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

async function expectLeaseFree(url: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    const rows = await sql.unsafe(
      `select count(*)::text as n from pg_locks where locktype = 'advisory' and granted`,
    );
    expect(rows[0]?.n).toBe("0");
  } finally {
    await sql.end({ timeout: 5 });
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

function readLog(path: string): { readonly pid: string; readonly id: string }[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, id] = line.split("\t");
      return { pid: pid ?? "", id: id ?? "" };
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
  const deadline = Date.now() + 15_000;
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

function shownId(value: unknown): string {
  if (typeof value === "number" || typeof value === "string") return String(value);
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(ready: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}
