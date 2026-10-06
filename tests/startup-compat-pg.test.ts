/**
 * Startup compatibility and `okm migrate status` on Postgres.
 *
 * Each state is current, ahead by expand, ahead by contract, behind, or a
 * failed step. The equal-hash path must not read `okm_history`.
 */

import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../src/adapters/pg/postgresjs.js";
import { catalogHash, serializeCatalog } from "../src/contracts/catalog/document.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import type { PlanStep } from "../src/tooling/migrate/plan.js";
import { readTargetStatus } from "../src/tooling/migrate/status.js";

const gate = await loadPostgresGate();
const url = primaryUrl();
const app = schema({ tables: [table("items", { id: t.integer() })] });
const codeHash = catalogHash(app.catalog);
const catalogText = serializeCatalog(app.catalog);

postgresTest(
  gate,
  "startup and status share current, ahead, behind, and failed states",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table okm_meta (id text primary key, catalog_hash text not null, migration_id text not null)`,
      );
      await sql.unsafe(
        `create table okm_history (migration_id text not null, step_index integer not null, class text not null, catalog_hash text not null, primary key (migration_id, step_index))`,
      );
      const dir = mkdtempSync(join(tmpdir(), "okm-startup-"));
      writeFileSync(join(dir, "catalog.hash"), `${codeHash}\n`);
      writeFileSync(join(dir, "catalog.json"), catalogText);
      const currentFile = migration("0001_app", codeHash, [step("select 1")]);

      await sql.unsafe(`insert into okm_history values ('0001_app', 0, 'expand', '${codeHash}')`);
      await sql.unsafe(`insert into okm_meta values ('head', '${codeHash}', '0001_app')`);
      const current = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: dir,
      });
      await current.connected;
      await current.close();
      const currentStatus = await readTargetStatus({
        url,
        target: schemaName,
        protected: true,
        searchPath: schemaName,
        migrations: [currentFile],
      });
      expect(currentStatus.state).toBe("current");
      expect(currentStatus.protected).toBe(true);

      await sql.unsafe(`insert into okm_history values ('0002_expand', 0, 'expand', 'newer')`);
      await sql.unsafe(`update okm_meta set catalog_hash = 'newer', migration_id = '0002_expand'`);
      const aheadExpand = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: dir,
      });
      await aheadExpand.connected;
      await aheadExpand.close();
      const aheadExpandStatus = await readTargetStatus({
        url,
        target: schemaName,
        protected: true,
        searchPath: schemaName,
        migrations: [currentFile],
      });
      expect(aheadExpandStatus.state).toBe("ahead by expand");

      await sql.unsafe(
        `update okm_history set class = 'contract' where migration_id = '0002_expand'`,
      );
      const aheadContract = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: dir,
      });
      const aheadContractError = await catchError(() => aheadContract.connected);
      expectGap(aheadContractError, "ahead by contract migration 0002_expand");
      await aheadContract.close();
      const aheadContractStatus = await readTargetStatus({
        url,
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations: [currentFile],
      });
      expect(aheadContractStatus.state).toBe("ahead by contract");

      await sql.unsafe(`delete from okm_history`);
      await sql.unsafe(`delete from okm_meta`);
      await sql.unsafe(`insert into okm_history values ('0001_old', 0, 'expand', 'older')`);
      await sql.unsafe(`insert into okm_meta values ('head', 'older', '0001_old')`);
      const behind = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: dir,
      });
      const behindError = await catchError(() => behind.connected);
      expectGap(behindError, "behind the app at migration 0001_old");
      await behind.close();
      await sql.unsafe(`delete from okm_history`);
      await sql.unsafe(`insert into okm_history values ('0001_base', 0, 'expand', 'base')`);
      const base = migration("0001_base", "base", [step("select 1")]);
      const behindExpand = await readTargetStatus({
        url,
        target: schemaName,
        protected: true,
        searchPath: schemaName,
        migrations: [base, migration("0002_app", codeHash, [step("select 1")])],
      });
      expect(behindExpand.state).toBe("behind by expand");
      const behindContract = await readTargetStatus({
        url,
        target: schemaName,
        protected: true,
        searchPath: schemaName,
        migrations: [
          base,
          migration("0002_drop", "drop", [step("drop table items", true, "contract")]),
        ],
      });
      expect(behindContract.state).toBe("behind by contract");

      await sql.unsafe(`delete from okm_history`);
      await sql.unsafe(`insert into okm_history values ('0003_two', 0, 'expand', 'two')`);
      const failed = await readTargetStatus({
        url,
        target: schemaName,
        protected: true,
        searchPath: schemaName,
        migrations: [migration("0003_two", "two", [step("select 1"), step("select 2")])],
      });
      expect(failed.state).toBe("failed at step 1 (resume with okm migrate apply)");
    });
  },
  20_000,
);

postgresTest(
  gate,
  "the catalog hash fast path does not read okm_history",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table okm_meta (id text primary key, catalog_hash text not null, migration_id text not null)`,
      );
      await sql.unsafe(
        `create table okm_history (migration_id text not null, step_index integer not null, class text not null, catalog_hash text not null, primary key (migration_id, step_index))`,
      );
      await sql.unsafe(`insert into okm_history values ('0009_future', 0, 'contract', 'future')`);
      await sql.unsafe(`insert into okm_meta values ('head', '${codeHash}', '0001_app')`);
      const dir = mkdtempSync(join(tmpdir(), "okm-fast-"));
      writeFileSync(join(dir, "catalog.hash"), `${codeHash}\n`);
      const pool = open({ url, max: 1, searchPath: schemaName });
      const queries: string[] = [];
      const counting: DriverPool = {
        capabilities: pool.capabilities,
        execute: (text, params, options) => {
          queries.push(text);
          return pool.execute(text, params, options);
        },
        batch: (statements, options) => pool.batch(statements, options),
        stats: () => pool.stats(),
        close: () => pool.close(),
      };
      const client = connect(counting, { schema: app, catalogDir: dir });
      try {
        await client.connected;
        expect(queries).toHaveLength(1);
        expect(queries[0]?.includes("okm_history")).toBe(false);
      } finally {
        await client.close();
        await pool.close();
      }
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a missing or mismatched catalog.json is OKM1027",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table okm_meta (id text primary key, catalog_hash text not null, migration_id text not null)`,
      );
      await sql.unsafe(`insert into okm_meta values ('head', 'other', '0009')`);
      const missingDir = mkdtempSync(join(tmpdir(), "okm-missing-"));
      writeFileSync(join(missingDir, "catalog.hash"), `${codeHash}\n`);
      const missing = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: missingDir,
      });
      const missingError = await catchError(() => missing.connected);
      expect(missingError).toBeInstanceOf(OkmError);
      if (missingError instanceof OkmError) {
        expect(missingError.code).toBe("OKM1027");
        expect(missingError.message).toContain("catalog.json is missing");
      }
      await missing.close();

      const wrongDir = mkdtempSync(join(tmpdir(), "okm-wrong-"));
      writeFileSync(join(wrongDir, "catalog.hash"), `${codeHash}\n`);
      writeFileSync(join(wrongDir, "catalog.json"), '{"version":1,"objects":[]}');
      const wrong = connect(url, {
        schema: app,
        searchPath: schemaName,
        max: 1,
        catalogDir: wrongDir,
      });
      const wrongError = await catchError(() => wrong.connected);
      expect(wrongError).toBeInstanceOf(OkmError);
      if (wrongError instanceof OkmError) {
        expect(wrongError.code).toBe("OKM1027");
        expect(wrongError.message).toContain("Catalog hash does not match");
      }
      await wrong.close();
    });
  },
  20_000,
);

function migration(id: string, hash: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash: hash, steps };
}

function step(
  sql: string,
  transactional = true,
  stepClass: PlanStep["class"] = "expand",
): PlanStep {
  return { sql, class: stepClass, action: "ddl", lock: "ACCESS EXCLUSIVE", transactional };
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

function expectGap(error: unknown, phrase: string): void {
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.code).toBe("OKM1520");
  expect(error.message).toContain(phrase);
  expect(error.fix.summary).toContain("Apply");
  expect(error.fix.summary).toContain("deploy order");
}
