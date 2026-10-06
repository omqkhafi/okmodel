/**
 * Batched backfill on Postgres (D195).
 *
 * A generated removal and a volatile-default fill commit one batch at a time.
 * A failed batch leaves `okm_backfill` and the next apply continues from it.
 * The same file runs on 15 and 18.
 */

import { expect } from "bun:test";

import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { catalogHash } from "../src/contracts/catalog/document.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { openPostgres, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { applyTarget, type ApplyReport } from "../src/tooling/migrate/apply.js";
import { formatStatus, readTargetStatus } from "../src/tooling/migrate/status.js";
import type { BackfillBatch } from "../src/tooling/migrate/runner.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import { planMigration, type PlanStep } from "../src/tooling/migrate/plan.js";
import { parseReplace, type Replacement } from "../src/tooling/migrate/values.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

const ROWS = 25_000;
const BATCH = 1_000;

postgresTest(
  gate,
  "a picklist removal updates 25000 rows in batches and a repeat changes nothing",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const before = schema({
        tables: [
          table("tasks", { id: t.integer().primaryKey(), status: t.text().picklist(["a", "b"]) }),
        ],
      });
      await applyPlan(schemaName, "0001_init", catalog([]), before.catalog);
      await sql.unsafe(
        `insert into ${q(schemaName)}.tasks (id, status) select g, 'a' from generate_series(1, ${String(ROWS)}) g`,
      );
      await installCounter(sql, schemaName, "tasks");
      const after = schema({
        tables: [
          table("tasks", { id: t.integer().primaryKey(), status: t.text().picklist(["b"]) }),
        ],
      });
      const plan = planMigration({
        before: before.catalog,
        after: after.catalog,
        replacements: [parseReplace("tasks.status.a=b")],
        schema: schemaName,
        name: "drop-a",
        batchSize: BATCH,
      });
      await applyTo(schemaName, [migration("0002_drop", catalogHash(after.catalog), plan.steps)]);
      const left = await sql<
        { n: string }[]
      >`select count(*)::text as n from tasks where status = 'a'`;
      expect(left[0]?.n).toBe("0");
      const filled = await sql<
        { n: string }[]
      >`select count(*)::text as n from tasks where status = 'b'`;
      expect(filled[0]?.n).toBe(String(ROWS));
      const expand = plan.steps.find((step) => step.kind === "backfill-expand");
      if (expand === undefined) throw new Error("missing expand backfill");
      await sql.unsafe(expand.sql, [null, null]);
      const sizes = await statementSizes(sql);
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(BATCH);
      expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(ROWS);
      const checkpoint = await backfillRows(sql);
      expect(checkpoint.every((row) => row.state === "done")).toBe(true);
    });
  },
  120_000,
);

postgresTest(
  gate,
  "a volatile default fills 25000 rows one batch at a time",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const before = schema({
        tables: [table("tasks", { id: t.integer().primaryKey(), title: t.text() })],
      });
      await applyPlan(schemaName, "0001_init", catalog([]), before.catalog);
      await sql.unsafe(
        `insert into ${q(schemaName)}.tasks (id, title) select g, 't' from generate_series(1, ${String(ROWS)}) g`,
      );
      await installCounter(sql, schemaName, "tasks");
      const after = schema({
        tables: [
          table("tasks", {
            id: t.integer().primaryKey(),
            title: t.text(),
            token: t.uuid().defaultSql("gen_random_uuid()"),
          }),
        ],
      });
      const plan = planMigration({
        before: before.catalog,
        after: after.catalog,
        schema: schemaName,
        name: "token",
        batchSize: BATCH,
      });
      await applyPlan(schemaName, "0002_token", before.catalog, after.catalog, BATCH);
      const filled = await sql<
        { n: string }[]
      >`select count(*)::text as n from tasks where token is not null`;
      expect(filled[0]?.n).toBe(String(ROWS));
      const update = plan.steps.find((step) => step.kind === "backfill-expand");
      if (update === undefined) throw new Error("missing volatile fill");
      await sql.unsafe(update.sql, [null, null]);
      const sizes = await statementSizes(sql);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(BATCH);
      expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(ROWS);
    });
  },
  120_000,
);

