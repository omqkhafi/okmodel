/**
 * A btree index expression is stored as written. Postgres prints another
 * spelling, and introspection records no key column for a pure expression.
 * `okm check` and `okm migrate check` reprint the expression on a scratch
 * index before they compare, so that spelling is not permanent drift.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "a spaced btree expression passes check and migrate check after apply",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(database.url);
    try {
      await run(["generate", "init"], { cwd, stdout: () => undefined });
      const stored = readFileSync(catalogPath(cwd), "utf8");
      expect(stored).toContain("lower( email )");
      const before = await capture(cwd, ["migrate", "check"]);
      expect(before.startsWith("ok 1 migrations\n")).toBe(true);
      expect(before).not.toContain("OKM1547");
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      const checked = await capture(cwd, ["check"]);
      expect(checked).not.toContain("OKM1520");
      expect(checked.trimEnd().endsWith("ok")).toBe(true);
      const after = await capture(cwd, ["migrate", "check"]);
      expect(after.startsWith("ok 1 migrations\n")).toBe(true);
      expect(after).not.toContain("OKM1547");
      const again = await capture(cwd, ["check"]);
      expect(again.trimEnd().endsWith("ok")).toBe(true);
      expect(readFileSync(catalogPath(cwd), "utf8")).toContain("lower( email )");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

function project(url: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-index-expr-"));
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { buildIndex } from ${source("src/dialects/pg/table.ts")};`,
      "export const app = schema({",
      "  tables: [",
      '    table("people", { id: t.integer().primaryKey(), email: t.text() }, {',
      '      indexes: () => [buildIndex({ columns: ["email"], expression: "lower( email )" })],',
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
  return cwd;
}

function catalogPath(cwd: string): string {
  const name = readdirSync(join(cwd, "migrations"))
    .filter((file) => file.endsWith(".catalog.json"))
    .sort()
    .at(-1);
  if (name === undefined) throw new Error("no catalog");
  return join(cwd, "migrations", name);
}

async function capture(cwd: string, argv: readonly string[]): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}
