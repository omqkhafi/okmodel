/**
 * `okm migrate plan` against a reachable Postgres (D194).
 *
 * Estimates come from `pg_class.reltuples`. A missing table is `new table`.
 * `okm generate` writes the same SQL it would write offline.
 */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { aboutRows } from "../src/tooling/migrate/estimate.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "a reachable target prints reltuples, an unanalyzed table, and a new table",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-estimate-pg-"));
    mkdirSync(join(cwd, "migrations"));
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe(
        `create table tasks (
          id bigint generated always as identity primary key,
          title text
        )`,
      );
      await sql`insert into tasks (title) values ('a'), ('b'), ('c')`;
      await sql`update pg_class set reltuples = -1 where relname = 'tasks'`;
      const before = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
      writeFileSync(
        join(cwd, "migrations", "0001_base.catalog.json"),
        serializeCatalog(before.catalog),
      );
      writeProject(
        cwd,
        database.url,
        `table("tasks", { id: identity(), title: text(), note: text().nullable() }), table("notes", { id: identity() })`,
      );
      const unknown = await plan(cwd);
      expect(unknown).toContain("ACCESS EXCLUSIVE on tasks, rows unknown (table not analyzed)");
      expect(unknown).toContain("on notes, new table");
      expect(unknown).not.toContain("safe rewrite applied");

      await sql`analyze tasks`;
      const counted = await sql<{ n: string }[]>`
        select c.reltuples::float8::text as n
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'tasks'
      `;
      const reltuples = Number(counted[0]?.n);
      const analyzed = await plan(cwd);
      expect(analyzed).toContain(`ACCESS EXCLUSIVE on tasks, ${aboutRows(reltuples)}`);
      expect(analyzed).toContain("on notes, new table");

      const indexDir = mkdtempSync(join(tmpdir(), "okm-estimate-index-"));
      try {
        mkdirSync(join(indexDir, "migrations"));
        writeProject(
          indexDir,
          database.url,
          `table("tasks", { id: identity(), title: text() }, { indexes: (columns) => [index(columns.title)] })`,
          true,
        );
        writeFileSync(
          join(indexDir, "migrations", "0001_base.catalog.json"),
          serializeCatalog(before.catalog),
        );
        const rewritten = await plan(indexDir);
        expect(rewritten).toContain("safe rewrite applied");
        expect(rewritten).toContain(`on tasks, ${aboutRows(reltuples)}`);

        const lines: string[] = [];
        await run(["generate", "index"], { cwd: indexDir, stdout: (text) => lines.push(text) });
        const files = readdirSync(join(indexDir, "migrations"));
        const sqlFile = files.find((file) => file.endsWith(".sql"));
        if (sqlFile === undefined) throw new Error("generate wrote no SQL");
        const written = readFileSync(join(indexDir, "migrations", sqlFile), "utf8");
        for (const file of files) {
          const text = readFileSync(join(indexDir, "migrations", file), "utf8");
          expect(text).not.toContain("safe rewrite applied");
          expect(text).not.toContain("rows unknown");
          expect(text).not.toContain("new table");
          expect(text).not.toContain("estimated rows");
          expect(text).not.toContain("reltuples");
        }
        expect(written).toContain("-- lock: SHARE UPDATE EXCLUSIVE");
        expect(written).not.toContain("about");
        expect(lines.join("")).not.toContain("about");
      } finally {
        rmSync(indexDir, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

function writeProject(cwd: string, url: string, tables: string, withIndex = false): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const names = withIndex
    ? "identity, index, schema, table, text"
    : "identity, schema, table, text";
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { ${names} } from ${pg};\nexport const app = schema({ tables: [${tables}] });\n`,
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: { url: ${JSON.stringify(url)}, protected: true },`,
      "});",
      "",
    ].join("\n"),
  );
}

async function plan(cwd: string): Promise<string> {
  const lines: string[] = [];
  await run(["migrate", "plan", "next"], { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}
