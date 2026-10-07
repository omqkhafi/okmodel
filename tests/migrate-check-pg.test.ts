/**
 * `okm migrate check` on Postgres: replay, previous catalog, head, and lint.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { CHECK_SCHEMA_PREFIX } from "../src/tooling/migrate/check.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const ARCHIVABLE_UNIQUE = [
  `const projects = table("projects", { id: t.id({ default: "uuidv4" }), slug: t.text().unique() }, { traits: [archivable()] });`,
  "export const app = schema({ tables: [projects] });",
].join("\n");

postgresTest(
  gate,
  "a clean multi-migration history passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), title: t.text() })`);
      await cli(cwd, ["generate", "init"]);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), title: t.text(), note: t.text().nullable() })`,
      );
      await cli(cwd, ["generate", "note"]);
      const text = await capture(["migrate", "check"], cwd);
      expect(text).toBe("ok 2 migrations\n");
      expect(await scratchSchemas(cwd)).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an edited stored catalog fails history verification and names the steps",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), title: t.text() })`);
      await cli(cwd, ["generate", "init"]);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), title: t.text(), extra: t.text().nullable() })`,
      );
      const catalog = await catalogOfSchema(cwd);
      writeFileSync(migrationPath(cwd, ".catalog.json"), catalog);
      const error = await rejected(["migrate", "check"], cwd);
      expect(error.code).toBe("OKM1547");
      expect(error.message).toContain("0001_init");
      expect(error.message).toContain("history differs");
      expect(error.message).toContain("extra");
      expect(await scratchSchemas(cwd)).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "two migrations generated from the same parent fail as a fork",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("posts", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "posts"]);
      const postsSql = readFileSync(migrationPath(cwd, ".sql"), "utf8");
      const postsCatalog = readFileSync(migrationPath(cwd, ".catalog.json"), "utf8");
      const postsSchema = readFileSync(join(cwd, "schema.ts"), "utf8");
      rmSync(join(cwd, "migrations"), { recursive: true, force: true });
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "items"]);
      writeFileSync(join(cwd, "migrations", "0002_posts.sql"), postsSql);
      writeFileSync(join(cwd, "migrations", "0002_posts.catalog.json"), postsCatalog);
      writeFileSync(join(cwd, "schema.ts"), postsSchema);
      const error = await rejected(["migrate", "check"], cwd);
      expect(error.code).toBe("OKM1547");
      expect(error.message).toContain(
        "migration 0002_posts was generated from a different parent than 0001_items",
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a column drop labelled expand fails the previous catalog, and contract passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })`,
      );
      await cli(cwd, ["generate", "init"]);
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "drop"]);
      const sqlPath = join(cwd, "migrations", "0002_drop.sql");
      const original = allowDrop(readFileSync(sqlPath, "utf8"));
      writeFileSync(sqlPath, original.replaceAll("-- class: contract", "-- class: expand"));
      const expand = await rejected(["migrate", "check"], cwd);
      expect(expand.code).toBe("OKM1548");
      expect(expand.message).toContain("0002_drop");
      expect(expand.message).toContain("classified expand");
      writeFileSync(sqlPath, original);
      expect(await capture(["migrate", "check"], cwd)).toBe("ok 2 migrations\n");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a stale head fails and the fix says to run okm generate",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })`,
      );
      const error = await rejected(["migrate", "check"], cwd);
      expect(error.code).toBe("OKM1549");
      expect(error.fix.summary).toContain("okm generate");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an unreasoned drop fails lint, and an override lets it pass",
  async () => {
    await withProject(async ({ cwd }) => {
      await writeDrop(cwd);
      const bare = await rejected(["migrate", "check"], cwd);
      expect(bare.code).toBe("OKM1510");
      expect(bare.message).toContain("OKM1512");
      const sqlPath = join(cwd, "migrations", "0002_drop.sql");
      writeFileSync(sqlPath, allowDrop(readFileSync(sqlPath, "utf8")));
      expect(await capture(["migrate", "check"], cwd)).toBe("ok 2 migrations\n");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "lintFrom skips migrations before that id",
  async () => {
    await withProject(async ({ cwd }) => {
      await writeDrop(cwd);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })`,
      );
      await cli(cwd, ["generate", "restore"]);
      const bare = await rejected(["migrate", "check"], cwd);
      expect(bare.code).toBe("OKM1510");
      writeConfig(cwd, { lintFrom: "0003_restore" });
      expect(await cli(cwd, ["migrate", "check"])).toBe("ok 3 migrations\n");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a protected target is refused, including with --allow-protected",
  async () => {
    await withProject(async ({ cwd, url }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`, { protected: true });
      const refused = await rejected(["migrate", "check"], cwd);
      expect(refused.code).toBe("OKM1850");
      expect(refused.message).toContain("throwaway");
      expect(refused.fix.summary).toContain("throwaway");
      const bypass = await rejected(["migrate", "check", "--allow-protected"], cwd);
      expect(bypass.code).toBe("OKM1850");
      expect(bypass.message).toContain("throwaway");
      const sql = openPostgres(url);
      try {
        const rows = await sql<{ nspname: string }[]>`
        select nspname from pg_namespace where nspname like ${`${CHECK_SCHEMA_PREFIX}%`}
      `;
        expect(rows.map((row) => row.nspname)).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "the clean create-from-empty fixture history passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("tasks", { id: t.identity(), title: t.text() })`);
      await cli(cwd, ["generate", "tasks"]);
      expect(await capture(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a declared view replays and passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(
        cwd,
        [
          `const tasks = table("tasks", { id: t.identity(), status: t.text() });`,
          "export const app = schema({",
          "  tables: [tasks],",
          `  views: [view("open_tasks", { columns: [{ name: "id", type: "bigint" }], query: ${JSON.stringify(" SELECT id\n   FROM tasks\n  WHERE status <> 'done'::text;")} })],`,
          "});",
        ].join("\n"),
      );
      await cli(cwd, ["generate", "init"]);
      expect(await capture(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
      expect(await scratchSchemas(cwd)).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a function that takes a schema enum replays and passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(
        cwd,
        [
          `const tasks = table("tasks", { id: t.identity(), status: t.enum("task_status", ["todo", "done"]) });`,
          `const isOpen = fn("task_is_open", { arguments: [{ name: "status", type: "task_status" }], returns: "boolean", language: "sql", volatility: "immutable", body: "select status <> 'done'::task_status" });`,
          "export const app = schema({ tables: [tasks], functions: [isOpen] });",
        ].join("\n"),
      );
      await cli(cwd, ["generate", "init"]);
      expect(await capture(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a view that calls a declared function passes okm check",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(
        cwd,
        [
          `const tasks = table("tasks", { id: t.identity(), status: t.text() });`,
          `const isOpen = fn("is_open", { arguments: [{ name: "status", type: "text" }], returns: "boolean", language: "sql", volatility: "immutable", body: "select status <> 'done'" });`,
          "export const app = schema({",
          "  tables: [tasks],",
          "  functions: [isOpen],",
          `  views: [view("open_tasks", { columns: [{ name: "id", type: "bigint" }], query: ${JSON.stringify(" SELECT id\n   FROM tasks\n  WHERE is_open(status);")} })],`,
          "});",
        ].join("\n"),
      );
      await cli(cwd, ["generate", "init"]);
      await capture(["migrate", "apply"], cwd);
      expect(await capture(["check"], cwd)).toBe("ok\n");
      expect(await capture(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an archivable table with a unique column has no drift",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(cwd, ARCHIVABLE_UNIQUE);
      await cli(cwd, ["generate", "init"]);
      await capture(["migrate", "apply"], cwd);
      expect(await capture(["check"], cwd)).toBe("ok\n");
      expect(await capture(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an archivable unique index stored with the old predicate is cleared by one migration",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(cwd, ARCHIVABLE_UNIQUE);
      await cli(cwd, ["generate", "init"]);
      const printed = '("archivedAt" IS NULL)';
      const old = '"archivedAt" is null';
      const sqlPath = migrationPath(cwd, ".sql");
      const catalogPath = migrationPath(cwd, ".catalog.json");
      writeFileSync(sqlPath, readFileSync(sqlPath, "utf8").replaceAll(printed, old));
      const json = (text: string): string => JSON.stringify(text).slice(1, -1);
      writeFileSync(
        catalogPath,
        readFileSync(catalogPath, "utf8").replaceAll(json(printed), json(old)),
      );
      await capture(["migrate", "apply"], cwd);

      const pending = await rejected(["check"], cwd);
      expect(pending.code).toBe("OKM1510");
      expect(pending.message).toContain("OKM1529");
      await cli(cwd, ["generate", "archive_predicate"]);
      const upgrade = migrationPath(cwd, ".sql");
      expect(upgrade).toContain("0002_archive_predicate");
      writeFileSync(
        upgrade,
        readFileSync(upgrade, "utf8").replace(
          /^(create unique index concurrently .*)$/m,
          "-- okm-allow OKM1529: rebuilds the same index with the printed predicate\n$1",
        ),
      );
      expect(await capture(["migrate", "apply"], cwd)).toContain("applied 0002_archive_predicate");
      expect(await capture(["check"], cwd)).toBe("ok\n");

      const history = await rejected(["migrate", "check"], cwd);
      expect(history.code).toBe("OKM1547");
      expect(history.message).toContain("0001_init");
    });
  },
  90_000,
);

async function writeDrop(cwd: string): Promise<void> {
  writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })`);
  await cli(cwd, ["generate", "init"]);
  writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
  await cli(cwd, ["generate", "drop"]);
}

function allowDrop(sql: string): string {
  return sql.replace(
    /^(alter table .* drop column .*)$/m,
    "-- okm-allow OKM1512: the column is unused\n$1",
  );
}

function migrationPath(cwd: string, suffix: ".sql" | ".catalog.json"): string {
  const directory = join(cwd, "migrations");
  const name = readdirSync(directory)
    .filter((file) => file.endsWith(suffix))
    .sort()
    .at(-1);
  if (name === undefined) throw new Error(`no ${suffix} in ${directory}`);
  return join(directory, name);
}

async function catalogOfSchema(cwd: string): Promise<string> {
  const imported: unknown = await import(
    `${pathToFileURL(join(cwd, "schema.ts")).href}?edit=${Date.now()}`
  );
  const record = imported as { app?: { catalog?: unknown } };
  const source = record.app?.catalog;
  if (source === undefined) throw new Error("schema.ts must export app");
  return serializeCatalog(source as Parameters<typeof serializeCatalog>[0]);
}

async function scratchSchemas(cwd: string): Promise<readonly string[]> {
  const url = databaseUrl(cwd);
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname like ${`${CHECK_SCHEMA_PREFIX}%`}
    `;
    return rows.map((row) => row.nspname);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function databaseUrl(cwd: string): string {
  const text = readFileSync(join(cwd, "okmodel.config.ts"), "utf8");
  const match = /postgres:\/\/[^"']+/.exec(text);
  if (match === null) throw new Error("config has no database url");
  return match[0];
}

async function withProject(
  body: (context: { cwd: string; url: string }) => Promise<void>,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-check-"));
  try {
    writeConfig(cwd, { url: database.url });
    await body({ cwd, url: database.url });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function writeSchema(
  cwd: string,
  tables: string,
  options?: { readonly protected?: boolean },
): void {
  writeModule(cwd, `export const app = schema({\n  tables: [${tables}],\n});`);
  if (options?.protected === true) writeConfig(cwd, { protected: true });
}

function writeModule(cwd: string, body: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { fn } from ${source("src/dialects/pg/fn/index.ts")};`,
      `import { view } from ${source("src/dialects/pg/view/index.ts")};`,
      `import { archivable } from ${source("src/runtime/traits/index.ts")};`,
      body,
      "",
    ].join("\n"),
  );
}

function writeConfig(
  cwd: string,
  options: { readonly url?: string; readonly protected?: boolean; readonly lintFrom?: string },
): void {
  const url = options.url ?? databaseUrl(cwd);
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const target =
    options.protected === true
      ? `{ url: ${JSON.stringify(url)}, protected: true }`
      : JSON.stringify(url);
  const lint =
    options.lintFrom === undefined ? "" : `  lintFrom: ${JSON.stringify(options.lintFrom)},\n`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${target},`,
      lint.trimEnd(),
      "});",
      "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

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

async function capture(argv: readonly string[], cwd: string): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}

async function rejected(argv: readonly string[], cwd: string): Promise<OkmError> {
  try {
    await run(argv, { cwd, stdout: () => {} });
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error(`${argv.join(" ")} should have failed`);
}
