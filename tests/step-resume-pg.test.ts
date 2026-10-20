/**
 * Committed-step resume on Postgres and PGlite.
 *
 * PGlite covers the crash boundaries and the probes that do not need
 * CONCURRENTLY. Real Postgres covers a killed concurrent build and a valid
 * index whose definition does not match.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { serializeCatalog } from "../src/contracts/catalog/document.js";
import type { DriverConnection } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { applyTarget, ensureMigrationTables } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import type { PlanStep, StepKind } from "../src/tooling/migrate/plan.js";
import { postgresStepEngine } from "../src/tooling/migrate/pg-probe.js";
import { resolveProject } from "../src/tooling/migrate/resolve.js";
import { formatStatus, readTargetStatus } from "../src/tooling/migrate/status.js";
import { postgresStepJournal } from "../src/tooling/migrate/step-journal.js";
import {
  resumeCommittedStep,
  stepSqlHash,
  type CommittedStep,
  type StepBoundary,
} from "../src/tooling/migrate/step-engine.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

test("pglite resumes a committed check at every crash boundary", async () => {
  const pool = await openPglite();
  const connection = await pool.reserve?.();
  if (connection === undefined) throw new Error("PGlite cannot reserve a connection");
  try {
    await ensureMigrationTables((sql) => connection.execute(sql));
    await connection.execute("create table items (id integer)");
    for (const boundary of ["before-started", "after-started", "after-ddl"] as const) {
      await connection.execute("alter table items drop constraint if exists items_id_check");
      await connection.execute("delete from okm_history");
      await connection.execute("delete from okm_steps");
      await connection.execute("delete from okm_meta");
      const sql = "alter table items add constraint items_id_check check (id > 0) not valid";
      const committed = committedStep(sql, "add-constraint");
      const runs: string[] = [];
      const failed = await catchError(() =>
        resumeCommittedStep(
          committed,
          postgresStepJournal(connection),
          engine(connection, committed, runs),
          {
            retries: 0,
            failAt: boundary,
            wrap: (error) =>
              new OkmError("invalid", error instanceof Error ? error.message : "failed"),
          },
        ),
      );
      expect(failed).toBeInstanceOf(Error);
      if (boundary === "before-started") expect(await count(connection, "okm_steps")).toBe(0);
      if (boundary === "after-started") {
        expect(await count(connection, "okm_steps")).toBe(1);
        expect(await constraint(connection)).toBe(false);
      }
      if (boundary === "after-ddl") {
        expect(await constraint(connection)).toBe(true);
        expect(await count(connection, "okm_history")).toBe(0);
      }
      runs.length = 0;
      await resumeCommittedStep(
        committed,
        postgresStepJournal(connection),
        engine(connection, committed, runs),
        {
          retries: 0,
          wrap: (error) =>
            new OkmError("invalid", error instanceof Error ? error.message : "failed"),
        },
      );
      expect(await constraint(connection)).toBe(true);
      expect(await count(connection, "okm_steps")).toBe(0);
      expect(await count(connection, "okm_history")).toBe(1);
      if (boundary === "after-ddl") expect(runs).toEqual([]);
    }
  } finally {
    await connection.release();
    await pool.close();
  }
}, 30_000);

test("pglite resolve refuses an absent probe and accepts an applied one", async () => {
  const pool = await openPglite();
  const connection = await pool.reserve?.();
  if (connection === undefined) throw new Error("PGlite cannot reserve a connection");
  try {
    await ensureMigrationTables((sql) => connection.execute(sql));
    await connection.execute("create table items (id integer)");
    await connection.execute("create type color as enum ('red')");
    const sql = "alter type color add value 'blue'";
    const committed = committedStep(sql, "add-enum-value");
    await postgresStepJournal(connection).start(committed, 1);
    const absent = postgresStepEngine(
      connection,
      { kind: "add-enum-value", sql, lockTimeoutMs: 1_000 },
      () => Promise.resolve(),
    );
    expect(await absent.probe()).toBe("absent");
    await connection.execute(sql);
    expect(await absent.probe()).toBe("applied");
    await postgresStepJournal(connection).complete(committed);
    expect(await count(connection, "okm_steps")).toBe(0);
    expect(await count(connection, "okm_history")).toBe(1);
  } finally {
    await connection.release();
    await pool.close();
  }
}, 20_000);

postgresTest(
  gate,
  "apply resumes a committed check after each crash boundary",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.items (id integer)`);
      const statement = `alter table ${q(schemaName)}.items add constraint items_id_check check (id > 0) not valid`;
      for (const boundary of ["before-started", "after-started", "after-ddl"] as const) {
        await sql.unsafe(
          `alter table ${q(schemaName)}.items drop constraint if exists items_id_check`,
        );
        await sql.unsafe("drop table if exists okm_history");
        await sql.unsafe("drop table if exists okm_steps");
        await sql.unsafe("drop table if exists okm_meta");
        await sql.unsafe("drop table if exists okm_backfill");
        const failed = await catchError(() =>
          applyTo(schemaName, [migration([planned(statement, false, "add-constraint")])], boundary),
        );
        expect(failed).toBeInstanceOf(Error);
        await applyTo(schemaName, [migration([planned(statement, false, "add-constraint")])]);
        const defined = await sql<{ name: string | null }[]>`
          select conname as name from pg_constraint
          where conname = 'items_id_check'
        `;
        expect(defined).toHaveLength(1);
        const steps = await sql<{ n: string }[]>`select count(*)::text as n from okm_steps`;
        const history = await sql<{ n: string }[]>`select count(*)::text as n from okm_history`;
        expect(steps[0]?.n).toBe("0");
        expect(history[0]?.n).toBe("1");
      }
    });
  },
  40_000,
);

postgresTest(
  gate,
  "a killed concurrent index build is dropped and rebuilt",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.items (id integer)`);
      await sql.unsafe(`insert into ${q(schemaName)}.items select generate_series(1, 20)`);
      await sql.unsafe(
        `create function ${q(schemaName)}.okm_slow(n integer) returns integer language plpgsql immutable as $$ begin perform pg_sleep(0.15); return n; end $$`,
      );
      const create = `create index concurrently items_id_idx on ${q(schemaName)}.items (${q(schemaName)}.okm_slow(id))`;
      const applying = applyTo(schemaName, [migration([planned(create, false, "create-index")])]);
      const deadline = Date.now() + 15_000;
      let killed = false;
      while (Date.now() < deadline) {
        const rows = await sql<{ pid: string }[]>`
          select pid::text as pid from pg_stat_activity
          where pid <> pg_backend_pid()
            and query ilike '%create index concurrently%items_id_idx%'
        `;
        const found = rows[0]?.pid;
        const invalid = await sql<{ ok: boolean }[]>`
          select i.indisvalid as ok
          from pg_index i
          join pg_class c on c.oid = i.indexrelid
          join pg_namespace n on n.oid = c.relnamespace
          where c.relname = 'items_id_idx' and n.nspname = ${schemaName}
        `;
        if (
          found !== undefined &&
          /^\d+$/.test(found) &&
          invalid.length > 0 &&
          invalid[0]?.ok === false
        ) {
          await sql.unsafe(`select pg_terminate_backend(${found})`);
          killed = true;
          break;
        }
        await Bun.sleep(40);
      }
      expect(killed).toBe(true);
      const failed = await catchError(() => applying);
      expect(failed).toBeTruthy();
      const before = await sql<{ ok: boolean }[]>`
        select i.indisvalid as ok
        from pg_index i
        join pg_class c on c.oid = i.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where c.relname = 'items_id_idx' and n.nspname = ${schemaName}
      `;
      expect(before.length).toBeGreaterThan(0);
      expect(before[0]?.ok).toBe(false);
      await applyTo(schemaName, [migration([planned(create, false, "create-index")])]);
      const after = await sql<{ ok: boolean }[]>`
        select i.indisvalid as ok
        from pg_index i
        join pg_class c on c.oid = i.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where c.relname = 'items_id_idx' and n.nspname = ${schemaName}
      `;
      expect(after).toHaveLength(1);
      expect(after[0]?.ok).toBe(true);
      const steps = await sql<{ n: string }[]>`select count(*)::text as n from okm_steps`;
      expect(steps[0]?.n).toBe("0");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a valid index with a different definition is unknown",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.items (id integer, note integer)`);
      await sql.unsafe(`create index items_id_idx on ${q(schemaName)}.items (id)`);
      const create = `create index concurrently items_id_idx on ${q(schemaName)}.items (note)`;
      const connection = await reserved(schemaName);
      try {
        const probe = postgresStepEngine(
          connection,
          { kind: "create-index", sql: create, lockTimeoutMs: 1_000 },
          () => Promise.resolve(),
        );
        expect(await probe.probe()).toBe("unknown");
      } finally {
        await connection.release();
      }
      const failed = await catchError(() =>
        applyTo(schemaName, [migration([planned(create, false, "create-index")])]),
      );
      expect(messageOf(failed)).toContain("failed at step 1");
      const history = await sql<{ n: string }[]>`select count(*)::text as n from okm_history`;
      expect(history[0]?.n).toBe("0");
      const second = await catchError(() =>
        applyTo(schemaName, [migration([planned(create, false, "create-index")])]),
      );
      expect(second).toBeInstanceOf(OkmError);
      if (second instanceof OkmError) expect(second.code).toBe("OKM1553");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "resolve records, refuses, retries, and protects",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const cwd = mkdtempSync(join(tmpdir(), "okm-resolve-"));
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        `export default { schema: "./schema.ts", namespace: ${JSON.stringify(schemaName)}, database: { url: ${JSON.stringify(url)} } };\n`,
      );
      writeFileSync(join(cwd, "schema.ts"), "export {}\n");
      await sql.unsafe(`create table ${q(schemaName)}.items (id integer)`);
      await sql.unsafe(`create type ${q(schemaName)}.color as enum ('red')`);
      const enumSql = `alter type ${q(schemaName)}.color add value 'blue'`;
      const rawSql = `create table ${q(schemaName)}.other (id integer)`;
      writeMigration(cwd, [
        planned(enumSql, false, "add-enum-value"),
        planned(rawSql, false, "create-table"),
      ]);
      await ensureMigrationTables((text) => sql.unsafe(text));
      await sql.unsafe("delete from okm_steps");
      await sql.unsafe(
        `insert into okm_steps (migration_id, step_index, kind, sql_hash, state, attempt, started_at, runner)
         values ('0001_init', 0, 'add-enum-value', '${stepSqlHash(enumSql)}', 'failed', 1, now(), '1 test')`,
      );
      const refused = await catchError(() =>
        resolveProject(cwd, {
          allowProtected: false,
          allowPooler: false,
          applied: true,
          retry: false,
          acceptUnverified: false,
          step: "0001_init:0",
        }),
      );
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1554");
      await sql.unsafe(`alter type ${q(schemaName)}.color add value 'blue'`);
      const recorded = await resolveProject(cwd, {
        allowProtected: false,
        allowPooler: false,
        applied: true,
        retry: false,
        acceptUnverified: false,
        step: "0001_init:0",
      });
      expect(recorded.result).toBe("recorded");
      const history = await sql<{ n: string }[]>`select count(*)::text as n from okm_history`;
      expect(history[0]?.n).toBe("1");

      await sql.unsafe(
        `insert into okm_steps (migration_id, step_index, kind, sql_hash, state, attempt, started_at, runner)
         values ('0001_init', 1, 'create-table', '${stepSqlHash(rawSql)}', 'failed', 1, now(), '1 test')`,
      );
      const unverified = await catchError(() =>
        resolveProject(cwd, {
          allowProtected: false,
          allowPooler: false,
          applied: true,
          retry: false,
          acceptUnverified: false,
          step: "0001_init:1",
        }),
      );
      expect(unverified).toBeInstanceOf(OkmError);
      if (unverified instanceof OkmError) expect(unverified.code).toBe("OKM1555");
      const accepted = await resolveProject(cwd, {
        allowProtected: false,
        allowPooler: false,
        applied: true,
        retry: false,
        acceptUnverified: true,
        step: "0001_init:1",
      });
      expect(accepted.result).toBe("recorded");

      await sql.unsafe(
        `insert into okm_steps (migration_id, step_index, kind, sql_hash, state, attempt, started_at, runner)
         values ('0001_init', 0, 'add-enum-value', '${stepSqlHash(enumSql)}', 'failed', 2, now(), '1 test')`,
      );
      // step 0 is already in history, so a second resolve of an extra row is not the retry case.
      await sql.unsafe("delete from okm_history where step_index = 0");
      await sql.unsafe("delete from okm_steps where step_index = 0");
      await sql.unsafe(
        `insert into okm_steps (migration_id, step_index, kind, sql_hash, state, attempt, started_at, runner)
         values ('0001_init', 0, 'add-enum-value', '${stepSqlHash(enumSql)}', 'failed', 2, now(), '1 test')`,
      );
      const retried = await resolveProject(cwd, {
        allowProtected: false,
        allowPooler: false,
        applied: false,
        retry: true,
        acceptUnverified: false,
        step: "0001_init:0",
      });
      expect(retried.result).toBe("retry");
      const state = await sql<
        { state: string }[]
      >`select state from okm_steps where step_index = 0`;
      expect(state[0]?.state).toBe("retry");

      const status = await readTargetStatus({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [
          migration([
            planned(enumSql, false, "add-enum-value"),
            planned(rawSql, false, "create-table"),
          ]),
        ],
      });
      expect(status.state).toContain("failed at step");
      expect(status.steps.length).toBeGreaterThan(0);
      const text = formatStatus([status]);
      expect(text).toContain("failed at step");
      expect(text).toContain("resume with okm migrate apply");
      expect(text).toContain("steps");
      expect(text).toContain("0001_init:0");
    });
  },
  40_000,
);

postgresTest(
  gate,
  "resolve on a protected target needs allow-protected",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const cwd = mkdtempSync(join(tmpdir(), "okm-resolve-guard-"));
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        `export default { schema: "./schema.ts", namespace: ${JSON.stringify(schemaName)}, database: { url: ${JSON.stringify(url)}, protected: true } };\n`,
      );
      writeFileSync(join(cwd, "schema.ts"), "export {}\n");
      writeMigration(cwd, [planned("select 1", false, "raw-sql")]);
      await ensureMigrationTables((text) => sql.unsafe(text));
      await sql.unsafe(
        `insert into okm_steps (migration_id, step_index, kind, sql_hash, state, attempt, started_at, runner)
         values ('0001_init', 0, 'raw-sql', '${stepSqlHash("select 1")}', 'failed', 1, now(), '1 test')`,
      );
      const refused = await catchError(() =>
        resolveProject(cwd, {
          allowProtected: false,
          allowPooler: false,
          applied: false,
          retry: true,
          acceptUnverified: false,
          step: "0001_init:0",
        }),
      );
      expect(refused).toBeInstanceOf(OkmError);
      if (refused instanceof OkmError) expect(refused.code).toBe("OKM1850");
      const allowed = await resolveProject(cwd, {
        allowProtected: true,
        allowPooler: false,
        applied: false,
        retry: true,
        acceptUnverified: false,
        step: "0001_init:0",
      });
      expect(allowed.result).toBe("retry");
    });
  },
  30_000,
);

function committedStep(sql: string, kind: StepKind | "raw-sql"): CommittedStep {
  return {
    migrationId: "0001_init",
    stepIndex: 0,
    kind,
    sql,
    sqlHash: stepSqlHash(sql),
    stepClass: "expand",
    catalogHash: "hash",
    finishes: true,
  };
}

function engine(connection: DriverConnection, step: CommittedStep, runs: string[]) {
  return postgresStepEngine(
    connection,
    { kind: step.kind, sql: step.sql, lockTimeoutMs: 1_000 },
    async () => {
      runs.push("run");
      await connection.execute(step.sql);
    },
  );
}

async function count(connection: DriverConnection, table: string): Promise<number> {
  const result = await connection.execute(`select count(*)::text from ${table}`);
  return Number(result.rows[0]?.[0] ?? "0");
}

async function constraint(connection: DriverConnection): Promise<boolean> {
  const result = await connection.execute(
    "select 1 from pg_constraint where conname = 'items_id_check'",
  );
  return result.rows.length > 0;
}

function migration(steps: readonly PlanStep[]): StoredMigration {
  return { id: "0001_init", catalogHash: "hash", steps };
}

function planned(sql: string, transactional: boolean, kind: StepKind | "raw-sql"): PlanStep {
  return {
    sql,
    class: "expand",
    action: "ddl",
    lock: "SHARE UPDATE EXCLUSIVE",
    transactional,
    ...(kind === "raw-sql" ? {} : { kind }),
  };
}

function writeMigration(cwd: string, steps: readonly PlanStep[]): void {
  const lines = ["-- name: 0001_init", "-- class: expand", ""];
  for (const step of steps) {
    lines.push(`-- class: ${step.class}`);
    if (step.kind !== undefined) lines.push(`-- kind: ${step.kind}`);
    lines.push("-- action: ddl");
    lines.push(`-- lock: ${step.lock}`);
    if (!step.transactional) lines.push("-- transactional: false");
    lines.push(step.sql);
    lines.push("");
  }
  mkdirSync(join(cwd, "migrations"), { recursive: true });
  writeFileSync(join(cwd, "migrations", "0001_init.sql"), `${lines.join("\n")}\n`);
  writeFileSync(join(cwd, "migrations", "0001_init.catalog.json"), serializeCatalog(catalog([])));
}

function applyTo(
  schemaName: string,
  migrations: readonly StoredMigration[],
  failAt?: StepBoundary,
) {
  return applyTarget({
    url,
    target: schemaName,
    protected: false,
    searchPath: schemaName,
    migrations,
    ...(failAt !== undefined ? { failAt } : {}),
  });
}

async function reserved(schemaName: string): Promise<DriverConnection> {
  const { open } = await import("../src/adapters/pg/postgresjs.js");
  const pool = open({ url, max: 1, searchPath: schemaName });
  if (pool.reserve === undefined) throw new Error("no reserve");
  return pool.reserve();
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
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
