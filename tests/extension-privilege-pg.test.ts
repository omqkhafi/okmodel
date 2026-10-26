/**
 * A NOSUPERUSER cannot create an untrusted extension, or a trusted one
 * without CREATE on the database (N-140).
 *
 * Doctor and check used to say ok because the package is in
 * `pg_available_extensions`. Apply then failed with permission denied.
 */

import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { applyProject } from "../src/tooling/migrate/apply.js";
import { checkMigrations } from "../src/tooling/migrate/check.js";
import { run } from "../src/tooling/migrate/commands.js";
import { doctorProject } from "../src/tooling/migrate/doctor.js";
import { checkProject } from "../src/tooling/migrate/project.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const flags = { allowProtected: false, allowPooler: false };

postgresTest(
  gate,
  "a NOSUPERUSER owner cannot create an untrusted extension",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const role = `okm_n140_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const cwd = mkdtempSync(join(tmpdir(), "okm-n140-"));
    try {
      if (!(await extensionAvailable(admin, "amcheck"))) return;
      await admin.unsafe(
        `create role ${role} nosuperuser login password 'n140' nocreatedb nocreaterole`,
      );
      await admin.unsafe(`alter database ${databaseName(database.url)} owner to ${role}`);
      const superuser = mkdtempSync(join(tmpdir(), "okm-n140-super-"));
      writeProject(superuser, database.url, amcheckSchema());
      expect(await doctorProject(superuser, undefined)).toBe("no triggers\n");
      expect((await checkProject(superuser)).findings).toEqual([]);
      rmSync(superuser, { recursive: true, force: true });
      writeProject(cwd, roleUrl(database.url, role, "n140"), amcheckSchema());
      const doctor = await refused(() => doctorProject(cwd, undefined));
      expect(doctor.code).toBe("OKM1811");
      expect(doctor.message).toContain(role);
      expect(doctor.message).toContain("amcheck");
      expect(doctor.message.toLowerCase()).not.toContain("permission denied");
      expect(doctor.fix.summary).toContain("not trusted");
      const checked = await refused(() => checkProject(cwd));
      expect(checked.code).toBe("OKM1811");
      expect(checked.message).toContain(role);
      expect(checked.message).toContain("amcheck");
      await run(["generate", "init"], { cwd, stdout: () => undefined });
      const replay = await refused(() => checkMigrations(cwd, flags));
      expect(replay.code).toBe("OKM1811");
      expect(replay.message).toContain(role);
      expect(replay.message).toContain("amcheck");
      expect(replay.message.toLowerCase()).not.toContain("permission denied");
      const applied = await refused(() => applyProject(cwd, flags));
      expect(applied.code).toBe("OKM1811");
      expect(applied.message).toContain("amcheck");
      expect(applied.message.toLowerCase()).not.toContain("permission denied");
      const installed = await admin<{ n: string }[]>`
        select extname as n from pg_extension where extname = 'amcheck'
      `;
      expect(installed).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await database.close();
      const cluster = openPostgres();
      await cluster.unsafe(`drop role if exists ${role}`).catch(() => undefined);
      await cluster.end({ timeout: 5 });
    }
  },
  90_000,
);

postgresTest(
  gate,
  "a role without CREATE cannot create a trusted extension",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const role = `okm_n140_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const cwd = mkdtempSync(join(tmpdir(), "okm-n140-create-"));
    try {
      if (!(await extensionAvailable(admin, "pg_trgm"))) return;
      await admin.unsafe(
        `create role ${role} nosuperuser login password 'n140' nocreatedb nocreaterole`,
      );
      const create = await admin<{ ok: boolean }[]>`
        select has_database_privilege(${role}, current_database(), 'CREATE') as ok
      `;
      expect(create[0]?.ok).toBe(false);
      writeProject(cwd, roleUrl(database.url, role, "n140"), trigramSchema());
      const doctor = await refused(() => doctorProject(cwd, undefined));
      expect(doctor.code).toBe("OKM1811");
      expect(doctor.message).toContain(role);
      expect(doctor.message).toContain("pg_trgm");
      expect(doctor.fix.summary).toContain("CREATE");
      const checked = await refused(() => checkProject(cwd));
      expect(checked.code).toBe("OKM1811");
      expect(checked.message).toContain("pg_trgm");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await database.close();
      const cluster = openPostgres();
      await cluster.unsafe(`drop role if exists ${role}`).catch(() => undefined);
      await cluster.end({ timeout: 5 });
    }
  },
  60_000,
);

async function refused(runCheck: () => Promise<unknown>): Promise<OkmError> {
  try {
    await runCheck();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected a refusal");
}

async function extensionAvailable(
  sql: ReturnType<typeof openPostgres>,
  name: string,
): Promise<boolean> {
  const rows = await sql<
    { ok: number }[]
  >`select 1 as ok from pg_available_extensions where name = ${name}`;
  return rows.length > 0;
}

function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
  return name;
}

function roleUrl(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.href.replace(/\/$/, "");
}

function writeProject(cwd: string, url: string, schemaSource: string): void {
  writeFileSync(join(cwd, "schema.ts"), schemaSource);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "migrations"), { recursive: true });
}

function amcheckSchema(): string {
  return [
    `import { extension } from ${JSON.stringify(join(root, "src/dialects/pg/ext/index.ts"))};`,
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'const notes = table("notes", { id: t.id() });',
    'export const app = schema({ tables: [notes], extensions: [extension("amcheck")] });',
    "",
  ].join("\n");
}

function trigramSchema(): string {
  return [
    `import { pgTrgm } from ${JSON.stringify(join(root, "src/dialects/pg/ext/pg-trgm.ts"))};`,
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    "const trgm = pgTrgm();",
    'const docs = table("docs", { id: t.id(), body: t.text() }, { indexes: (c) => [trgm.gin(c.body.name)] });',
    "export const app = schema({ tables: [docs], extensions: [trgm] });",
    "",
  ].join("\n");
}
