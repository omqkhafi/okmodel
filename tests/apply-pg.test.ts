/**
 * Apply, resume, locks, protection, status, and the startup check on Postgres.
 */

import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { catalogHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { pushProject } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import { planMigration, type PlanStep } from "../src/tooling/migrate/plan.js";
import { readTargetStatus } from "../src/tooling/migrate/status.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

postgresTest(
  gate,
  "apply commits, a failed step resumes, and a second apply does not repeat it",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const tableSql = `create table ${q(schemaName)}.items (id integer primary key)`;
      const failing: StoredMigration = {
        id: "0001_items",
        catalogHash: "hash-items",
        steps: [
          step(tableSql),
          step(`insert into ${q(schemaName)}.items values (1)`),
          step(`insert into ${q(schemaName)}.missing values (1)`, false),
        ],
      };
      const failed = await catchError(() => applyTo(schemaName, [failing]));
      expect(messageOf(failed)).toContain("failed at step 2");
      const present = await sql<{ id: number }[]>`select id from items`;
      expect(present.map((row) => row.id)).toEqual([1]);
      const fixed: StoredMigration = {
        ...failing,
        steps: [failing.steps[0]!, failing.steps[1]!, step("select 1", false)],
      };
      const report = await applyTo(schemaName, [fixed]);
      expect(report.applied).toEqual(["0001_items"]);
      const again = await applyTo(schemaName, [fixed]);
      expect(again.applied).toEqual([]);
      expect(await sql<{ id: number }[]>`select id from items`).toHaveLength(1);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a second apply fails at once with OKM1522",
  async () => {
    await withPostgresSchema(async (_sql, schemaName) => {
      let release: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = applyTo(
        schemaName,
        [migration("0001_sleep", "hash-sleep", [step("select pg_sleep(0.4)")])],
        {
          onLocked: release,
        },
      );
      await locked;
      const started = performance.now();
      const raced = await catchError(() =>
        applyTo(schemaName, [migration("0002_other", "hash-other", [step("select 1")])]),
      );
      expect(raced).toBeInstanceOf(OkmError);
      if (raced instanceof OkmError) expect(raced.code).toBe("OKM1522");
      expect(performance.now() - started).toBeLessThan(500);
      await first;
    });
  },
  20_000,
);

postgresTest(
  gate,
  "lock timeout retries until the lock is released",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.held (id integer)`);
      await sql.unsafe("begin");
      await sql.unsafe(`lock table ${q(schemaName)}.held in access exclusive mode`);
      const applying = applyTo(
        schemaName,
        [
          migration("0001_alter", "hash-alter", [
            step(`alter table ${q(schemaName)}.held add column note integer`),
          ]),
        ],
        { lockTimeoutMs: 80, retries: 6 },
      );
      await Bun.sleep(250);
      await sql.unsafe("commit");
      await applying;
      const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${schemaName} and table_name = 'held'
    `;
      expect(columns.map((row) => row.column_name)).toContain("note");
    });
  },
  20_000,
);

