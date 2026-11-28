/**
 * PgBouncer transaction-mode smoke for the CI service container (CI-P).
 *
 * Opt in with `OKM_POOLER_URL`. Suite shards leave it unset and keep the
 * direct topology URL (`primaryUrl`). PGlite and PGlite wire are in-process.
 * Neon speaks HTTP or WebSocket to a Neon endpoint. Those three cannot open
 * this TCP pooler. postgres.js, node-postgres, and Bun.sql can.
 *
 * The CI image is `edoburu/pgbouncer` v1.26.1-p0 (PgBouncer 1.26.1,
 * `sha256:488422e38cff912895d0d65d8963fcd306e6ac589a724398b6eb8e294e94d624`).
 * `max_prepared_statements` exists since 1.21 and defaults to 200 in 1.26.1,
 * so protocol-level prepared statements work in transaction mode. This smoke
 * uses simple queries. The container is `pool_mode=transaction` and
 * `default_pool_size=1`. Transaction pooling does not run `server_reset_query`,
 * so a `SET` outside a transaction stays on that server connection.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import postgres from "postgres";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import type { DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { sequence } from "../src/dialects/pg/seq/index.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { planMigration, type PlanStep } from "../src/tooling/migrate/plan.js";
import { ensureMigrationTables } from "../src/tooling/migrate/apply.js";
import { runTarget, type RunnableUnit } from "../src/tooling/migrate/runner.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { maintainPartitions } from "../src/tooling/migrate/partition-maintain.js";
import { sessionSettings } from "../src/runtime/session/index.js";

/** How long the first transaction holds the only server connection. */
const HOLD_MS = 2_000;

/** A queued transaction on a pool of one waits at least this long. */
const WAIT_FLOOR_MS = 1_000;

const POOLER_URL = process.env.OKM_POOLER_URL;

type Opener = (config: { readonly url: string; readonly max: number }) => DriverPool;

const DRIVERS: readonly { readonly name: string; readonly open: Opener }[] = [
  { name: "postgresjs", open: openPostgres },
  { name: "pg", open: openPg },
  { name: "bun", open: openBun },
];

