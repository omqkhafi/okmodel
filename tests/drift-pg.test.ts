/**
 * Push, then check, reports no drift for primary keys.
 *
 * Introspection used to store the column list as the primary-key name key
 * (`id`, `left_right`) while the schema stores `pkey`. A named constraint
 * also has to come back as the name the schema wrote.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { projectHead } from "../src/tooling/migrate/project.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "provision then okm check plans nothing for a reprinted string default",
  // The timestamp literal uses the space spelling Postgres stores. The ISO `T`
  // form reprints as a space, which is a different expression and still plans.
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = defaultsProject(repoRoot(), database.url);
    const sql = openPostgres(database.url);
    try {
      await run(["generate", "init"], { cwd, stdout: () => undefined });
      const applied: string[] = [];
      await run(["migrate", "apply"], { cwd, stdout: (text) => applied.push(text) });
      expect(applied.join("")).toContain("provisioned@");
      const head = await projectHead(cwd);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      expect(planMigration({ before: live, after: head.catalog, name: "check" }).steps).toEqual([]);
      expect(planMigration({ before: head.catalog, after: live, name: "forward" }).steps).toEqual(
        [],
      );
      const checked: string[] = [];
      await run(["check"], { cwd, stdout: (text) => checked.push(text) });
      expect(checked.join("")).not.toContain("OKM1520");
      expect(checked.join("").trimEnd().endsWith("ok")).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "push then okm check reports no drift for a plain, composite, and named primary key",
  async () => {
    const database = await createIsolatedDatabase();
    const root = repoRoot();
    const cwd = project(root, database.url);
    const sql = openPostgres(database.url);
    try {
      const pushed: string[] = [];
      await run(["push"], { cwd, stdout: (text) => pushed.push(text) });
      expect(pushed.join("")).toContain("applied");

      const head = await projectHead(cwd);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const back = planMigration({ before: live, after: head.catalog, name: "check" }).steps.map(
        (step) => step.sql,
      );
      const forward = planMigration({
        before: head.catalog,
        after: live,
        name: "forward",
      }).steps.map((step) => step.sql);
      expect(back).toEqual([]);
      expect(forward).toEqual([]);

      const checked: string[] = [];
      await run(["check"], { cwd, stdout: (text) => checked.push(text) });
      expect(checked.join("")).toBe("ok\n");

      const names = await sql<{ name: string }[]>`
        select con.conname as name
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        where con.contype = 'p' and rel.relname = 'named'
      `;
      expect(names.map((row) => row.name)).toEqual(["named_sku_pk"]);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

function project(root: string, url: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-drift-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const build = JSON.stringify(join(root, "src/contracts/catalog/build.ts"));
  const identity = JSON.stringify(join(root, "src/contracts/catalog/identity.ts"));
  const object = JSON.stringify(join(root, "src/contracts/catalog/object.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { catalog } from ${build};`,
      `import { staticNamespace } from ${identity};`,
      `import { constraint } from ${object};`,
      `import { schema, table, t } from ${pg};`,
      "const base = schema({",
      "  tables: [",
      '    table("plain", { id: t.integer().primaryKey() }),',
      '    table("composite", { id: t.integer(), region: t.text() }, { primaryKey: ["id", "region"] }),',
      '    table("named", { sku: t.text() }),',
      "  ],",
      "});",
      'const namespace = staticNamespace("public");',
      "export const app = {",
      "  ...base,",
      "  catalog: catalog([",
      "    ...base.catalog.objects,",
      "    constraint({",
      '      parent: { namespace, name: "named" },',
      '      constraintKind: "primaryKey",',
      '      columns: ["sku"],',
      '      name: "named_sku_pk",',
      '      provenance: { origin: "file", name: "named" },',
      "    }),",
      "  ]),",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

function defaultsProject(root: string, url: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-default-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, table, t } from ${pg};`,
      "export default schema({",
      "  tables: [",
      '    table("notes", {',
      "      id: t.integer().primaryKey(),",
      '      title: t.text().default("x"),',
      '      label: t.varchar(10).default("x"),',
      '      code: t.char(3).default("x"),',
      '      amount: t.numeric(10, 2).default("1.50"),',
      "      at: t.timestamp(3).defaultSql(\"'2020-01-02 03:04:05.006'\"),",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}
