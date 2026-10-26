/**
 * N-149: `okm import drizzle` keeps drizzle-kit 0.31's default index names.
 *
 * An unnamed index is `{table}_{columns}_index` in the kit's SQL. The
 * imported file names that index, and the first push does not rename it
 * to `{table}_{columns}_idx`.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { importDrizzle } from "../src/tooling/migrate/import-drizzle.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "import drizzle keeps drizzle-kit 0.31 index names and push does not rename them",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-drizzle-index-"));
    try {
      writeFileSync(
        join(cwd, "package.json"),
        `${JSON.stringify({ name: "fixture", type: "module" })}\n`,
      );
      spawn(cwd, ["bun", "add", "drizzle-orm@0.45.4", "drizzle-kit@0.31.4"]);
      writeFileSync(
        join(cwd, "drizzle.config.ts"),
        `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle-schema.ts",
  out: "./drizzle",
});
`,
      );
      writeFileSync(
        join(cwd, "drizzle-schema.ts"),
        `import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  id: integer("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
}, (table) => [
  index().on(table.email),
  index().on(table.email, table.name),
]);
`,
      );
      spawn(cwd, ["bunx", "drizzle-kit", "generate", "--name", "init"]);
      const kitSql = readFileSync(generatedSql(cwd), "utf8");
      const kitNames = indexNames(kitSql);
      expect(kitNames).toContain("users_email_index");
      expect(kitNames).toContain("users_email_name_index");
      const sql = openPostgres(database.url);
      try {
        for (const statement of kitSql.split("--> statement-breakpoint")) {
          const text = statement.trim();
          if (text.length === 0) continue;
          await sql.unsafe(text);
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
      await importDrizzle(cwd, ["drizzle-schema.ts", "--out", "adopted"]);
      const table = readFileSync(join(cwd, "adopted/tables/users.ts"), "utf8");
      expect(table).toContain('.name("users_email_index")');
      expect(table).toContain('.name("users_email_name_index")');
      expect(table).not.toContain("users_email_idx");
      rewriteImports(join(cwd, "adopted"));
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        [
          `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
          "export default defineConfig({",
          '  schema: "./adopted/schema.ts",',
          '  tables: "./adopted/tables",',
          '  migrations: "./migrations",',
          `  database: ${JSON.stringify(database.url)},`,
          "});",
          "",
        ].join("\n"),
      );
      const pushed = await cli(cwd, ["push"]);
      expect(pushed.toLowerCase()).not.toContain("rename");
      expect(pushed).not.toContain("users_email_idx");
      const live = await query(
        database.url,
        `select indexname from pg_indexes
          where schemaname = 'public' and tablename = 'users' and indexname like '%index'
          order by indexname`,
      );
      expect(live.map((row) => row["indexname"])).toEqual([
        "users_email_index",
        "users_email_name_index",
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function spawn(cwd: string, cmd: readonly string[]): void {
  const ran = Bun.spawnSync({ cmd: [...cmd], cwd, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) {
    throw new Error(`${ran.stdout.toString()}\n${ran.stderr.toString()}`);
  }
}

function generatedSql(cwd: string): string {
  const directory = join(cwd, "drizzle");
  const file = readdirSync(directory).find((name) => name.endsWith(".sql"));
  if (file === undefined) throw new Error("drizzle-kit wrote no SQL");
  return join(directory, file);
}

function indexNames(sql: string): string[] {
  return [...sql.matchAll(/create index (?:"([^"]+)"|([A-Za-z_][\w$]*))/gi)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
}

function rewriteImports(directory: string): void {
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) {
      rewriteImports(path);
      continue;
    }
    if (!name.name.endsWith(".ts")) continue;
    let spec = relative(dirname(path), join(root, "src/dialects/pg/index.ts")).replaceAll(
      "\\",
      "/",
    );
    if (!spec.startsWith(".")) spec = `./${spec}`;
    const text = readFileSync(path, "utf8").replaceAll(
      'from "okmodel/pg"',
      `from ${JSON.stringify(spec)}`,
    );
    writeFileSync(path, text);
  }
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

async function query(url: string, statement: string): Promise<Record<string, string>[]> {
  const sql = openPostgres(url);
  try {
    return await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
