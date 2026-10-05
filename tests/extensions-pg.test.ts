/**
 * Extension lifecycle on Postgres.
 *
 * Extensions are database-scoped, so each case uses its own database.
 * A server without the contrib package skips that case.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { citext as citextExtension } from "../src/dialects/pg/ext/citext.js";
import { pgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = join(import.meta.dir, "..");

postgresTest(
  gate,
  "citext is created, introspected, and compared case-insensitively",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await available(sql, "citext"))) return;
      const app = schema({
        tables: [table("people", { email: t.citext() })],
        extensions: [citextExtension()],
      });
      const plan = planMigration({ before: catalog([]), after: app.catalog, name: "citext" });
      for (const step of plan.steps) await sql.unsafe(step.sql);
      await sql.unsafe(`insert into people (email) values ('Ada@Example.com')`);
      const found = await sql<
        { email: string }[]
      >`select email from people where email = ${"ada@example.com"}`;
      expect(found).toHaveLength(1);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const extension = live.objects.find((object) => object.kind === "extension");
      expect(extension?.identity).toEqual({ kind: "extension", name: "citext" });
      expect(extension?.definition.schema).toBe("public");
      expect(extension?.definition.version).toBeTypeOf("string");
      const column = live.objects.find(
        (object) => object.kind === "column" && object.identity.name === "email",
      );
      expect(column?.dependencies.some((edge) => edge.target.kind === "extension")).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "pg_trgm similarity operator runs on the declared extension",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await available(sql, "pg_trgm"))) return;
      const trigram = pgTrgm();
      const app = schema({
        tables: [table("notes", { title: t.text() })],
        extensions: [trigram],
      });
      const plan = planMigration({ before: catalog([]), after: app.catalog, name: "trgm" });
      for (const step of plan.steps) await sql.unsafe(step.sql);
      await sql.unsafe(`insert into notes (title) values ('postgresql')`);
      const found = await sql<{ title: string }[]>`
        select title from notes where title operator(public.%) ${"postgre"}
      `;
      expect(found.map((row) => row.title)).toEqual(["postgresql"]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "gin and gist indexes are created, introspected, and do not drift",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await available(sql, "pg_trgm"))) return;
      const trigram = pgTrgm();
      const app = schema({
        tables: [
          table(
            "notes",
            { title: t.text(), body: t.text() },
            {
              indexes: (column) => [trigram.gin(column.title.name), trigram.gist(column.body.name)],
            },
          ),
        ],
        extensions: [trigram],
      });
      const plan = planMigration({ before: catalog([]), after: app.catalog, name: "trgm-idx" });
      const text = plan.steps.map((step) => step.sql).join("\n");
      expect(text).toContain('using gin ("title" gin_trgm_ops)');
      expect(text).toContain('using gist ("body" gist_trgm_ops)');
      for (const step of plan.steps) await sql.unsafe(step.sql);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const gin = live.objects.find(
        (object) => object.kind === "index" && object.definition.expression?.includes("gin"),
      );
      const gist = live.objects.find(
        (object) => object.kind === "index" && object.definition.expression?.includes("gist"),
      );
      expect(gin?.kind === "index" ? gin.definition.expression : undefined).toBe(
        'using gin ("title" gin_trgm_ops)',
      );
      expect(gist?.kind === "index" ? gist.definition.expression : undefined).toBe(
        'using gist ("body" gist_trgm_ops)',
      );
      const again = planMigration({ before: live, after: app.catalog, name: "again" });
      expect(again.steps.map((step) => step.sql)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "okm ext list and check read the connected server",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-ext-"));
    try {
      if (!(await available(sql, "pg_trgm"))) return;
      const trigram = pgTrgm();
      const app = schema({
        tables: [table("notes", { title: t.text() })],
        extensions: [trigram],
      });
      const plan = planMigration({ before: catalog([]), after: app.catalog, name: "trgm" });
      for (const step of plan.steps) await sql.unsafe(step.sql);
      writeProject(cwd, database.url, "pgTrgm()", "schema.ts");
      const listed: string[] = [];
      await run(["ext", "list"], { cwd, stdout: (text) => listed.push(text) });
      const list = listed.join("");
      expect(list).toContain("pg_trgm");
      const installed = list.split("\n").find((line) => line.startsWith("pg_trgm\t"));
      expect(installed?.split("\t")[2]).toBeTypeOf("string");
      expect(installed?.split("\t")[2]?.length).toBeGreaterThan(0);
      const checked: string[] = [];
      await run(["ext", "check"], { cwd, stdout: (text) => checked.push(text) });
      expect(checked.join("")).toContain("pg_trgm\t-\t");
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

postgresTest(
  gate,
  "okm ext check refuses a pin the server does not have",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-ext-pin-"));
    try {
      if (!(await available(sql, "pg_trgm"))) return;
      const app = schema({
        tables: [table("notes", { title: t.text() })],
        extensions: [pgTrgm()],
      });
      const plan = planMigration({ before: catalog([]), after: app.catalog, name: "trgm" });
      for (const step of plan.steps) await sql.unsafe(step.sql);
      writeProject(cwd, database.url, 'pgTrgm({ version: "99.0" })', "schema.ts");
      const error = await failure(() => run(["ext", "check"], { cwd, stdout: () => undefined }));
      expect(error.code).toBe("OKM1812");
      expect(error.message).toContain("99.0");
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

function writeProject(cwd: string, url: string, extensionCall: string, schemaFile: string): void {
  writeFileSync(
    join(cwd, schemaFile),
    [
      `import { schema, t, table } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      `import { pgTrgm } from ${JSON.stringify(join(root, "src/dialects/pg/ext/pg-trgm.ts"))};`,
      "export const app = schema({",
      '  tables: [table("notes", { title: t.text() })],',
      `  extensions: [${extensionCall}],`,
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      `  schema: ${JSON.stringify(`./${schemaFile}`)},`,
      '  migrations: "./migrations",',
      '  out: "./.okm",',
      `  database: { url: ${JSON.stringify(url)} },`,
      "});",
      "",
    ].join("\n"),
  );
}

async function failure(operation: () => Promise<unknown>): Promise<OkmError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected an OkmError");
}

async function available(sql: Sql, name: string): Promise<boolean> {
  const rows = await sql<{ name: string }[]>`
    select name from pg_available_extensions where name = ${name}
  `;
  if (rows.length === 0) {
    console.warn(`${name} is not available on this server; skipping`);
    return false;
  }
  return true;
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