postgresTest(
  gate,
  "add value runs outside the transaction that uses it",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const before = schema({
        tables: [table("items", { id: t.integer(), status: t.enum("color", ["red"]) })],
      });
      const after = schema({
        tables: [table("items", { id: t.integer(), status: t.enum("color", ["red", "blue"]) })],
      });
      const init = planMigration({
        before: catalog([]),
        after: before.catalog,
        schema: schemaName,
        name: "init",
      });
      const added = planMigration({
        before: before.catalog,
        after: after.catalog,
        schema: schemaName,
        name: "add",
      });
      expect(added.steps.some((item) => item.transactional === false)).toBe(true);
      await applyTo(schemaName, [
        migration("0001_init", catalogHash(before.catalog), init.steps),
        migration("0002_add", catalogHash(after.catalog), [
          ...added.steps,
          step(`insert into ${q(schemaName)}.items (id, status) values (1, 'blue')`),
        ]),
      ]);
      const rows = await sql<{ status: string }[]>`select status::text as status from items`;
      expect(rows.map((row) => row.status)).toEqual(["blue"]);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a failed concurrent index is dropped and rebuilt on resume",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.items (id integer)`);
      await sql.unsafe(`insert into ${q(schemaName)}.items values (1), (1)`);
      const create = `create unique index concurrently items_id_idx on ${q(schemaName)}.items (id)`;
      const failed = await catchError(() =>
        applyTo(schemaName, [migration("0001_idx", "hash-idx", [step(create, false)])]),
      );
      expect(messageOf(failed)).toContain("failed at step 0");
      await sql.unsafe(
        `delete from ${q(schemaName)}.items where ctid <> (select min(ctid) from ${q(schemaName)}.items)`,
      );
      await applyTo(schemaName, [migration("0001_idx", "hash-idx", [step(create, false)])]);
      const valid = await sql<{ indisvalid: boolean }[]>`
      select i.indisvalid from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname = 'items_id_idx'
    `;
      expect(valid[0]?.indisvalid).toBe(true);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a backfill step runs as the statement the plan wrote",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await applyTo(schemaName, [
        migration("0001_fill", "hash-fill", [
          step(`create table ${q(schemaName)}.items (id integer)`),
          step(`insert into ${q(schemaName)}.items values (1)`),
          {
            sql: `update ${q(schemaName)}.items set id = 2`,
            class: "expand",
            action: "backfill",
            lock: "ROW EXCLUSIVE",
            transactional: true,
          },
        ]),
      ]);
      const rows = await sql<{ id: number }[]>`select id from items`;
      expect(rows.map((row) => row.id)).toEqual([2]);
      const refused = await catchError(() =>
        applyTo(
          schemaName,
          [
            migration("0002_more", "hash-more", [
              {
                sql: `update ${q(schemaName)}.items set id = 3`,
                class: "expand",
                action: "backfill",
                lock: "ROW EXCLUSIVE",
                transactional: true,
              },
            ]),
          ],
          { protected: true },
        ),
      );
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1850");
      const kept = await sql<{ id: number }[]>`select id from items`;
      expect(kept.map((row) => row.id)).toEqual([2]);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a protected target refuses contract and allows expand",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const refused = await catchError(() =>
        applyTo(
          schemaName,
          [
            migration("0001_contract", "hash-c", [
              step(`create table ${q(schemaName)}.blocked (id integer)`, true, "contract"),
            ]),
          ],
          { protected: true },
        ),
      );
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1850");
      const blocked = await sql<{ name: string | null }[]>`
      select to_regclass('blocked')::text as name
    `;
      expect(blocked[0]?.name ?? null).toBeNull();
      await applyTo(
        schemaName,
        [
          migration("0002_expand", "hash-e", [
            step(`create table ${q(schemaName)}.opened (id integer)`),
          ]),
        ],
        { protected: true },
      );
      const opened = await sql<{ name: string }[]>`select to_regclass('opened')::text as name`;
      expect(opened[0]?.name).toContain("opened");
    });
  },
  20_000,
);

postgresTest(gate, "push is refused on a protected target", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-push-"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    `export default { schema: "./schema.ts", database: { url: ${JSON.stringify(url)}, protected: true } };\n`,
  );
  const refused = await catchError(() =>
    pushProject(cwd, { allowProtected: false, allowPooler: false }),
  );
  expect(refused).toBeInstanceOf(OkmError);
  if (refused instanceof OkmError) expect(refused.code).toBe("OKM1850");
});

postgresTest(
  gate,
  "status reports current, behind, ahead, and failed",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const expand = migration("0001_init", "hash-init", [
        step(`create table ${q(schemaName)}.items (id integer)`),
      ]);
      const contract = migration("0002_drop", "hash-drop", [
        step(`alter table ${q(schemaName)}.items add column note text`, true, "contract"),
      ]);
      const behind = await readTargetStatus({
        url,
        target: schemaName,
        protected: true,
        searchPath: schemaName,
        migrations: [expand],
      });
      expect(behind.state).toBe("behind by expand");
      expect(behind.protected).toBe(true);
      const byContract = await readTargetStatus({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [expand, contract],
      });
      expect(byContract.state).toBe("behind by contract");
      await applyTo(schemaName, [expand]);
      const current = await readTargetStatus({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [expand],
      });
      expect(current.state).toBe("current");
      expect(current.version).toBe("0001_init");
      await sql.unsafe(
        `insert into okm_history (migration_id, step_index, class, catalog_hash) values ('0009_future', 0, 'expand', 'future')`,
      );
      await sql.unsafe(`update okm_meta set catalog_hash = 'future', migration_id = '0009_future'`);
      const ahead = await readTargetStatus({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [expand],
      });
      expect(ahead.state).toBe("ahead by expand");
      await sql.unsafe(`delete from okm_history where migration_id = '0009_future'`);
      await sql.unsafe(`delete from okm_meta`);
      const partial = migration("0003_two", "hash-two", [
        step("select 1"),
        step("insert into missing values (1)", false),
      ]);
      const failedApply = await catchError(() => applyTo(schemaName, [partial]));
      expect(messageOf(failedApply)).toContain("failed at step 1");
      const failed = await readTargetStatus({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [expand, partial],
      });
      expect(failed.state).toBe("failed at step 1 (resume with okm migrate apply)");
    });
  },
  20_000,
);