if (POOLER_URL === undefined || POOLER_URL.length === 0) {
  test.skip("PgBouncer service (set OKM_POOLER_URL to opt in)", () => {});
} else {
  const url = POOLER_URL;

  for (const driver of DRIVERS) {
    test(`${driver.name}: simple query through the pooler`, async () => {
      const pool = driver.open({ url, max: 1 });
      try {
        expect(oneCell(await pool.execute("select 1"))).toBe("1");
      } finally {
        await pool.close();
      }
    }, 15_000);

    test(`${driver.name}: two sequential transactions share one server connection`, async () => {
      await expectSharedServer(url, driver.open);
    }, 20_000);

    test(`${driver.name}: a set outside a transaction is visible to the next client`, async () => {
      await expectSessionLeak(url, driver.open);
    }, 15_000);

    test(`${driver.name}: session settings never reach the next client on the one server`, async () => {
      await expectNoSettingLeak(url, driver.open);
    }, 30_000);
  }

  test("a committing procedure inside a transaction is OKM1551 before send", async () => {
    const stamp = Math.random().toString(36).slice(2, 10);
    const tableName = quoteIdent(`okm_hold_${stamp}`);
    const routine = quoteIdent(`okm_hold_take_${stamp}`);
    const direct = postgres(primaryUrl(), { max: 1, onnotice: () => {} });
    const batches = table(`okm_hold_${stamp}`, { n: t.integer().primaryKey() });
    const take = fn(`okm_hold_take_${stamp}`, {
      kind: "procedure",
      commits: true,
      dependsOn: [batches],
      body: "begin commit; end",
    });
    const app = schema({ tables: [batches], functions: [take] });
    try {
      await direct.unsafe(`create table ${tableName} (n integer primary key)`);
      await direct.unsafe(
        `create procedure ${routine}() language plpgsql as $okm$ begin insert into ${tableName} (n) values (1); commit; end $okm$`,
      );
      const pooled = connect(url, { schema: app, max: 1 });
      try {
        let failed: unknown;
        await pooled.tx(async (tx) => {
          try {
            await take.run(tx, {});
          } catch (error) {
            failed = error;
          }
        });
        expect(failed).toBeInstanceOf(OkmError);
        expect((failed as OkmError).code).toBe("OKM1551");
        expect((failed as OkmError).message).toContain("2D000");
        const rows = await direct.unsafe(`select n from ${tableName}`);
        expect(rows.length).toBe(0);
      } finally {
        await pooled.close();
      }
    } finally {
      await direct.unsafe(`drop procedure if exists ${routine}()`);
      await direct.unsafe(`drop table if exists ${tableName}`);
      await direct.end();
    }
  }, 20_000);

  test("partitions maintain is OKM1854 on the pooler, including dry-run", async () => {
    const app = schema({
      tables: [
        table(
          "events",
          { id: t.integer(), occurredAt: t.timestamptz(), body: t.text() },
          {
            primaryKey: ["id", "occurredAt"],
            partition: {
              by: "range",
              key: "occurredAt",
              every: "month",
              at: "UTC",
              from: "2026-01-01",
              ahead: 1,
            },
          },
        ),
      ],
    });
    const stored = app.catalog.objects.find((object) => object.kind === "table");
    if (stored?.kind !== "table") throw new Error("missing table");
    let failed: unknown;
    try {
      await maintainPartitions({
        url,
        schema: "public",
        catalog: app.catalog,
        table: stored,
        dryRun: true,
        allowProtected: false,
        lockTimeoutMs: 1_000,
        lockWaitMs: 0,
      });
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeInstanceOf(OkmError);
    expect((failed as OkmError).code).toBe("OKM1854");
  }, 30_000);

  test("a committing procedure keeps finished batches through transaction pooling", async () => {
    const stamp = Math.random().toString(36).slice(2, 10);
    const tableName = quoteIdent(`okm_batch_${stamp}`);
    const routine = quoteIdent(`okm_take_${stamp}`);
    const direct = postgres(primaryUrl(), { max: 1 });
    const batches = table(`okm_batch_${stamp}`, { n: t.integer().primaryKey() });
    const take = fn(`okm_take_${stamp}`, {
      kind: "procedure",
      commits: true,
      dependsOn: [batches],
      body: "begin commit; end",
    });
    const app = schema({ tables: [batches], functions: [take] });
    try {
      await direct.unsafe(`create table ${tableName} (n integer primary key)`);
      await direct.unsafe(
        `create procedure ${routine}() language plpgsql as $okm$ begin insert into ${tableName} (n) values (1); commit; insert into ${tableName} (n) values (2); commit; raise exception 'stop'; end $okm$`,
      );
      const pooled = connect(url, { schema: app, max: 1 });
      try {
        let failed: unknown;
        try {
          await take.run(pooled, {});
        } catch (error) {
          failed = error;
        }
        expect(failed).toBeTruthy();
        const rows = await direct.unsafe(`select n from ${tableName} order by n`);
        expect(rows.map((item) => Number(item.n))).toEqual([1, 2]);
      } finally {
        await pooled.close();
      }
    } finally {
      await direct.unsafe(`drop procedure if exists ${routine}()`);
      await direct.unsafe(`drop table if exists ${tableName}`);
      await direct.end();
    }
  }, 20_000);

  test("a committed tenant setting is empty on a second client", async () => {
    await expectTenantCleared(url);
  }, 20_000);

  test("set_config role through the pooler is OKM1923 for a non-member", async () => {
    await expectRoleRefused(url);
  }, 30_000);

  test("the GUC belt through transaction pooling stays on one step and does not leak", async () => {
    await expectGuardBelt(url);
  }, 40_000);

  test("counter: two clients in one scope get different numbers", async () => {
    const suffix = Date.now().toString(36);
    const series = `pool${suffix}`;
    const name = `docs_${suffix}`;
    const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const built = schema({
      tables: [
        table(name, {
          tenantId: t.uuid(),
          number: sequence(series).column({ scope: ["tenantId"] }),
        }),
      ],
    });
    const plan = planMigration({ before: catalog([]), after: built.catalog, name: "pool" });
    const hold = openPostgres({ url, max: 1 });
    const other = openPostgres({ url, max: 1 });
    try {
      for (const step of plan.steps) await hold.execute(step.sql);
      await hold.execute("begin");
      await hold.execute(`insert into "${name}" ("tenantId") values ('${tenantA}')`);
      let done = false;
      const waiting = other
        .execute(`insert into "${name}" ("tenantId") values ('${tenantA}') returning number`)
        .then((result) => {
          done = true;
          return result.rows[0]?.[0];
        });
      await Bun.sleep(300);
      expect(done).toBe(false);
      await hold.execute("commit");
      const second = await waiting;
      const first = oneCell(
        await hold.execute(
          `select min(number)::text from "${name}" where "tenantId" = '${tenantA}'`,
        ),
      );
      expect(second).not.toBe(first);
    } finally {
      await hold.execute(`drop table if exists "${name}" cascade`).catch(() => undefined);
      await hold.execute(`drop table if exists "okm_ctr_${series}" cascade`).catch(() => undefined);
      await hold
        .execute(`drop function if exists "okm_next_${series}"(uuid, text)`)
        .catch(() => undefined);
      await hold
        .execute(`drop function if exists "okm_assign_${series}_number"()`)
        .catch(() => undefined);
      await hold.close();
      await other.close();
    }
  }, 30_000);
}

/**
 * Proves the drop belt on a transaction pooler.
 *
 * The session form is refused when `directPid` is absent. A transactional
 * drop sets `okm.allow_drop` for that transaction. A second client, after
 * commit, does not see it, and neither does the client after that.
 *
 * @param url - PgBouncer URL
 */
async function expectGuardBelt(url: string): Promise<void> {
  const stamp = Math.random().toString(36).slice(2, 10);
  const notes = `belt_notes_${stamp}`;
  const index = `belt_notes_${stamp}_id`;
  const probe = `belt_probe_${stamp}`;
  const routine = `belt_fn_${stamp}`;
  const event = `belt_evt_${stamp}`;
  const direct = postgres(primaryUrl(), { max: 1, onnotice: () => {} });
  const quoted = (name: string): string => quoteIdent(name);
  const ledgers = ["okm_meta", "okm_history", "okm_backfill", "okm_steps"] as const;
  const present = await direct<{ name: string }[]>`
    select relname as name from pg_class
    where relkind = 'r' and relname in ('okm_meta', 'okm_history', 'okm_backfill', 'okm_steps')
  `;
  const existed = new Set(present.map((row) => row.name));
  try {
    await direct.unsafe(`create table ${quoted(notes)} (id int)`);
    await direct.unsafe(`create index ${quoted(index)} on ${quoted(notes)} (id)`);
    await direct.unsafe(`create table ${quoted(probe)} (v text)`);
    await direct.unsafe(
      `create function ${quoted(routine)}() returns event_trigger language plpgsql as $okm$ begin insert into ${quoted(probe)} (v) values (current_setting('okm.allow_drop', true)); end $okm$`,
    );
    await direct.unsafe(
      `create event trigger ${quoted(event)} on sql_drop execute function ${quoted(routine)}()`,
    );
    await ensureMigrationTables((sql) => direct.unsafe(sql));

    const session = openPostgres({ url, max: 1 });
    if (session.reserve === undefined) throw new Error("reserve");
    const held = await session.reserve();
    try {
      const refused = await reject(
        runTarget(
          held,
          {
            policy: { target: "default", protected: true, allowProtected: true },
            units: [
              beltUnit(
                `drop index concurrently if exists ${quoted(index)}`,
                false,
                "drop-index",
                false,
              ),
            ],
            lockWaitMs: 0,
            lockTimeoutMs: 1_000,
            statementTimeoutMs: 5_000,
          },
          {},
        ),
      );
      expect(refused).toBeInstanceOf(OkmError);
      expect(refused.code).toBe("OKM1931");
      expect(refused.message).toContain("direct URL");
      expect(refused.message).toContain("okm.allow_drop");
    } finally {
      await held.release();
      await session.close();
    }

    const apply = openPostgres({ url, max: 1 });
    if (apply.reserve === undefined) throw new Error("reserve");
    const connection = await apply.reserve();
    try {
      await runTarget(
        connection,
        {
          policy: { target: "default", protected: true, allowProtected: true },
          units: [beltUnit(`drop table if exists ${quoted(notes)}`, true, "drop-table", false)],
          lockWaitMs: 0,
          lockTimeoutMs: 1_000,
          statementTimeoutMs: 5_000,
        },
        {},
      );
    } finally {
      await connection.release();
      await apply.close();
    }

    const second = postgres(url, { max: 1 });
    const third = postgres(url, { max: 1 });
    try {
      const seen = await second.unsafe(`select v from ${quoted(probe)}`);
      expect(seen.map((row) => String(row.v))).toEqual(["true"]);
      const gone = await second.unsafe(`select current_setting('okm.allow_drop', true) as v`);
      expect(gone[0]?.v === "true").toBe(false);
      const next = await third.unsafe(`select current_setting('okm.allow_drop', true) as v`);
      expect(next[0]?.v === "true").toBe(false);
    } finally {
      await second.end({ timeout: 5 });
      await third.end({ timeout: 5 });
    }
  } finally {
    await direct.unsafe(`drop event trigger if exists ${quoted(event)}`).catch(() => undefined);
    await direct.unsafe(`drop function if exists ${quoted(routine)}()`).catch(() => undefined);
    await direct.unsafe(`drop table if exists ${quoted(probe)}`).catch(() => undefined);
    await direct.unsafe(`drop table if exists ${quoted(notes)}`).catch(() => undefined);
    await direct
      .unsafe(`delete from okm_history where migration_id = 'belt'`)
      .catch(() => undefined);
    await direct.unsafe(`delete from okm_meta where migration_id = 'belt'`).catch(() => undefined);
    for (const name of ledgers) {
      if (existed.has(name)) continue;
      await direct.unsafe(`drop table if exists ${quoted(name)}`).catch(() => undefined);
    }
    await direct.end({ timeout: 5 });
  }
}

function beltUnit(
  sql: string,
  transactional: boolean,
  kind: "drop-index" | "drop-table",
  finishes: boolean,
): RunnableUnit {
  const step: PlanStep = {
    sql,
    class: "contract",
    kind,
    action: "ddl",
    lock: "access exclusive",
    transactional,
  };
  return {
    migrationId: "belt",
    catalogHash: "belt",
    finishes,
    transactional,
    steps: [{ index: 0, step }],
  };
}

async function reject(run: Promise<unknown>): Promise<OkmError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

/**
 * Reads the first cell of a one-row result.
 *
 * @param result - A statement result
 * @returns Wire text of `rows[0][0]`
 */
function oneCell(result: ExecuteResult): string {
  const value = result.rows[0]?.[0];
  if (value === undefined || value === null) {
    throw new Error("expected one non-null cell");
  }
  return value;
}

/**
 * Proves `default_pool_size=1`: a second transaction waits, then lands on
 * the same `pg_backend_pid()` as the transaction that was holding the server.
 *
 * @param url - Pooler URL
 * @param open - Adapter opener
 */
async function expectSharedServer(url: string, open: Opener): Promise<void> {
  const first = open({ url, max: 1 });
  const second = open({ url, max: 1 });
  try {
    // The second pool connects before the hold, so the timed `begin` measures
    // the queue and not a cold TCP handshake.
    expect(oneCell(await second.execute("select 1"))).toBe("1");
    await first.execute("begin");
    const held = oneCell(await first.execute("select pg_backend_pid()"));
    const began = (async (): Promise<number> => {
      const started = Date.now();
      await second.execute("begin");
      return Date.now() - started;
    })();
    await first.execute(`select pg_sleep(${String(HOLD_MS / 1000)})`);
    await first.execute("commit");
    const waitedMs = await began;
    const reused = oneCell(await second.execute("select pg_backend_pid()"));
    await second.execute("commit");
    expect(reused).toBe(held);
    expect(waitedMs).toBeGreaterThanOrEqual(WAIT_FLOOR_MS);
  } finally {
    await second.close().catch(() => undefined);
    await first.close().catch(() => undefined);
  }
}

/**
 * Proves the session leak a later pool-size-1 test asserts: `SET` outside a
 * transaction survives on the single server and the next client sees it.
 *
 * `lock_timeout` is not a startup parameter PgBouncer 1.26 tracks, so the
 * pooler does not restore it when the next client is assigned.
 *
 * @param url - Pooler URL
 * @param open - Adapter opener
 */
async function expectSessionLeak(url: string, open: Opener): Promise<void> {
  const first = open({ url, max: 1 });
  try {
    await first.execute("reset lock_timeout");
    expect(oneCell(await first.execute("show lock_timeout"))).toBe("0");
    await first.execute("set lock_timeout = '7s'");
    expect(oneCell(await first.execute("show lock_timeout"))).toBe("7s");
  } finally {
    await first.close();
  }

  const second = open({ url, max: 1 });
  try {
    expect(oneCell(await second.execute("show lock_timeout"))).toBe("7s");
    await second.execute("reset lock_timeout");
  } finally {
    await second.close();
  }
}

const USER_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const USER_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

const SETTINGS = sessionSettings({
  userId: { name: "app.leak_user", type: "uuid" },
});

/**
 * The leak test: two clients with different values share the one PgBouncer
 * server connection, and neither ever reads the other's value.
 *
 * Each row stores `current_setting('app.leak_user')` at insert. One client
 * holds a transaction open across a pause while the other writes. After
 * every unit a third pool on the same server reads the setting as empty, and
 * a client that never calls `with()` stores NULL.
 *
 * @param url - Pooler URL
 * @param open - Adapter opener
 */
async function expectNoSettingLeak(url: string, open: Opener): Promise<void> {
  const name = "leaks";
  const notes = table(name, { id: t.identity(), actor: t.text().nullable() });
  const app = schema({ casing: "snake", tables: [notes] });
  const admin = open({ url, max: 1 });
  const first = open({ url, max: 1 });
  const second = open({ url, max: 1 });
  const dbA = connect(first, { schema: app, session: SETTINGS });
  const dbB = connect(second, { schema: app, session: SETTINGS });
  try {
    await admin.execute(`drop table if exists "${name}"`);
    await admin.execute(
      `create table "${name}" (id bigint generated always as identity primary key, actor text default nullif(current_setting('app.leak_user', true), ''))`,
    );
    await Promise.all([dbA.connected, dbB.connected]);
    const pid = oneCell(await admin.execute("select pg_backend_pid()"));
    expect(oneCell(await first.execute("select pg_backend_pid()"))).toBe(pid);
    expect(oneCell(await second.execute("select pg_backend_pid()"))).toBe(pid);

    const a = dbA.with({ userId: USER_A });
    const b = dbB.with({ userId: USER_B });
    const held = a.tx(async (tx) => {
      const before = await tx.leaks.insert({});
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = await tx.leaks.insert({});
      return [before.actor, after.actor];
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const written = await Promise.all(
      Array.from({ length: 6 }, async () => (await b.leaks.insert({})).actor),
    );
    expect(written).toEqual(Array.from({ length: 6 }, () => USER_B));
    expect(await held).toEqual([USER_A, USER_A]);

    const loop = await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) => {
        const side = index % 2 === 0;
        const row = await (side ? a : b).leaks.insert({});
        return [row.actor, side ? USER_A : USER_B];
      }),
    );
    for (const [got, want] of loop) expect(got).toBe(want);

    expect(oneCell(await admin.execute("select current_setting('app.leak_user', true)"))).toBe("");
    const bare = await dbB.leaks.insert({});
    expect(bare.actor).toBeNull();
    const counts = await admin.execute(
      `select actor, count(*) from "${name}" group by actor order by actor`,
    );
    expect(counts.rows.map((row) => row[0])).toEqual([USER_A, USER_B, null]);
  } finally {
    await admin.execute(`drop table if exists "${name}"`).catch(() => undefined);
    await dbA.close().catch(() => undefined);
    await dbB.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await admin.close().catch(() => undefined);
  }
}