postgresTest(
  gate,
  "a failure at batch 3 resumes there and a finished step is skipped",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.items (id integer primary key, touches integer not null default 0)`,
      );
      await sql.unsafe(
        `insert into ${q(schemaName)}.items (id) select g from generate_series(1, 40) g`,
      );
      const progress: string[] = [];
      const failing = fillStep(
        schemaName,
        10,
        " and case when $1::text is not distinct from '20' then (1 / 0) = 1 else true end",
      );
      const failed = await catchError(() =>
        applyTo(schemaName, [migration("0001_fill", "hash-fill", [failing])], {
          onProgress: (line) => progress.push(line),
        }),
      );
      expect(messageOf(failed)).toContain("failed at step 0");
      expect(progress).toEqual([
        "backfill 0001_fill step 0 batch 1 rows 10 key 10",
        "backfill 0001_fill step 0 batch 2 rows 20 key 20",
      ]);
      const stopped = await backfillRows(sql);
      expect(stopped).toEqual([
        {
          migration_id: "0001_fill",
          step_index: "0",
          last_key: "20",
          rows_touched: "20",
          batches: "2",
          state: "running",
        },
      ]);
      const mid = await sql<{ touches: number }[]>`select touches from items order by id`;
      expect(mid.slice(0, 20).every((row) => row.touches === 1)).toBe(true);
      expect(mid.slice(20).every((row) => row.touches === 0)).toBe(true);
      const history = await sql<{ n: string }[]>`
        select count(*)::text as n from okm_history where migration_id = '0001_fill'
      `;
      expect(history[0]?.n).toBe("0");

      const report = await applyTo(schemaName, [
        migration("0001_fill", "hash-fill", [fillStep(schemaName, 10)]),
      ]);
      expect(report.applied).toEqual(["0001_fill"]);
      const done = await sql<{ touches: number }[]>`select touches from items order by id`;
      expect(done.every((row) => row.touches === 1)).toBe(true);
      const finished = await backfillRows(sql);
      expect(finished[0]?.state).toBe("done");
      expect(finished[0]?.batches).toBe("5");
      const again = await applyTo(schemaName, [
        migration("0001_fill", "hash-fill", [fillStep(schemaName, 10)]),
      ]);
      expect(again.applied).toEqual([]);
      const kept = await sql<{ touches: number }[]>`select touches from items order by id`;
      expect(kept.every((row) => row.touches === 1)).toBe(true);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a row inserted behind the cursor is caught by the contract sweep",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const before = schema({
        tables: [
          table("tasks", { id: t.integer().primaryKey(), status: t.text().picklist(["a", "b"]) }),
        ],
      });
      await applyPlan(schemaName, "0001_init", catalog([]), before.catalog);
      await sql.unsafe(
        `insert into ${q(schemaName)}.tasks (id, status) select g, 'a' from generate_series(1, 30) g`,
      );
      const after = schema({
        tables: [
          table("tasks", { id: t.integer().primaryKey(), status: t.text().picklist(["b"]) }),
        ],
      });
      const plan = planMigration({
        before: before.catalog,
        after: after.catalog,
        replacements: [parseReplace("tasks.status.a=b")],
        schema: schemaName,
        name: "drop-a",
        batchSize: 10,
      });
      let injected = false;
      await applyTo(schemaName, [migration("0002_drop", catalogHash(after.catalog), plan.steps)], {
        afterBatch: async (batch) => {
          if (injected || batch.batch !== 1) return;
          injected = true;
          await sql.unsafe(`insert into ${q(schemaName)}.tasks (id, status) values (0, 'a')`);
        },
      });
      expect(injected).toBe(true);
      const late = await sql<{ status: string }[]>`select status from tasks where id = 0`;
      expect(late[0]?.status).toBe("b");
      const left = await sql<
        { n: string }[]
      >`select count(*)::text as n from tasks where status = 'a'`;
      expect(left[0]?.n).toBe("0");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "uuid and composite keys batch, and a table with no primary key is refused",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const bare = schema({
        tables: [table("loose", { id: t.integer(), status: t.text().picklist(["a", "b"]) })],
      });
      const narrowed = schema({
        tables: [table("loose", { id: t.integer(), status: t.text().picklist(["b"]) })],
      });
      const refused = await catchError(() =>
        Promise.resolve(
          planMigration({
            before: bare.catalog,
            after: narrowed.catalog,
            replacements: [parseReplace("loose.status.a=b")],
            name: "loose",
          }),
        ),
      );
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1546");

      const uuids = [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000003",
        "00000000-0000-0000-0000-000000000004",
        "00000000-0000-0000-0000-000000000005",
      ];
      const uuidBefore = schema({
        tables: [
          table("marks", { id: t.uuid().primaryKey(), status: t.text().picklist(["a", "b"]) }),
        ],
      });
      await applyPlan(schemaName, "0001_uuid", catalog([]), uuidBefore.catalog);
      await sql.unsafe(
        `insert into ${q(schemaName)}.marks (id, status) values ${uuids.map((id) => `('${id}', 'a')`).join(", ")}`,
      );
      await installCounter(sql, schemaName, "marks");
      const uuidAfter = schema({
        tables: [table("marks", { id: t.uuid().primaryKey(), status: t.text().picklist(["b"]) })],
      });
      await applyPlan(schemaName, "0002_uuid", uuidBefore.catalog, uuidAfter.catalog, 2, [
        parseReplace("marks.status.a=b"),
      ]);
      const uuidLeft = await sql<
        { n: string }[]
      >`select count(*)::text as n from marks where status <> 'b'`;
      expect(uuidLeft[0]?.n).toBe("0");
      const uuidSizes = await statementSizes(sql);
      expect(Math.max(...uuidSizes)).toBeLessThanOrEqual(2);
      expect(uuidSizes.reduce((sum, n) => sum + n, 0)).toBe(5);

      const compositeBefore = schema({
        tables: [
          table(
            "pairs",
            { org: t.text(), id: t.integer(), status: t.text().picklist(["a", "b"]) },
            { primaryKey: ["org", "id"] },
          ),
        ],
      });
      await applyPlan(schemaName, "0003_pair", catalog([]), compositeBefore.catalog);
      await sql.unsafe(`delete from upd_sizes`);
      await installCounter(sql, schemaName, "pairs");
      await sql.unsafe(
        `insert into ${q(schemaName)}.pairs (org, id, status) values ('a', 1, 'a'), ('a', 2, 'a'), ('b', 1, 'a')`,
      );
      const compositeAfter = schema({
        tables: [
          table(
            "pairs",
            { org: t.text(), id: t.integer(), status: t.text().picklist(["b"]) },
            { primaryKey: ["org", "id"] },
          ),
        ],
      });
      await applyPlan(schemaName, "0004_pair", compositeBefore.catalog, compositeAfter.catalog, 1, [
        parseReplace("pairs.status.a=b"),
      ]);
      const pairLeft = await sql<
        { n: string }[]
      >`select count(*)::text as n from pairs where status <> 'b'`;
      expect(pairLeft[0]?.n).toBe("0");
      const sizes = await statementSizes(sql);
      const pairSizes = sizes.filter((n) => n > 0);
      expect(pairSizes).toEqual([1, 1, 1]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "status shows an unfinished backfill and omits a finished one",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.items (id integer primary key, touches integer not null default 0)`,
      );
      await sql.unsafe(
        `insert into ${q(schemaName)}.items (id) select g from generate_series(1, 20) g`,
      );
      const failing = fillStep(
        schemaName,
        10,
        " and case when $1::text is not distinct from '10' then (1 / 0) = 1 else true end",
      );
      const file = migration("0001_fill", "hash-fill", [failing]);
      const failed = await catchError(() => applyTo(schemaName, [file]));
      expect(messageOf(failed)).toContain("failed at step 0");
      const status = await readTargetStatus({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [file],
      });
      expect(status.state).toBe("behind by expand");
      const text = formatStatus([status]);
      expect(text.startsWith("target\tversion\tcatalog\tstate\tprotected\n")).toBe(true);
      expect(text).toContain("migration\tstep\trows\tkey\tstate\n");
      expect(text).toContain("0001_fill\t0\t10\t10\trunning\n");
      await applyTo(schemaName, [migration("0001_fill", "hash-fill", [fillStep(schemaName, 10)])]);
      const done = await readTargetStatus({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [migration("0001_fill", "hash-fill", [fillStep(schemaName, 10)])],
      });
      expect(done.backfills).toEqual([]);
      expect(formatStatus([done])).not.toContain("backfill");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a statement timeout keeps the previous checkpoint",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.items (id integer primary key, touches integer not null default 0)`,
      );
      await sql.unsafe(
        `insert into ${q(schemaName)}.items (id) select g from generate_series(1, 20) g`,
      );
      const slow = fillStep(
        schemaName,
        10,
        " and case when $1::text is null then true else pg_sleep(2) is not null end",
      );
      const failed = await catchError(() =>
        applyTo(schemaName, [migration("0001_slow", "hash-slow", [slow])], {
          statementTimeoutMs: 400,
          retries: 0,
        }),
      );
      expect(messageOf(failed)).toContain("statement timeout");
      const checkpoint = await backfillRows(sql);
      expect(checkpoint).toEqual([
        {
          migration_id: "0001_slow",
          step_index: "0",
          last_key: "10",
          rows_touched: "10",
          batches: "1",
          state: "running",
        },
      ]);
      const touches = await sql<{ touches: number }[]>`select touches from items order by id`;
      expect(touches.slice(0, 10).every((row) => row.touches === 1)).toBe(true);
      expect(touches.slice(10).every((row) => row.touches === 0)).toBe(true);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a protected target refuses a backfill unless allow-protected, including mid-run",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.items (id integer primary key, touches integer not null default 0)`,
      );
      await sql.unsafe(
        `insert into ${q(schemaName)}.items (id) select g from generate_series(1, 6) g`,
      );
      const step = fillStep(schemaName, 2);
      const refused = await catchError(() =>
        applyTo(schemaName, [migration("0001_fill", "hash-fill", [step])], { protected: true }),
      );
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1850");
      const untouched = await sql<{ touches: number }[]>`select touches from items`;
      expect(untouched.every((row) => row.touches === 0)).toBe(true);
      const empty = await backfillRows(sql);
      expect(empty).toEqual([]);

      const allowed = await applyTo(schemaName, [migration("0001_fill", "hash-fill", [step])], {
        protected: true,
        allowProtected: true,
      });
      expect(allowed.applied).toEqual(["0001_fill"]);
      const filled = await sql<{ touches: number }[]>`select touches from items`;
      expect(filled.every((row) => row.touches === 1)).toBe(true);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "protection is checked on the next batch",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.items (id integer primary key, touches integer not null default 0)`,
      );
      await sql.unsafe(
        `insert into ${q(schemaName)}.items (id) select g from generate_series(1, 6) g`,
      );
      const flags = { protected: false };
      const refused = await catchError(() =>
        applyTo(schemaName, [migration("0001_fill", "hash-fill", [fillStep(schemaName, 2)])], {
          protected: () => flags.protected,
          afterBatch: () => {
            flags.protected = true;
          },
        }),
      );
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1850");
      const checkpoint = await backfillRows(sql);
      expect(checkpoint[0]?.batches).toBe("1");
      expect(checkpoint[0]?.state).toBe("running");
      const touches = await sql<
        { n: string }[]
      >`select count(*)::text as n from items where touches = 1`;
      expect(touches[0]?.n).toBe("2");
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a lock timeout retries the current batch",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.items (id integer primary key, touches integer not null default 0)`,
      );
      await sql.unsafe(
        `insert into ${q(schemaName)}.items (id) select g from generate_series(1, 30) g`,
      );
      let held = false;
      const locker = openPostgres(url);
      try {
        const report = await applyTo(
          schemaName,
          [migration("0001_fill", "hash-fill", [fillStep(schemaName, 10)])],
          {
            lockTimeoutMs: 80,
            retries: 8,
            afterBatch: async (batch) => {
              if (held || batch.batch !== 1) return;
              held = true;
              await locker.unsafe(`set search_path to ${q(schemaName)}`);
              await locker.unsafe("begin");
              await locker.unsafe(`lock table ${q(schemaName)}.items in access exclusive mode`);
              setTimeout(() => {
                void locker.unsafe("commit");
              }, 250);
            },
          },
        );
        expect(report.applied).toEqual(["0001_fill"]);
        expect(held).toBe(true);
        const rows = await sql<{ touches: number }[]>`select touches from items`;
        expect(rows.every((row) => row.touches === 1)).toBe(true);
      } finally {
        await locker.end({ timeout: 5 });
      }
    });
  },
  20_000,
);