postgresTest(
  gate,
  "startup check uses the hash fast path and fails closed on a bad mismatch",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = schema({ tables: [table("items", { id: t.integer() })] });
      const hash = catalogHash(app.catalog);
      const empty = mkdtempSync(join(tmpdir(), "okm-catalog-"));
      await sql.unsafe(
        `create table okm_meta (id text primary key, catalog_hash text not null, migration_id text not null)`,
      );
      await sql.unsafe(`insert into okm_meta values ('head', '${hash}', '0001')`);
      const fast = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: empty,
      });
      await fast.connected;
      await fast.close();

      const artifact = mkdtempSync(join(tmpdir(), "okm-artifact-"));
      writeFileSync(join(artifact, "catalog.hash"), `${hash}\n`);
      writeFileSync(join(artifact, "catalog.json"), "not-json");
      const trustedFast = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: artifact,
      });
      await trustedFast.connected;
      await trustedFast.close();

      await sql.unsafe(`update okm_meta set catalog_hash = 'other'`);
      const mismatch = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: artifact,
      });
      const drifted = await catchError(() => mismatch.connected);
      expect(drifted).toBeInstanceOf(OkmError);
      if (drifted instanceof OkmError) expect(drifted.code).toBe("OKM1027");
      await mismatch.close();

      await sql.unsafe(`drop table okm_meta`);
      await sql.unsafe(
        `create table okm_meta (id text primary key, catalog_hash text not null, migration_id text not null)`,
      );
      await sql.unsafe(
        `create table okm_history (migration_id text not null, step_index integer not null, class text not null, catalog_hash text not null, primary key (migration_id, step_index))`,
      );
      await sql.unsafe(`insert into okm_history values ('0001_old', 0, 'expand', '${hash}')`);
      await sql.unsafe(`insert into okm_history values ('0002_new', 0, 'expand', 'newer')`);
      await sql.unsafe(`insert into okm_meta values ('head', 'newer', '0002_new')`);
      const ahead = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: empty,
      });
      await ahead.connected;
      await ahead.close();

      await sql.unsafe(`update okm_history set class = 'contract' where migration_id = '0002_new'`);
      const contracted = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: empty,
      });
      const contractedError = await catchError(() => contracted.connected);
      expect(contractedError).toBeInstanceOf(OkmError);
      if (contractedError instanceof OkmError) expect(contractedError.code).toBe("OKM1520");
      await contracted.close();

      await sql.unsafe(`delete from okm_history`);
      await sql.unsafe(`insert into okm_history values ('0001_old', 0, 'expand', 'older')`);
      await sql.unsafe(`update okm_meta set catalog_hash = 'older', migration_id = '0001_old'`);
      const behind = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: empty,
      });
      const behindError = await catchError(() => behind.connected);
      expect(behindError).toBeInstanceOf(OkmError);
      if (behindError instanceof OkmError) expect(behindError.code).toBe("OKM1520");
      await behind.close();
    });
  },
  20_000,
);

function applyTo(
  schemaName: string,
  migrations: readonly StoredMigration[],
  options?: {
    readonly protected?: boolean;
    readonly onLocked?: () => void;
    readonly lockTimeoutMs?: number;
    readonly retries?: number;
  },
) {
  return applyTarget({
    url,
    target: schemaName,
    protected: options?.protected === true,
    searchPath: schemaName,
    migrations,
    ...(options?.onLocked !== undefined ? { onLocked: options.onLocked } : {}),
    ...(options?.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    ...(options?.retries !== undefined ? { retries: options.retries } : {}),
  });
}

function migration(
  id: string,
  catalogHashValue: string,
  steps: readonly PlanStep[],
): StoredMigration {
  return { id, catalogHash: catalogHashValue, steps };
}

function step(
  sql: string,
  transactional = true,
  stepClass: PlanStep["class"] = "expand",
): PlanStep {
  return { sql, class: stepClass, action: "ddl", lock: "ACCESS EXCLUSIVE", transactional };
}

function q(name: string): string {
  return `"${name}"`;
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
