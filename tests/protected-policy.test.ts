/**
 * Spec 19.7, one enumeration.
 *
 * Every operation class runs against a protected target and an unprotected
 * target, through the entry point that exists for it: the CLI, `applyTarget`,
 * the backfill step inside apply, `seedProject`, `runTarget`, and `provision`.
 * Expected results are the table in section 19.7. `okm migrate check` stays
 * refused with `--allow-protected`. Provision is allowed only on an empty
 * target (OKM1851 otherwise, section 19.6).
 *
 * `verify`, `pull`, `catalog-export`, and `inspect` are allowed by the table
 * and have no command in 0.4. History repair has no command either; the
 * policy blocks that class.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../src/adapters/pg/postgresjs.js";
import type { DriverConnection } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  type IsolatedDatabase,
} from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { run } from "../src/tooling/migrate/commands.js";
import type { PlanStep } from "../src/tooling/migrate/plan.js";
import { assertTargetPolicy } from "../src/tooling/migrate/policy.js";
import { provision } from "../src/tooling/migrate/provision.js";
import { runTarget, type RunnableUnit } from "../src/tooling/migrate/runner.js";
import { seedProject } from "../src/tooling/migrate/seed.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const NOTES = `table("notes", { id: t.identity(), title: t.text().default("x") })`;

const ROLES = `table("roles", {
  code: t.text().primaryKey(),
  label: t.text(),
}, { reference: { key: "code", rows: [{ code: "admin", label: "Admin" }] } })`;

const CONTRACT = file([
  "-- okm-allow OKM1512: title moved out of this table",
  "-- class: contract",
  "-- kind: drop-column",
  "-- action: ddl",
  "-- lock: ACCESS EXCLUSIVE",
  `alter table "notes" drop column "title"`,
]);

const RAW = file(["select 1"]);

const FILL = file([
  "-- class: expand",
  "-- action: backfill",
  "-- lock: ROW EXCLUSIVE",
  "-- transactional: false",
  `-- backfill table="public"."notes" key="id" batch=10`,
  `update "notes" set "title" = "title" where ("id" > $1 or $1 is null) and ("id" <= $2 or $2 is null)`,
]);

function file(lines: readonly string[]): string {
  return ["-- name: policy", "-- class: expand", "", ...lines, ""].join("\n");
}

const EXPAND_SQL = `create table "notes" (
  "id" bigint generated always as identity primary key,
  "title" text not null
)`;

const TAGS_SQL = `create table "tags" ("id" integer primary key)`;

postgresTest(
  gate,
  "protected.policy enumerates every operation class in spec 19.7",
  async () => {
    const databases: IsolatedDatabase[] = [];
    const dirs: string[] = [];
    const database = async (): Promise<IsolatedDatabase> => {
      const created = await createIsolatedDatabase();
      databases.push(created);
      return created;
    };
    try {
      const saved = process.env.OKM_ALLOW_PROTECTED;
      process.env.OKM_ALLOW_PROTECTED = "1";
      try {
        let blocked: unknown;
        try {
          assertTargetPolicy({ name: "production", protected: true }, "push");
        } catch (error) {
          blocked = error;
        }
        expect(blocked).toBeInstanceOf(OkmError);
        if (blocked instanceof OkmError) expect(blocked.code).toBe("OKM1850");
      } finally {
        if (saved === undefined) delete process.env.OKM_ALLOW_PROTECTED;
        else process.env.OKM_ALLOW_PROTECTED = saved;
      }
      expect(() =>
        assertTargetPolicy({ name: "production", protected: false }, "push"),
      ).not.toThrow();
      for (const operation of ["verify", "pull", "catalog-export", "inspect"] as const) {
        expect(() =>
          assertTargetPolicy({ name: "production", protected: true }, operation),
        ).not.toThrow();
      }
      expect(code(() => assertTargetPolicy(locked, "history-repair"))).toBe("OKM1850");
      expect(code(() => assertTargetPolicy(locked, "history-repair", true))).toBe("ok");
      expect(code(() => assertTargetPolicy(openTarget, "history-repair"))).toBe("ok");

      const main = await database();
      const cwd = dir(dirs);
      writeSchema(cwd, NOTES);
      writeSeed(cwd);
      writeConfig(cwd, main.url, false);
      await capture(["generate", "init"], cwd);
      expect(await capture(["migrate", "apply"], cwd)).toContain("applied provisioned@0001_init");
      await readOnly(cwd, false);
      expect(await capture(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
      expect(await capture(["push"], cwd)).toContain("no changes");
      expect(await capture(["seed", "seed.ts"], cwd)).toBe("target default\nnotes 1\n");

      const lockedDir = dir(dirs);
      writeSchema(lockedDir, NOTES);
      writeSeed(lockedDir);
      writeConfig(lockedDir, main.url, true);
      await capture(["generate", "init"], lockedDir);
      await readOnly(lockedDir, true);
      expect((await refused(["migrate", "check"], lockedDir)).code).toBe("OKM1850");
      const bypass = await refused(["migrate", "check", "--allow-protected"], lockedDir);
      expect(bypass.code).toBe("OKM1850");
      expect(bypass.message).toContain("throwaway");
      expect((await refused(["push"], lockedDir)).code).toBe("OKM1850");
      expect(await capture(["push", "--allow-protected"], lockedDir)).toContain("no changes");
      expect((await refused(["seed", "seed.ts"], lockedDir)).code).toBe("OKM1850");
      expect(
        (
          await refusedCall(() =>
            seedProject(lockedDir, "seed.ts", { allowProtected: false, allowPooler: false }),
          )
        ).code,
      ).toBe("OKM1850");
      expect(
        await seedProject(lockedDir, "seed.ts", { allowProtected: true, allowPooler: false }),
      ).toBe("target default\nnotes 1\n");

      addStep(lockedDir, "0002_fill", FILL);
      expect((await refused(["migrate", "apply"], lockedDir)).code).toBe("OKM1850");
      expect(await capture(["migrate", "apply", "--allow-protected"], lockedDir)).toContain(
        "applied 0002_fill",
      );
      addStep(lockedDir, "0003_raw", RAW);
      expect((await refused(["migrate", "apply"], lockedDir)).code).toBe("OKM1850");
      expect(await capture(["migrate", "apply", "--allow-protected"], lockedDir)).toContain(
        "applied 0003_raw",
      );
      addStep(lockedDir, "0004_contract", CONTRACT);
      expect((await refused(["migrate", "apply"], lockedDir)).code).toBe("OKM1850");
      expect(await capture(["migrate", "apply", "--allow-protected"], lockedDir)).toContain(
        "applied 0004_contract",
      );

      const openDb = await database();
      const openDir = dir(dirs);
      writeSchema(openDir, NOTES);
      writeConfig(openDir, openDb.url, false);
      await capture(["generate", "init"], openDir);
      await capture(["migrate", "apply"], openDir);
      addStep(openDir, "0002_fill", FILL);
      addStep(openDir, "0003_raw", RAW);
      addStep(openDir, "0004_contract", CONTRACT);
      const openApply = await capture(["migrate", "apply"], openDir);
      expect(openApply).toContain("applied 0002_fill");
      expect(openApply).toContain("applied 0003_raw");
      expect(openApply).toContain("applied 0004_contract");

      await engineAndRunner(await database(), true);
      await engineAndRunner(await database(), false);

      const protectedEmpty = await database();
      const protectedProvision = dir(dirs);
      writeSchema(protectedProvision, ROLES);
      writeConfig(protectedProvision, protectedEmpty.url, true);
      await capture(["generate", "init"], protectedProvision);
      expect(await provision("default", protectedProvision)).toContain("applied provisioned@");
      expect(await labels(protectedEmpty.url)).toEqual(["admin=Admin"]);

      const openEmpty = await database();
      const openProvision = dir(dirs);
      writeSchema(openProvision, ROLES);
      writeConfig(openProvision, openEmpty.url, false);
      await capture(["generate", "init"], openProvision);
      expect(await capture(["migrate", "apply"], openProvision)).toContain("applied provisioned@");
      expect(await labels(openEmpty.url)).toEqual(["admin=Admin"]);

      const occupied = await database();
      const sql = openPostgres(occupied.url);
      try {
        await sql.unsafe(`create table junk (id integer)`);
      } finally {
        await sql.end({ timeout: 5 });
      }
      const occupiedDir = dir(dirs);
      writeSchema(occupiedDir, ROLES);
      writeConfig(occupiedDir, occupied.url, true);
      await capture(["generate", "init"], occupiedDir);
      expect((await refusedCall(() => provision("default", occupiedDir))).code).toBe("OKM1851");
      writeConfig(occupiedDir, occupied.url, false);
      expect((await refused(["migrate", "apply"], occupiedDir)).code).toBe("OKM1851");
    } finally {
      for (const cwd of dirs) rmSync(cwd, { recursive: true, force: true });
      for (const created of databases) await created.close();
    }
  },
  180_000,
);

const locked = { name: "production", protected: true };
const openTarget = { name: "dev", protected: false };

function code(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    if (error instanceof OkmError) return error.code;
    throw error;
  }
}

async function readOnly(cwd: string, protectedTarget: boolean): Promise<void> {
  const plan = await capture(["migrate", "plan", "next"], cwd);
  expect(plan.length).toBeGreaterThan(0);
  const status = await capture(["migrate", "status"], cwd);
  expect(status).toContain(protectedTarget ? "\ttrue" : "\tfalse");
  expect(await capture(["check"], cwd)).toContain("ok\n");
  expect(await capture(["ext", "check"], cwd)).toBe("no extensions\n");
}

async function engineAndRunner(
  database: IsolatedDatabase,
  protectedTarget: boolean,
): Promise<void> {
  const expand = step(EXPAND_SQL, "expand", "ddl");
  const contract = step(
    `alter table "notes" drop column "title"`,
    "contract",
    "ddl",
    "drop-column",
  );
  const raw = step("select 1", "unclassified", "ddl");
  const fill = step(
    `update "notes" set "title" = "title" where ("id" > $1 or $1 is null) and ("id" <= $2 or $2 is null)`,
    "expand",
    "backfill",
  );
  if (protectedTarget) {
    await applyStep(database.url, true, "0001_expand", expand);
    expect(
      (await refusedCall(() => applyStep(database.url, true, "0002_contract", contract))).code,
    ).toBe("OKM1850");
    expect((await refusedCall(() => applyStep(database.url, true, "0003_raw", raw))).code).toBe(
      "OKM1850",
    );
    expect((await refusedCall(() => applyStep(database.url, true, "0004_fill", fill))).code).toBe(
      "OKM1850",
    );
    await withRunner(database.url, async (connection) => {
      expect(
        (await refusedCall(() => runOne(connection, true, "0002_contract", contract))).code,
      ).toBe("OKM1850");
      expect((await refusedCall(() => runOne(connection, true, "0003_raw", raw))).code).toBe(
        "OKM1850",
      );
      expect((await refusedCall(() => runOne(connection, true, "0004_fill", fill))).code).toBe(
        "OKM1850",
      );
      await runOne(connection, true, "0005_tags", step(TAGS_SQL, "expand", "ddl"));
    });
    await applyStep(database.url, true, "0002_fill", fill, true);
    await applyStep(database.url, true, "0003_raw", raw, true);
    await applyStep(database.url, true, "0004_contract", contract, true);
    return;
  }
  await applyStep(database.url, false, "0001_expand", expand);
  await applyStep(database.url, false, "0002_fill", fill);
  await withRunner(database.url, async (connection) => {
    await runOne(connection, false, "0003_raw", raw);
  });
  await applyStep(database.url, false, "0004_contract", contract);
}

function step(
  sql: string,
  classification: PlanStep["class"],
  action: PlanStep["action"],
  kind?: PlanStep["kind"],
): PlanStep {
  return {
    sql,
    class: classification,
    action,
    lock: action === "backfill" ? "ROW EXCLUSIVE" : "ACCESS EXCLUSIVE",
    transactional: action !== "backfill",
    ...(kind !== undefined ? { kind } : {}),
    ...(action === "backfill"
      ? { backfill: { table: `"public"."notes"`, key: ["id"], batch: 10 } }
      : {}),
  };
}

async function applyStep(
  url: string,
  protectedTarget: boolean,
  id: string,
  planStep: PlanStep,
  allowProtected = false,
): Promise<void> {
  const report = await applyTarget({
    url,
    target: "default",
    protected: protectedTarget,
    allowProtected,
    migrations: [{ id, catalogHash: "policy", steps: [planStep] }],
  });
  expect(report.applied).toEqual([id]);
}

async function runOne(
  connection: DriverConnection,
  protectedTarget: boolean,
  id: string,
  planStep: PlanStep,
  allowProtected = false,
): Promise<void> {
  const unit: RunnableUnit = {
    migrationId: id,
    catalogHash: "policy",
    finishes: true,
    transactional: planStep.transactional,
    steps: [{ index: 0, step: planStep }],
  };
  const report = await runTarget(
    connection,
    {
      policy: { target: "default", protected: protectedTarget, allowProtected },
      units: [unit],
      retries: 0,
      lockTimeoutMs: 1_000,
      statementTimeoutMs: 5_000,
    },
    {},
  );
  expect(report.applied).toEqual([id]);
}

async function withRunner(
  url: string,
  fn: (connection: DriverConnection) => Promise<void>,
): Promise<void> {
  const pool = open({ url, max: 1 });
  if (pool.reserve === undefined) throw new Error("reserve is required");
  const connection = await pool.reserve();
  try {
    await fn(connection);
  } finally {
    await connection.release();
    await pool.close();
  }
}

async function labels(url: string): Promise<readonly string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ label: string }[]>`
      select code || '=' || label as label from roles order by code
    `;
    return rows.map((row) => row.label);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function capture(argv: readonly string[], cwd: string): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}

async function refused(argv: readonly string[], cwd: string): Promise<OkmError> {
  return refusedCall(() => run(argv, { cwd, stdout: () => undefined }));
}

async function refusedCall(fn: () => Promise<unknown>): Promise<OkmError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("the operation was allowed");
}

function dir(dirs: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-policy-"));
  dirs.push(cwd);
  return cwd;
}

function writeSchema(cwd: string, tables: string): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${pg};`,
      "export const app = schema({",
      `  tables: [${tables}],`,
      "});",
      "",
    ].join("\n"),
  );
}

function writeSeed(cwd: string): void {
  writeFileSync(
    join(cwd, "seed.ts"),
    [
      "export default async function seed(t: {",
      "  factories(definitions: {",
      "    notes(x: { words(count: number): string }): { title: string };",
      "  }): { notes: { create(): Promise<unknown> } };",
      "}): Promise<void> {",
      "  const factories = t.factories({ notes: (x) => ({ title: x.words(2) }) });",
      "  await factories.notes.create();",
      "}",
      "",
    ].join("\n"),
  );
}

function writeConfig(cwd: string, url: string, protectedTarget: boolean): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const target = protectedTarget
    ? `{ url: ${JSON.stringify(url)}, protected: true }`
    : JSON.stringify(url);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${target},`,
      "});",
      "",
    ].join("\n"),
  );
}

function addStep(cwd: string, id: string, body: string): void {
  const directory = join(cwd, "migrations");
  const catalogs = readdirSync(directory)
    .filter((file) => file.endsWith(".catalog.json"))
    .sort();
  const last = catalogs.at(-1);
  if (last === undefined) throw new Error("no catalog");
  writeFileSync(join(directory, `${id}.sql`), body);
  writeFileSync(join(directory, `${id}.catalog.json`), readFileSync(join(directory, last)));
}