postgresTest(
  gate,
  "pause waits between batches",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.items (id integer primary key, touches integer not null default 0)`,
      );
      await sql.unsafe(
        `insert into ${q(schemaName)}.items (id) select g from generate_series(1, 3) g`,
      );
      const started = performance.now();
      await applyTo(schemaName, [migration("0001_fill", "hash-fill", [fillStep(schemaName, 1)])], {
        backfillPauseMs: 80,
      });
      expect(performance.now() - started).toBeGreaterThan(200);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "apply creates okm_backfill on a fresh database and on one that already has history",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await applyTo(schemaName, [
        migration("0001_new", "hash-new", [
          {
            sql: `create table ${q(schemaName)}.fresh (id integer)`,
            class: "expand",
            action: "ddl",
            lock: "ACCESS EXCLUSIVE",
            transactional: true,
          },
        ]),
      ]);
      const created = await sql<
        { name: string | null }[]
      >`select to_regclass('okm_backfill')::text as name`;
      expect(created[0]?.name).toContain("okm_backfill");
    });
  },
  20_000,
);

postgresTest(
  gate,
  "an existing history table gains okm_backfill without a migration",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table okm_meta (id text primary key, catalog_hash text not null, migration_id text not null)`,
      );
      await sql.unsafe(
        `create table okm_history (
          migration_id text not null,
          step_index integer not null,
          class text not null,
          catalog_hash text not null,
          applied_at timestamptz not null default now(),
          primary key (migration_id, step_index)
        )`,
      );
      await sql.unsafe(`insert into okm_meta values ('head', 'old', '0000_old')`);
      await sql.unsafe(`insert into okm_history values ('0000_old', 0, 'expand', 'old')`);
      const missing = await sql<
        { name: string | null }[]
      >`select to_regclass('okm_backfill')::text as name`;
      expect(missing[0]?.name ?? null).toBeNull();
      await applyTo(schemaName, [
        migration("0000_old", "old", [
          {
            sql: "select 1",
            class: "expand",
            action: "ddl",
            lock: "ACCESS SHARE",
            transactional: true,
          },
        ]),
        migration("0001_next", "next", [
          {
            sql: `create table ${q(schemaName)}.next (id integer)`,
            class: "expand",
            action: "ddl",
            lock: "ACCESS EXCLUSIVE",
            transactional: true,
          },
        ]),
      ]);
      const created = await sql<
        { name: string | null }[]
      >`select to_regclass('okm_backfill')::text as name`;
      expect(created[0]?.name).toContain("okm_backfill");
      const tables = await sql<{ name: string }[]>`select to_regclass('next')::text as name`;
      expect(tables[0]?.name).toContain("next");
    });
  },
  20_000,
);

