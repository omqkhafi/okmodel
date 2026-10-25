/**
 * A check or picklist is reprinted on a temporary table (N-34).
 *
 * The role does not need CREATE on the schema, and parallel checks do not
 * share a name. A read-only session cannot create that table and is OKM1896.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const ROLE = "okm_n34_check";

postgresTest(
  gate,
  "a picklist check needs no CREATE, parallel runs pass, and a read-only session is OKM1896",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-n34-"));
    const name = databaseName(database.url);
    try {
      await admin.unsafe(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = '${ROLE}') then
            create role ${ROLE} nosuperuser login password 'okm';
          end if;
        end $$
      `);
      await admin.unsafe(`alter role ${ROLE} reset default_transaction_read_only`);
      writeProject(cwd, database.url);
      await run(["generate", "init"], { cwd, stdout: () => undefined });
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      await admin.unsafe(`revoke create on schema public from public`);
      await admin.unsafe(`revoke all on schema public from ${ROLE}`);
      await admin.unsafe(`grant connect, temp on database ${name} to ${ROLE}`);
      await admin.unsafe(`grant usage on schema public to ${ROLE}`);
      await admin.unsafe(`grant select on all tables in schema public to ${ROLE}`);
      const priv = await admin<{ create: boolean; temp: boolean }[]>`
        select has_schema_privilege(${ROLE}, 'public', 'CREATE') as create,
               has_database_privilege(${ROLE}, current_database(), 'TEMP') as temp
      `;
      expect(priv[0]).toEqual({ create: false, temp: true });
      writeProject(cwd, roleUrl(database.url));
      const checked = await Promise.all([capture(cwd, ["check"]), capture(cwd, ["check"])]);
      expect(checked[0]?.trimEnd().endsWith("ok")).toBe(true);
      expect(checked[1]?.trimEnd().endsWith("ok")).toBe(true);
      await admin.unsafe(`alter role ${ROLE} set default_transaction_read_only = on`);
      const error = await refused(cwd, ["check"]);
      expect(error.code).toBe("OKM1896");
      expect(error.message.toLowerCase()).toContain("temporary");
      expect(error.fix?.summary).toContain("TEMP");
      expect(error.fix?.summary).toContain("CREATE");
    } finally {
      await admin
        .unsafe(`alter role ${ROLE} reset default_transaction_read_only`)
        .catch(() => undefined);
      await admin.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
  return name;
}

function roleUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = ROLE;
  url.password = "okm";
  return url.href.replace(/\/$/, "");
}

function writeProject(cwd: string, url: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      "export const app = schema({",
      "  tables: [",
      '    table("items", {',
      "      id: t.integer().primaryKey(),",
      '      status: t.text().picklist(["open", "closed"]),',
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
}

async function capture(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await spawn(cwd, argv);
  if (result.code !== 0) throw new Error(result.stderr.length > 0 ? result.stderr : result.stdout);
  return result.stdout;
}

async function refused(cwd: string, argv: readonly string[]): Promise<OkmError> {
  const result = await spawn(cwd, argv);
  if (result.code === 0) throw new Error(`${argv.join(" ")} should have failed`);
  const match = /error (OKM\d+): ([^\n]*)\n([^\n]*)/.exec(`${result.stderr}\n${result.stdout}`);
  if (match === null) throw new Error(result.stderr.length > 0 ? result.stderr : result.stdout);
  return new OkmError(match[1] ?? "invalid", match[2] ?? "", {
    fix: { summary: match[3] ?? "" },
  });
}

async function spawn(
  cwd: string,
  argv: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(lines.join(''));",
    "} catch (error) {",
    "  process.stdout.write(lines.join(''));",
    "  process.stderr.write(error instanceof OkmError ? `error ${error.code}: ${error.message}\\n${error.fix.summary}\\n` : String(error));",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}
