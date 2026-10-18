/**
 * `okm migrate baseline` on an existing database (D299).
 *
 * A database created outside OKModel and pulled can be baselined. Mismatch,
 * unmanaged objects, idempotence, existing history, and protected targets
 * are covered.
 */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { baseline } from "../src/tooling/migrate/baseline.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "baseline records history on a pulled database; generate and check stay clean",
  async () => {
    await withProject(async ({ cwd, url }) => {
      await seed(
        url,
        `create table items (
           id integer primary key,
           title text not null
         )`,
      );
      writeConfig(cwd, { url });
      linkOkmodel(cwd);
      await cli(cwd, ["pull"]);
      await cli(cwd, ["generate", "init"]);
      const text = await cli(cwd, ["migrate", "baseline"]);
      expect(text).toContain("baselined baselined@0001_init");
      expect(await column(url, "select migration_id from okm_history")).toEqual([
        "baselined@0001_init",
      ]);
      expect(await column(url, "select migration_id from okm_meta where id = 'head'")).toEqual([
        "baselined@0001_init",
      ]);
      expect(await cli(cwd, ["generate", "again"])).toBe("no changes\n");
      expect(await cli(cwd, ["migrate", "check"])).toMatch(/^ok 1 migrations\n/);
      const again = await cli(cwd, ["migrate", "baseline"]);
      expect(again).toContain("already baselined baselined@0001_init");
      expect(await column(url, "select count(*)::text from okm_history")).toEqual(["1"]);
    });
  },
  90_000,
);

postgresTest(
  gate,
  "baseline refuses a mismatch and reports unmanaged objects without changing them",
  async () => {
    await withProject(async ({ cwd, url }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), title: t.text() })`);
      await cli(cwd, ["generate", "init"]);
      await seed(
        url,
        `create table items (
           id integer primary key,
           title text not null,
           note text
         )`,
      );
      await seed(url, `create table junk (id integer primary key)`);
      const mismatch = await rejected(["migrate", "baseline"], cwd);
      expect(mismatch.code).toBe("OKM1858");
      expect(mismatch.message).toContain("does not match the model snapshot");
      expect(mismatch.message.toLowerCase()).toMatch(/note|column/);
      expect(await present(url, "okm_meta")).toBe(false);
      expect(await present(url, "public.junk")).toBe(true);

      await seed(url, `alter table items drop column note`);
      const dry = await cli(cwd, ["migrate", "baseline", "--dry-run", "--json"]);
      const parsed = JSON.parse(dry) as {
        status: string;
        unmanaged: { kind: string; name: string }[];
      };
      expect(parsed.status).toBe("dry-run");
      expect(
        parsed.unmanaged.some((item) => item.kind === "table" && item.name.includes("junk")),
      ).toBe(true);
      expect(await present(url, "okm_meta")).toBe(false);

      const text = await cli(cwd, ["migrate", "baseline"]);
      expect(text).toContain("baselined baselined@0001_init");
      expect(text).toContain("unmanaged");
      expect(text).toContain("junk");
      expect(await present(url, "public.junk")).toBe(true);
      expect(await column(url, "select count(*)::text from junk")).toEqual(["0"]);
    });
  },
  90_000,
);

postgresTest(
  gate,
  "baseline refuses existing OKModel history",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "apply"]);
      const history = await rejected(["migrate", "baseline"], cwd);
      expect(history.code).toBe("OKM1857");
      expect(history.message).toContain("already has OKModel history");
      expect(history.fix?.summary).toContain("no OKModel history");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "baseline refuses a protected target without confirmation",
  async () => {
    await withProject(
      async ({ cwd, url }) => {
        writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
        await cli(cwd, ["generate", "init"]);
        await seed(url, `create table items (id integer primary key)`);
        const protectedError = await rejected(["migrate", "baseline"], cwd);
        expect(protectedError.code).toBe("OKM1850");
        expect(protectedError.message).toContain("history-repair");
        const allowed = await cli(cwd, ["migrate", "baseline", "--allow-protected"]);
        expect(allowed).toContain("baselined baselined@0001_init");
        const again = await cli(cwd, ["migrate", "baseline", "--allow-protected"]);
        expect(again).toContain("already baselined baselined@0001_init");
      },
      { protected: true },
    );
  },
  60_000,
);

postgresTest(
  gate,
  "baseline() records history on one configured target",
  async () => {
    await withProject(async ({ cwd, url }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      await seed(url, `create table items (id integer primary key)`);
      const text = await baseline("default", cwd);
      expect(text).toContain("baselined baselined@0001_init");
      expect(await column(url, "select migration_id from okm_history")).toEqual([
        "baselined@0001_init",
      ]);
    });
  },
  60_000,
);

async function column(url: string, statement: string): Promise<string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql.unsafe(statement);
    return rows.map((row) => String(Object.values(row)[0]));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function present(url: string, regclass: string): Promise<boolean> {
  const rows = await column(url, `select to_regclass('${regclass}') is not null`);
  return rows[0] === "true" || rows[0] === "t";
}

async function seed(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function withProject(
  body: (context: { cwd: string; url: string }) => Promise<void>,
  options: { readonly protected?: boolean } = {},
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-baseline-"));
  try {
    writeConfig(cwd, { url: database.url, protected: options.protected === true });
    await body({ cwd, url: database.url });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function linkOkmodel(cwd: string): void {
  const directory = join(cwd, "node_modules");
  mkdirSync(directory, { recursive: true });
  symlinkSync(root, join(directory, "okmodel"));
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

function writeConfig(
  cwd: string,
  options: { readonly url: string; readonly protected?: boolean },
): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const database =
    options.protected === true
      ? `{ url: ${JSON.stringify(options.url)}, protected: true }`
      : JSON.stringify(options.url);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      `  schema: "./schema.ts",`,
      `  tables: "./tables",`,
      `  migrations: "./migrations",`,
      `  database: ${database},`,
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

async function rejected(argv: readonly string[], cwd: string): Promise<OkmError> {
  try {
    await cli(cwd, argv);
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error(`expected ${argv.join(" ")} to fail`);
}