function applyTo(
  schemaName: string,
  migrations: readonly StoredMigration[],
  options?: {
    readonly protected?: boolean | (() => boolean);
    readonly allowProtected?: boolean;
    readonly lockTimeoutMs?: number;
    readonly statementTimeoutMs?: number;
    readonly retries?: number;
    readonly backfillPauseMs?: number;
    readonly onProgress?: (line: string) => void;
    readonly afterBatch?: (batch: BackfillBatch) => void | Promise<void>;
  },
): Promise<ApplyReport> {
  const protectedFlag = options?.protected;
  return applyTarget({
    url,
    target: schemaName,
    get protected() {
      return typeof protectedFlag === "function" ? protectedFlag() : protectedFlag === true;
    },
    ...(options?.allowProtected !== undefined ? { allowProtected: options.allowProtected } : {}),
    searchPath: schemaName,
    migrations,
    ...(options?.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    ...(options?.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: options.statementTimeoutMs }
      : {}),
    ...(options?.retries !== undefined ? { retries: options.retries } : {}),
    ...(options?.backfillPauseMs !== undefined ? { backfillPauseMs: options.backfillPauseMs } : {}),
    ...(options?.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    ...(options?.afterBatch !== undefined ? { afterBatch: options.afterBatch } : {}),
  });
}

async function applyPlan(
  schemaName: string,
  id: string,
  before: Catalog,
  after: Catalog,
  batchSize?: number,
  replacements?: readonly Replacement[],
): Promise<void> {
  const plan = planMigration({
    before,
    after,
    schema: schemaName,
    name: id,
    ...(batchSize !== undefined ? { batchSize } : {}),
    ...(replacements !== undefined ? { replacements } : {}),
  });
  await applyTo(schemaName, [migration(id, catalogHash(after), plan.steps)]);
}

function migration(id: string, hash: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash: hash, steps };
}