/**
 * `set_config(..., true)` dies at COMMIT. A second client on the pooler
 * reads the tenant setting as empty.
 *
 * @param url - Transaction-mode pooler URL
 */
async function expectTenantCleared(url: string): Promise<void> {
  const first = postgres(url, { max: 1 });
  const second = postgres(url, { max: 1 });
  try {
    await first.begin(async (tx) => {
      await tx.unsafe("select set_config('app.tenant', 'acme', true)");
      const inside = await tx<{ tenant: string | null }[]>`
        select current_setting('app.tenant', true) as tenant
      `;
      expect(inside[0]?.tenant).toBe("acme");
    });
    const outside = await second<{ tenant: string | null }[]>`
      select current_setting('app.tenant', true) as tenant
    `;
    expect(outside[0]?.tenant ?? "").toBe("");
  } finally {
    await first.end({ timeout: 5 });
    await second.end({ timeout: 5 });
  }
}

/**
 * A login that is not a member of the target role gets OKM1923.
 *
 * The CI service pooler logs in as a superuser, and a superuser may
 * `SET ROLE` anyone. This starts its own PgBouncer as a non-superuser when
 * the binary is on PATH. Without that binary the assertion is skipped.
 *
 * @param _url - Unused. The server is the topology primary.
 */
async function expectRoleRefused(_url: string): Promise<void> {
  if (Bun.which("pgbouncer") === null) return;
  const admin = postgres(primaryUrl(), { max: 1 });
  const login = `pool_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const target = `want_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = crypto.randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "okm-role-pooler-"));
  const port = 6435;
  let child: Bun.Subprocess | undefined;
  try {
    await admin.unsafe(
      `create role ${quoteIdent(login)} login password ${quoteLiteral(password)} nosuperuser nocreatedb nocreaterole`,
    );
    await admin.unsafe(`create role ${quoteIdent(target)} nologin`);
    const database = new URL(primaryUrl()).pathname.slice(1);
    await admin.unsafe(`grant connect on database ${quoteIdent(database)} to ${quoteIdent(login)}`);
    const server = new URL(primaryUrl());
    writeFileSync(join(dir, "users.txt"), `"${login}" "${password}"\n`);
    writeFileSync(
      join(dir, "pgbouncer.ini"),
      [
        "[databases]",
        `okm = host=${server.hostname} port=${server.port} dbname=${database} user=${login} password=${password}`,
        "[pgbouncer]",
        "listen_addr = 127.0.0.1",
        `listen_port = ${String(port)}`,
        "auth_type = trust",
        `auth_file = ${join(dir, "users.txt")}`,
        "pool_mode = transaction",
        "",
      ].join("\n"),
    );
    child = Bun.spawn(["pgbouncer", join(dir, "pgbouncer.ini")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForPort(port);
    const notes = table("pool_notes", { id: t.integer().primaryKey() });
    const app = schema({ tables: [notes] });
    const session = sessionSettings(
      { marker: { name: "app.pool_marker", type: "text" } },
      { role: target },
    );
    const db = connect(`postgres://${login}@127.0.0.1:${String(port)}/okm`, {
      schema: app,
      session,
      max: 1,
    });
    let caught: unknown;
    try {
      await db.with({ marker: "x" }).pool_notes.find({ limit: 1 });
    } catch (error) {
      caught = error;
    } finally {
      await db.close();
    }
    expect(caught).toBeInstanceOf(OkmError);
    if (caught instanceof OkmError) expect(caught.code).toBe("OKM1923");
  } finally {
    child?.kill();
    if (child !== undefined) await child.exited;
    rmSync(dir, { recursive: true, force: true });
    await admin.unsafe(`drop role if exists ${quoteIdent(login)}`).catch(() => undefined);
    await admin.unsafe(`drop role if exists ${quoteIdent(target)}`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    }).catch(() => undefined);
    if (socket !== undefined) {
      socket.end();
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(`pgbouncer did not open 127.0.0.1:${String(port)}`);
}
