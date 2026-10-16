/**
 * Two catalogs in one database: each `connect()` reads its own `okm_meta`.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { open } from "../src/adapters/pg/postgresjs.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import type { QuerySchema } from "../src/dialects/pg/model.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "each catalog connects to its own hash, and a stale hash is OKM1520",
  async () => {
    const database = await createIsolatedDatabase();
    const identity = project("identity");
    const billing = project("billing");
    try {
      writeSchema(identity, "identity");
      writeSchema(billing, "billing");
      writeConfig(identity, database.url, "identity");
      writeConfig(billing, database.url, "billing");
      await cli(identity, ["generate", "init"]);
      await cli(billing, ["generate", "init"]);
      await cli(identity, ["migrate", "apply"]);
      await cli(billing, ["migrate", "apply"]);
      expect(readFileSync(join(identity, ".okm", "namespace"), "utf8")).toBe("identity\n");
      expect(readFileSync(join(billing, ".okm", "namespace"), "utf8")).toBe("billing\n");

      const identitySchema = await loadSchema(identity);
      const billingSchema = await loadSchema(billing);
      const identitySql = await startupSql(database.url, identitySchema, join(identity, ".okm"));
      const billingSql = await startupSql(database.url, billingSchema, join(billing, ".okm"));
      expect(identitySql).toContain(`"identity".okm_meta`);
      expect(billingSql).toContain(`"billing".okm_meta`);
      expect(identitySql).not.toContain("billing");
      expect(billingSql).not.toContain("identity");

      await connectOk(database.url, identitySchema, join(identity, ".okm"));
      await connectOk(database.url, billingSchema, join(billing, ".okm"));

      await sqlOn(database.url, `update "billing".okm_meta set catalog_hash = 'stale'`);
      const stale = connect(database.url, {
        schema: billingSchema,
        catalogDir: join(billing, ".okm"),
        max: 1,
      });
      const error = await catchError(() => stale.connected);
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) {
        expect(error.code).toBe("OKM1520");
        expect(error.message).toContain("0001_init");
      }
      await stale.close();

      const vacant = mkdtempSync(join(tmpdir(), "okm-vacant-"));
      writeFileSync(join(vacant, "namespace"), "vacant\n");
      writeFileSync(
        join(vacant, "catalog.hash"),
        readFileSync(join(identity, ".okm", "catalog.hash")),
      );
      const skipped = await startupSql(database.url, identitySchema, vacant);
      expect(skipped).toContain(`"vacant".okm_meta`);
      await connectOk(database.url, identitySchema, vacant);
      rmSync(vacant, { recursive: true, force: true });
    } finally {
      rmSync(identity, { recursive: true, force: true });
      rmSync(billing, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function project(name: string): string {
  return mkdtempSync(join(tmpdir(), `okm-${name}-`));
}

function writeSchema(cwd: string, table: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      `export const app = schema({ tables: [table(${JSON.stringify(table)}, { id: t.integer() })] });`,
      "",
    ].join("\n"),
  );
}

function writeConfig(cwd: string, url: string, namespace: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      `  namespace: ${JSON.stringify(namespace)},`,
      "});",
      "",
    ].join("\n"),
  );
}

async function loadSchema(cwd: string): Promise<QuerySchema> {
  const loaded = (await import(pathToFileURL(join(cwd, "schema.ts")).href)) as {
    app: QuerySchema;
  };
  return loaded.app;
}

async function connectOk(url: string, schema: QuerySchema, catalogDir: string): Promise<void> {
  const client = connect(url, { schema, catalogDir, max: 1 });
  try {
    await client.connected;
  } finally {
    await client.close();
  }
}

async function startupSql(url: string, schema: QuerySchema, catalogDir: string): Promise<string> {
  const pool = open({ url, max: 1 });
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
  const client = connect(counting, { schema, catalogDir });
  try {
    await client.connected;
  } finally {
    await client.close();
    await pool.close();
  }
  const first = queries[0];
  if (first === undefined) throw new Error("connect sent no startup query");
  return first;
}

async function sqlOn(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function cli(cwd: string, argv: readonly string[]): Promise<void> {
  const script = [
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    `await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: () => undefined });`,
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : `okm exited ${String(code)}`);
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}