function fillStep(schemaName: string, batch: number, extra = ""): PlanStep {
  const table = `${q(schemaName)}."items"`;
  const range =
    '($1::text is null or "id" > $1::integer) and ($2::text is null or "id" <= $2::integer)';
  return {
    sql: `update ${table} set touches = touches + 1 where ${range}${extra}`,
    class: "expand",
    action: "backfill",
    lock: "ROW EXCLUSIVE",
    transactional: false,
    backfill: { table, key: ['"id"'], batch },
  };
}

function q(name: string): string {
  return `"${name}"`;
}

async function installCounter(sql: Sql, schemaName: string, tableName: string): Promise<void> {
  await sql.unsafe(`create table if not exists ${q(schemaName)}.upd_sizes (n integer not null)`);
  await sql.unsafe(
    `create or replace function ${q(schemaName)}.upd_count() returns trigger language plpgsql as $$
     begin
       insert into upd_sizes select count(*)::integer from changed;
       return null;
     end $$`,
  );
  await sql.unsafe(
    `create trigger upd_count after update on ${q(schemaName)}.${q(tableName)}
     referencing new table as changed
     for each statement execute function ${q(schemaName)}.upd_count()`,
  );
}

async function statementSizes(sql: Sql): Promise<number[]> {
  const rows = await sql<{ n: number }[]>`select n from upd_sizes`;
  return rows.map((row) => row.n);
}

type CheckpointRow = {
  readonly migration_id: string;
  readonly step_index: string;
  readonly last_key: string | null;
  readonly rows_touched: string;
  readonly batches: string;
  readonly state: string;
};

async function backfillRows(sql: Sql): Promise<CheckpointRow[]> {
  return sql<CheckpointRow[]>`
    select migration_id, step_index::text, last_key, rows_touched::text, batches::text, state
    from okm_backfill
    order by migration_id, step_index
  `;
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
