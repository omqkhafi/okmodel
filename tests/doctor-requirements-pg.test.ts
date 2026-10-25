/**
 * `okm doctor` and `okm check` compare the server to `describe()` requirements.
 */

import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { doctorProject } from "../src/tooling/migrate/doctor.js";
import { checkProject } from "../src/tooling/migrate/project.js";

const gate = await loadPostgresGate();
const root = repoRoot();

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const script = [
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    `await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "process.stdout.write(lines.join(''));",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : stdout);
  return stdout;
}

postgresTest(
  gate,
  "okm doctor accepts a plain schema on the connected major",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(database.url, plainSchema());
    try {
      expect(await doctorProject(cwd, undefined)).toBe("no triggers\n");
      const checked = await checkProject(cwd);
      expect(checked.findings).toEqual([]);
      expect(checked.notice).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "okm doctor refuses uuidv7 below Postgres 18 with OKM1802",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const major = await serverMajor(sql);
      const cwd = project(database.url, uuidv7Schema());
      try {
        if (major < 18) {
          const error = await refused(() => doctorProject(cwd, undefined));
          expect(error.code).toBe("OKM1802");
          expect(error.message).toContain("minPostgres: 18");
          const check = await refused(() => checkProject(cwd));
          expect(check.code).toBe("OKM1802");
        } else {
          expect(await doctorProject(cwd, undefined)).toBe("no triggers\n");
          expect((await checkProject(cwd)).findings).toEqual([]);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a schema with no migrations does not raise OKM1811 for an available extension",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await extensionAvailable(sql, "pg_trgm"))) return;
      const cwd = project(database.url, trigramSchema());
      try {
        expect(await doctorProject(cwd, undefined)).toBe("no triggers\n");
        const checked = await checkProject(cwd);
        expect(checked.findings).toEqual([]);
        expect(checked.notice).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "okm doctor refuses a missing required extension with OKM1811",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(database.url, vectorSchema());
    try {
      const error = await refused(() => doctorProject(cwd, undefined));
      expect(error.code).toBe("OKM1811");
      expect(error.message).toContain("vector");
      expect(error.fix.summary).toContain("extension(vector)");
      expect(error.fix.summary).toContain("Install the extension");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "okm doctor accepts an installed trigram extension",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await extensionAvailable(sql, "pg_trgm"))) return;
      await sql.unsafe("create extension pg_trgm");
      const cwd = project(database.url, trigramSchema());
      try {
        expect(await doctorProject(cwd, undefined)).toBe("no triggers\n");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "fresh database with pgTrgm and a pending create migration is ok",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await extensionAvailable(sql, "pg_trgm"))) return;
      const cwd = project(database.url, trigramSchema());
      try {
        await cli(cwd, ["generate", "init"]);
        expect(await doctorProject(cwd, undefined)).toBe("no triggers\n");
        const checked = await checkProject(cwd);
        expect(checked.findings).toEqual([]);
        expect(checked.notice).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "pending pg_trgm migration still reports OKM1520 drift before OKM1811",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await extensionAvailable(sql, "pg_trgm"))) return;
      const cwd = project(database.url, plainSchema());
      try {
        await cli(cwd, ["generate", "init"]);
        await cli(cwd, ["migrate", "apply"]);
        writeFileSync(join(cwd, "schema.ts"), plainPlusTrigramSchema());
        const generated = await cli(cwd, ["generate", "trgm"]);
        expect(generated).toContain("0002_trgm.sql");
        const error = await refused(() => checkProject(cwd));
        expect(error.code).toBe("OKM1520");
        expect(error.message).toContain("create extension");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "several targets without --target print the server checks skipped notice",
  async () => {
    const database = await createIsolatedDatabase();
    const second = await createIsolatedDatabase();
    const cwd = multiTargetProject(database.url, second.url, plainSchema());
    try {
      const notice = "server checks skipped: 2 targets, pass --target <name>\n";
      expect(await doctorProject(cwd, undefined)).toBe(`${notice}no triggers\n`);
      const checked = await checkProject(cwd);
      expect(checked.notice).toBe(notice);
      expect(checked.findings).toEqual([]);
      const printed: string[] = [];
      await run(["check"], { cwd, stdout: (text) => printed.push(text) });
      expect(printed.join("")).toBe(`${notice}ok\n`);
      const doctorOut: string[] = [];
      await run(["doctor"], { cwd, stdout: (text) => doctorOut.push(text) });
      expect(doctorOut.join("")).toBe(`${notice}no triggers\n`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
      await second.close();
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

async function serverMajor(sql: ReturnType<typeof openPostgres>): Promise<number> {
  const rows = await sql<{ n: string }[]>`select current_setting('server_version_num') as n`;
  return Math.floor(Number(rows[0]?.n ?? "0") / 10_000);
}

async function extensionAvailable(
  sql: ReturnType<typeof openPostgres>,
  name: string,
): Promise<boolean> {
  const rows = await sql<{ ok: number }[]>`
    select 1 as ok from pg_available_extensions where name = ${name}
  `;
  return rows.length > 0;
}

function project(url: string, schemaSource: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-doctor-req-"));
  writeFileSync(join(cwd, "schema.ts"), schemaSource);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      `export default defineConfig({`,
      `  schema: "./schema.ts",`,
      `  migrations: "./migrations",`,
      `  database: ${JSON.stringify(url)},`,
      `});`,
      "",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "migrations"));
  return cwd;
}

function multiTargetProject(urlA: string, urlB: string, schemaSource: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-doctor-multi-"));
  writeFileSync(join(cwd, "schema.ts"), schemaSource);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      `export default defineConfig({`,
      `  schema: "./schema.ts",`,
      `  migrations: "./migrations",`,
      `  targets: {`,
      `    a: { url: ${JSON.stringify(urlA)} },`,
      `    b: { url: ${JSON.stringify(urlB)} },`,
      `  },`,
      `});`,
      "",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "migrations"));
  return cwd;
}

function plainSchema(): string {
  return [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'const users = table("users", { id: t.id(), name: t.text() });',
    "export const app = schema({ tables: [users] });",
    "",
  ].join("\n");
}

function uuidv7Schema(): string {
  return [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'const users = table("users", { id: t.id({ default: "uuidv7" }), name: t.text() });',
    "export const app = schema({ tables: [users] });",
    "",
  ].join("\n");
}

function vectorSchema(): string {
  return [
    `import { extension } from ${JSON.stringify(join(root, "src/dialects/pg/ext/index.ts"))};`,
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'const users = table("users", { id: t.id() });',
    'export const app = schema({ tables: [users], extensions: [extension("vector")] });',
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

function plainPlusTrigramSchema(): string {
  return [
    `import { pgTrgm } from ${JSON.stringify(join(root, "src/dialects/pg/ext/pg-trgm.ts"))};`,
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    "const trgm = pgTrgm();",
    'const users = table("users", { id: t.id(), name: t.text() });',
    'const docs = table("docs", { id: t.id(), body: t.text() }, { indexes: (c) => [trgm.gin(c.body.name)] });',
    "export const app = schema({ tables: [users, docs], extensions: [trgm] });",
    "",
  ].join("\n");
}
