/**
 * Adopt flow keeps an index whose name is not `{table}_{columns}_idx` (N-08).
 *
 * `okm pull` writes that name, `generate init` plans it, and `migrate baseline`
 * matches the live catalog. A default name stays a plain `index()` call.
 */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "pull, generate init, and baseline keep a non-default index name",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-adopt-index-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table tasks (
           id integer primary key,
           title text not null
         );
         create index tasks_id_idx on tasks (id);
         create index lookup_title on tasks (title);
         create index open_title on tasks (title) where title <> ''`,
      );
      await cli(cwd, ["pull"]);
      const source = readFileSync(join(cwd, "tables", "tasks.ts"), "utf8");
      expect(source).toContain("index(columns.id)");
      expect(source).not.toContain('.name("tasks_id_idx")');
      expect(source).toContain('index(columns.title).name("lookup_title")');
      expect(source).toContain('sqlName: "open_title"');
      await cli(cwd, ["generate", "init"]);
      const text = await cli(cwd, ["migrate", "baseline"]);
      expect(text).toContain("baselined baselined@0001_init");
      expect(await cli(cwd, ["migrate", "check"])).toMatch(/^ok /);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

async function seed(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function linkOkmodel(cwd: string): void {
  const directory = join(cwd, "node_modules");
  mkdirSync(directory, { recursive: true });
  symlinkSync(root, join(directory, "okmodel"));
}

function writeConfig(cwd: string, url: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      `  schema: "./schema.ts",`,
      `  tables: "./tables",`,
      `  migrations: "./migrations",`,
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  let out = "";
  await run(argv, {
    cwd,
    stdout: (text) => {
      out += text;
    },
  });
  return out;
}
