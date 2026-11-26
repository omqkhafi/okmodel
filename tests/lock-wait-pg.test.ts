/**
 * `okm migrate apply` waits for a lock, retries, and names who holds it.
 *
 * Every test runs against a real Postgres. A second connection holds the lock.
 * A sequence counts how many times a step got past its lock, because a
 * sequence is not rolled back: it shows a step that ran twice.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { failureText } from "../src/tooling/cli/failure.js";
import { errorBody } from "../src/tooling/errors/body.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  giveDatabaseToOwner,
  LIMITED_SCHEMA_OWNER,
  openPostgres,
  withPostgresSchema,
} from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { applyTarget, directSession, type ApplyReport } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import { readLock } from "../src/tooling/migrate/lock-wait.js";
import type { PlanStep } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

type Options = {
  readonly lockTimeoutMs?: number;
  readonly lockWaitMs?: number;
  readonly statementTimeoutMs?: number;
  readonly allowPooler?: boolean;
  readonly url?: string;
};

postgresTest(
  gate,
  "apply waits, retries, and succeeds when the holder commits inside the window",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      const applying = applyTo(
        schemaName,
        [
          migration("0001_alter", [
            step(`alter table ${q(schemaName)}.held add column note integer`),
          ]),
        ],
        { lockTimeoutMs: 100, lockWaitMs: 10_000 },
      );
      await Bun.sleep(700);
      await sql.unsafe("commit");
      const report = await applying;
      expect(report.applied).toEqual(["0001_alter"]);
      expect(report.lock?.attempts).toBeGreaterThanOrEqual(3);
      expect(report.lock?.waitedMs).toBeGreaterThanOrEqual(400);
      expect(await columns(sql, schemaName, "held")).toContain("note");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "apply gives up after --lock-wait and names the holder",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      await sql.unsafe("set application_name = 'lock-holder'");
      const holder = await pidOf(sql);
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      const began = Date.now();
      const error = await failure(
        schemaName,
        [
          migration("0001_alter", [
            step(`alter table ${q(schemaName)}.held add column note integer`),
          ]),
        ],
        { lockTimeoutMs: 200, lockWaitMs: 1_500 },
      );
      const elapsed = Date.now() - began;
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      expect(elapsed).toBeLessThan(6_000);
      expect(error.retryable).toBe(true);
      expect(error.message).toContain("Migration 0001_alter failed at step 1");
      expect(error.message).toContain("I could not get a lock after");
      expect(error.message).toContain(`pid ${String(holder)} (lock-holder), idle in a transaction`);
      expect(error.message.endsWith("Nothing was changed.")).toBe(true);
      const found = readLock(error);
      expect(found?.attempts).toBeGreaterThanOrEqual(3);
      expect(found?.blockedBy).toHaveLength(1);
      const [who] = found?.blockedBy ?? [];
      expect(who?.pid).toBe(holder);
      expect(who?.application).toBe("lock-holder");
      expect(who?.state).toBe("idle in transaction");
      expect(who?.kind).toBe("idle-in-transaction");
      expect(who?.ageMs).toBeGreaterThanOrEqual(1_000);
      await sql.unsafe("rollback");
      expect(await columns(sql, schemaName, "held")).toEqual(["id"]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "--lock-wait 0 fails on the first attempt",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      const error = await failure(
        schemaName,
        [migration("0001_alter", [step(`alter table ${q(schemaName)}.held add column n integer`)])],
        { lockTimeoutMs: 200, lockWaitMs: 0 },
      );
      expect(readLock(error)?.attempts).toBe(1);
      expect(error.message).toContain("after 1 attempt over");
      await sql.unsafe("rollback");
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a statement timeout is not retried",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create sequence ${q(schemaName)}.passes`);
      const error = await failure(
        schemaName,
        [
          migration("0001_slow", [
            step(
              `do $$ begin perform nextval('${schemaName}.passes'); perform pg_sleep(3); end $$`,
            ),
          ]),
        ],
        { statementTimeoutMs: 200, lockWaitMs: 30_000 },
      );
      expect(sqlstateOf(error)).toBe("57014");
      expect(readLock(error)).toBeUndefined();
      expect(error.retryable).toBe(false);
      expect(await passes(sql, schemaName)).toBe(1);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a deadlock is not retried",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.one (id integer)`);
      await sql.unsafe(`create table ${q(schemaName)}.two (id integer)`);
      await sql.unsafe(`create sequence ${q(schemaName)}.passes`);
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.two`);
      const failing = failure(
        schemaName,
        [
          migration("0001_cycle", [
            step(
              `do $$ begin perform nextval('${schemaName}.passes'); lock table ${schemaName}.one; lock table ${schemaName}.two; end $$`,
            ),
          ]),
        ],
        { lockTimeoutMs: 20_000, lockWaitMs: 60_000 },
      );
      await Bun.sleep(400);
      // The holder now waits for the table apply holds, which closes the cycle.
      const waiting = sql.unsafe(`lock table ${q(schemaName)}.one`).then(
        () => undefined,
        () => undefined,
      );
      const error = await failing;
      await waiting;
      await sql.unsafe("rollback");
      expect(sqlstateOf(error)).toBe("40P01");
      expect(readLock(error)).toBeUndefined();
      expect(await passes(sql, schemaName)).toBe(1);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a prepared transaction is named, with no pid",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const room = await sql.unsafe("show max_prepared_transactions");
      expect(Number(room[0]?.max_prepared_transactions)).toBeGreaterThan(0);
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      const gid = `okm_lock_${schemaName}`;
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      await sql.unsafe(`prepare transaction '${gid}'`);
      try {
        const error = await failure(
          schemaName,
          [
            migration("0001_alter", [
              step(`alter table ${q(schemaName)}.held add column n integer`),
            ]),
          ],
          { lockTimeoutMs: 400, lockWaitMs: 0 },
        );
        const [who] = readLock(error)?.blockedBy ?? [];
        expect(who?.kind).toBe("prepared-transaction");
        expect(who?.pid).toBe(0);
        expect(error.message).toContain(`Held by a prepared transaction "${gid}"`);
        expect(error.message).toContain("It has no pid.");
      } finally {
        await sql.unsafe(`rollback prepared '${gid}'`);
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "another okm apply is recognised by its application name",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      await sql.unsafe("set application_name = 'okm apply'");
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      const error = await failure(
        schemaName,
        [migration("0001_alter", [step(`alter table ${q(schemaName)}.held add column n integer`)])],
        { lockTimeoutMs: 400, lockWaitMs: 0 },
      );
      expect(readLock(error)?.blockedBy[0]?.kind).toBe("okm-apply");
      expect(error.message).toContain("Held by another okm apply, pid");
      await sql.unsafe("rollback");
    });
  },
  20_000,
);

postgresTest(
  gate,
  "the apply connection is named okm apply",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const seen: string[] = [];
      const watching = (async () => {
        for (let i = 0; i < 60 && seen.length === 0; i += 1) {
          const rows = await sql.unsafe(
            "select application_name from pg_stat_activity where application_name = 'okm apply'",
          );
          for (const row of rows) seen.push(String(row.application_name));
          await Bun.sleep(25);
        }
      })();
      await applyTo(
        schemaName,
        [
          migration("0001_slow", [
            step(`create table ${q(schemaName)}.slow (id integer)`),
            step("select pg_sleep(0.6)"),
          ]),
        ],
        {},
      );
      await watching;
      expect(seen).toEqual(["okm apply"]);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "the holder's query text is for a terminal only, and a role that cannot read it is told so",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    try {
      const owner = await giveDatabaseToOwner(database.url, undefined, LIMITED_SCHEMA_OWNER);
      await admin.unsafe("create table public.held (id integer)");
      await admin.unsafe("alter table public.held owner to okm_owner_limited");
      const holder = await admin.reserve();
      await holder.unsafe("begin");
      await holder.unsafe("lock table public.held in access exclusive mode");
      try {
        // A role that does not own the holder's session cannot read its query.
        const hidden = await failure(
          "public",
          [migration("0002_alter", [step("alter table public.held add column m integer")])],
          { lockTimeoutMs: 400, lockWaitMs: 0, url: owner },
        );
        expect(readLock(hidden)?.attempts).toBe(1);
        expect(failureText(hidden, false, Number.POSITIVE_INFINITY, true)).toContain(
          "query: hidden, this role cannot read it.",
        );
        expect(failureText(hidden, false, Number.POSITIVE_INFINITY, false)).toContain(
          "I could not get a lock",
        );
        // Superuser sees the query text of every session.
        const seen = await failure(
          "public",
          [migration("0001_alter", [step("alter table public.held add column n integer")])],
          { lockTimeoutMs: 400, lockWaitMs: 0, url: database.url },
        );
        const terminal = failureText(seen, false, Number.POSITIVE_INFINITY, true);
        expect(terminal).toContain("query: lock table public.held in access exclusive mode");
        const piped = failureText(seen, false, Number.POSITIVE_INFINITY, false);
        expect(piped).not.toContain("query:");
        expect(piped).not.toContain("lock table public.held in access exclusive mode");
        const json = JSON.stringify(errorBody(seen));
        expect(json).not.toContain("lock table");
        expect(json).not.toContain("query");
      } finally {
        await holder.unsafe("rollback");
        holder.release();
      }
    } finally {
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "--json gets attempts, waitedMs, and blockedBy, and no query text",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      const error = await failure(
        schemaName,
        [migration("0001_alter", [step(`alter table ${q(schemaName)}.held add column n integer`)])],
        { lockTimeoutMs: 300, lockWaitMs: 0 },
      );
      await sql.unsafe("rollback");
      const body = errorBody(error);
      expect(body.retryable).toBe(true);
      expect(body.attempts).toBe(1);
      expect(body.waitedMs).toBeGreaterThanOrEqual(250);
      expect(Object.keys(body.blockedBy?.[0] ?? {})).toEqual([
        "pid",
        "application",
        "state",
        "ageMs",
        "kind",
      ]);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a release while an attempt is in flight runs the step once and leaves no partial work",
  async () => {
    for (const release of [0, 40, 90, 140, 190, 260, 330]) {
      await withPostgresSchema(async (sql, schemaName) => {
        await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
        await sql.unsafe(`create sequence ${q(schemaName)}.passes`);
        await sql.unsafe("begin");
        await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
        const applying = applyTo(
          schemaName,
          [
            migration("0001_pass", [
              step(
                `do $$ begin lock table ${schemaName}.held in access exclusive mode; perform nextval('${schemaName}.passes'); alter table ${schemaName}.held add column note integer; end $$`,
              ),
            ]),
          ],
          { lockTimeoutMs: 150, lockWaitMs: 20_000 },
        );
        await Bun.sleep(release);
        await sql.unsafe("commit");
        const report = await applying;
        expect(report.applied).toEqual(["0001_pass"]);
        expect(await passes(sql, schemaName), `release at ${String(release)} ms`).toBe(1);
        expect(await columns(sql, schemaName, "held")).toEqual(["id", "note"]);
        const history = await sql.unsafe(`select count(*)::int as n from okm_history`);
        expect(history[0]?.n).toBe(1);
      });
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a step outside a transaction retries on a direct connection",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      const applying = applyTo(
        schemaName,
        [
          migration("0001_index", [
            step(`create index concurrently held_id on ${q(schemaName)}.held (id)`, false),
          ]),
        ],
        { lockTimeoutMs: 100, lockWaitMs: 10_000 },
      );
      await Bun.sleep(600);
      await sql.unsafe("commit");
      const report = await applying;
      expect(report.lock?.attempts).toBeGreaterThanOrEqual(2);
      const valid = await sql.unsafe(
        `select indisvalid from pg_index where indexrelid = '${q(schemaName)}.held_id'::regclass`,
      );
      expect(valid[0]?.indisvalid).toBe(true);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "the session timeouts go back to what they were, and only a direct connection takes them",
  async () => {
    const pool = open({ url, max: 1 });
    try {
      const connection = await pool.reserve?.();
      if (connection === undefined) throw new Error("the driver cannot reserve");
      const read = async (): Promise<readonly unknown[]> =>
        (await connection.execute("show lock_timeout")).rows[0] ?? [];
      const before = await read();
      const direct = await directSession(connection, { url, lockTimeoutMs: 123 }, url);
      expect(direct?.pid).toBeDefined();
      expect(await read()).toEqual(["123ms"]);
      expect(await direct?.end()).toBe(true);
      expect(await read()).toEqual(before);
      // Behind --allow-pooler nothing is set: a session setting would be lost or leak.
      expect(await directSession(connection, { url, allowPooler: true }, url)).toBeUndefined();
      expect(await read()).toEqual(before);
      await connection.release();
    } finally {
      await pool.close();
    }
  },
  20_000,
);

postgresTest(
  gate,
  "behind --allow-pooler a step outside a transaction is refused, and a transactional one still waits",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      const refused = await failure(
        schemaName,
        [
          migration("0001_index", [
            step(`create index concurrently held_id on ${q(schemaName)}.held (id)`, false),
          ]),
        ],
        { allowPooler: true },
      );
      expect((refused as OkmError).code).toBe("OKM1854");
      expect(refused.message).toContain("runs outside a transaction");
      const none = await sql.unsafe(
        `select count(*)::int as n from pg_indexes where schemaname = '${schemaName}' and indexname = 'held_id'`,
      );
      expect(none[0]?.n).toBe(0);
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      const applying = applyTo(
        schemaName,
        [
          migration("0002_alter", [
            step(`alter table ${q(schemaName)}.held add column note integer`),
          ]),
        ],
        { allowPooler: true, lockTimeoutMs: 100, lockWaitMs: 10_000 },
      );
      await Bun.sleep(500);
      await sql.unsafe("commit");
      const report = await applying;
      expect(report.lock?.attempts).toBeGreaterThanOrEqual(2);
      expect(await columns(sql, schemaName, "held")).toContain("note");
    });
  },
  30_000,
);

function applyTo(
  schemaName: string,
  migrations: readonly StoredMigration[],
  options: Options,
): Promise<ApplyReport> {
  return applyTarget({
    url: options.url ?? url,
    target: schemaName,
    protected: false,
    searchPath: schemaName,
    migrations,
    ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    ...(options.lockWaitMs !== undefined ? { lockWaitMs: options.lockWaitMs } : {}),
    ...(options.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: options.statementTimeoutMs }
      : {}),
    ...(options.allowPooler === true ? { allowPooler: true } : {}),
  });
}

async function failure(
  schemaName: string,
  migrations: readonly StoredMigration[],
  options: Options,
): Promise<OkmError> {
  try {
    await applyTo(schemaName, migrations, options);
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("apply was expected to fail");
}

function sqlstateOf(error: OkmError): string | undefined {
  const cause: unknown = error.cause;
  return typeof cause === "object" && cause !== null
    ? (Reflect.get(cause, "sqlstate") as string | undefined)
    : undefined;
}

async function pidOf(sql: Sql): Promise<number> {
  const rows = await sql.unsafe("select pg_backend_pid() as pid");
  return Number(rows[0]?.pid);
}

async function passes(sql: Sql, schemaName: string): Promise<number> {
  const rows = await sql.unsafe(
    `select case when is_called then last_value else 0 end as n from ${q(schemaName)}.passes`,
  );
  return Number(rows[0]?.n);
}

async function columns(sql: Sql, schemaName: string, name: string): Promise<readonly string[]> {
  const rows = await sql.unsafe(
    `select column_name from information_schema.columns
     where table_schema = '${schemaName}' and table_name = '${name}' order by ordinal_position`,
  );
  return rows.map((row) => String(row.column_name));
}

function migration(id: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash: `hash-${id}`, steps };
}

function step(sql: string, transactional = true): PlanStep {
  return { sql, class: "expand", action: "ddl", lock: "ACCESS EXCLUSIVE", transactional };
}

function q(name: string): string {
  return `"${name}"`;
}
