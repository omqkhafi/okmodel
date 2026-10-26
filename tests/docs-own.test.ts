/**
 * The handbook "Create your own" fences apply on a real database.
 *
 * Type-check alone accepted a trigger `when` that names `old` on insert.
 * Postgres rejects that statement. Each `own.ts` and `own-advanced.ts` fence
 * on the four schema pages is planned from an empty catalog and applied.
 * PGlite runs in every `bun test`. It has no contrib extensions, so the
 * extension fences apply only on the topology, together
 * with the other six and the traits `connect` insert.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { run } from "../src/tooling/migrate/commands.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const root = join(import.meta.dir, "..");
const pages = ["extensions", "functions", "triggers", "traits"] as const;

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
  ["okmodel/ext", join(root, "src/dialects/pg/ext/index.ts")],
  ["okmodel/fn", join(root, "src/dialects/pg/fn/index.ts")],
  ["okmodel/traits", join(root, "src/runtime/traits/index.ts")],
];

type OwnModule = {
  readonly default?: unknown;
  readonly app?: unknown;
  readonly add?: (url: string, title: string) => Promise<unknown>;
};

type OwnExample = {
  readonly page: string;
  readonly title: string;
  readonly body: string;
};

const gate = await loadPostgresGate();

test("create your own examples apply on PGlite", async () => {
  const examples = ownExamples().filter((example) => example.page !== "extensions");
  expect(examples).toHaveLength(6);
  for (const example of examples) {
    try {
      const loaded = await loadExample(example);
      const pool = await openPglite();
      try {
        const sql = await applyPlanned(loaded.schema.catalog, async (statement) => {
          await pool.execute(statement);
        });
        assertTriggerWhen(example, sql);
        if (loaded.add !== undefined) {
          const inserted = await pool.execute(
            `insert into "notes" ("title") values ('hello') returning "label"`,
          );
          expect(inserted.rows[0]?.[0]).toBe("note");
        }
      } finally {
        await pool.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${example.page} ${example.title}: ${message}`, { cause: error });
    }
  }
}, 60_000);

postgresTest(
  gate,
  "create your own examples apply on Postgres",
  async () => {
    for (const example of ownExamples()) {
      const loaded = await loadExample(example);
      const database = await createIsolatedDatabase();
      const sql = openPostgres(database.url);
      try {
        if (example.page === "extensions" && example.title === "own-advanced.ts") {
          // The page says to create this schema. Apply does not.
          await sql.unsafe(`create schema "extensions"`);
        }
        const statements = await applyPlanned(loaded.schema.catalog, async (statement) => {
          await sql.unsafe(statement);
        });
        assertTriggerWhen(example, statements);
        if (example.page === "extensions") {
          const live = await introspectSchema(queryOf(sql), "public", "public");
          const back = planMigration({
            before: live,
            after: loaded.schema.catalog,
            name: "again",
          });
          expect(back.steps.map((step) => step.sql)).toEqual([]);
        }
        if (loaded.add !== undefined) {
          const row = insertedRow(await loaded.add(database.url, "hello"));
          expect(row.title).toBe("hello");
          expect(row.label).toBe("note");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${example.page} ${example.title}: ${message}`, { cause: error });
      } finally {
        await sql.end({ timeout: 5 });
        await database.close();
      }
    }
  },
  120_000,
);

postgresTest(
  gate,
  "the extensions schema example passes generate, migrate check, apply, and okm check",
  async () => {
    const body = fence(
      readFileSync(join(root, "site/content/docs/define/schema/extensions.mdx"), "utf8"),
      "schema-name.ts",
    );
    if (body === undefined) throw new Error("extensions.mdx is missing schema-name.ts");
    expect(body).toContain('extension("ltree", { schema: "extensions" })');
    expect(body).toContain("path: t.ltree()");
    await withCliProject(body, async ({ cwd, sql }) => {
      await cli(cwd, ["generate", "init"]);
      expect(await cli(cwd, ["migrate", "check"])).toStartWith("ok 1 migrations\n");
      await cli(cwd, ["migrate", "apply"]);
      expect(await cli(cwd, ["check"])).toContain("ok\n");
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const extension = live.objects.find((object) => object.kind === "extension");
      expect(extension?.identity).toEqual({ kind: "extension", name: "ltree" });
      expect(extension?.definition.schema).toBe("extensions");
      const column = live.objects.find(
        (object) => object.kind === "column" && object.identity.name === "path",
      );
      expect(column?.kind === "column" ? column.definition.dataType : undefined).toBe("ltree");
      expect(
        column?.dependencies.some(
          (edge) => edge.target.kind === "extension" && edge.target.name === "ltree",
        ),
      ).toBe(true);
    });
    await withCliProject(body.replace(', { schema: "extensions" }', ""), async ({ cwd, sql }) => {
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "check"]);
      await cli(cwd, ["migrate", "apply"]);
      expect(await cli(cwd, ["check"])).toContain("ok\n");
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const extension = live.objects.find((object) => object.kind === "extension");
      expect(extension?.definition.schema).toBe("public");
    });
    await withCliProject(trigramSchema(), async ({ cwd, sql }) => {
      await cli(cwd, ["generate", "init"]);
      expect(await cli(cwd, ["migrate", "check"])).toStartWith("ok 1 migrations\n");
      await cli(cwd, ["migrate", "apply"]);
      expect(await cli(cwd, ["check"])).toContain("ok\n");
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const extension = live.objects.find((object) => object.kind === "extension");
      expect(extension?.identity).toEqual({ kind: "extension", name: "pg_trgm" });
      expect(extension?.definition.schema).toBe("extensions");
      const index = live.objects.find((object) => object.kind === "index");
      expect(index?.kind === "index" ? index.definition.expression : undefined).toContain(
        "gin_trgm_ops",
      );
    });
  },
  120_000,
);

/**
 * The eight Create your own fences, in page order.
 *
 * @returns Simple and advanced fences from the four schema pages
 */
function ownExamples(): readonly OwnExample[] {
  const found: OwnExample[] = [];
  for (const page of pages) {
    const text = readFileSync(join(root, "site/content/docs/define/schema", `${page}.mdx`), "utf8");
    for (const title of ["own.ts", "own-advanced.ts"] as const) {
      const body = fence(text, title);
      if (body === undefined) throw new Error(`${page} is missing ${title}`);
      found.push({ page, title, body });
    }
  }
  return found;
}

/**
 * The body of one titled fence.
 *
 * @param text - Handbook page
 * @param title - Fence title, such as `own.ts`
 * @returns The fence body, without the markdown wrapper
 */
function fence(text: string, title: string): string | undefined {
  const pattern = new RegExp(`\`\`\`ts title="${title}"\\n([\\s\\S]*?)\`\`\``);
  return pattern.exec(text)?.[1];
}

/**
 * Writes one fence as a module the test can import.
 *
 * Handbook imports name the package. The test points them at `src/` so it
 * does not need a build.
 *
 * @param example - Fence to load
 * @returns The schema and, for traits simple, the insert function
 */
async function loadExample(example: OwnExample): Promise<{
  readonly schema: { readonly catalog: Catalog };
  readonly add?: OwnModule["add"];
}> {
  const dir = mkdtempSync(join(tmpdir(), "okm-docs-own-"));
  const file = join(dir, "own.ts");
  try {
    writeFileSync(file, rewriteImports(example.body));
    const loaded = (await import(
      `${pathToFileURL(file).href}?own=${example.page}-${example.title}`
    )) as OwnModule;
    const value = loaded.default ?? loaded.app;
    if (!isSchema(value)) throw new Error(`${example.page} ${example.title} exports no schema`);
    return { schema: value, add: loaded.add };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Replaces package imports with the matching source files.
 *
 * @param body - Fence source
 * @returns Source that imports `src/`
 */
function rewriteImports(body: string): string {
  let next = body;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  return next;
}

/**
 * Plans from an empty catalog and runs every statement.
 *
 * @param after - Catalog the fence builds
 * @param execute - Runs one statement
 * @returns The statements, in apply order
 */
async function applyPlanned(
  after: Catalog,
  execute: (statement: string) => Promise<void>,
): Promise<readonly string[]> {
  const plan = planMigration({ before: catalog([]), after, name: "own" });
  expect(plan.steps.length).toBeGreaterThan(0);
  const statements = plan.steps.map((step) => step.sql);
  for (const statement of statements) await execute(statement);
  return statements;
}

/**
 * An insert-or-update trigger must not name `old` in `when`.
 *
 * @param example - Fence that was applied
 * @param statements - Planned SQL
 */
function assertTriggerWhen(example: OwnExample, statements: readonly string[]): void {
  if (example.page !== "triggers" || example.title !== "own-advanced.ts") return;
  const trigger = statements.find((statement) => statement.startsWith("create trigger"));
  expect(trigger).toContain(`before insert or update of "title"`);
  expect(trigger).toContain(`when (new.title <> '')`);
  expect(trigger ?? "").not.toContain("old.");
}

/**
 * @param value - A schema export
 * @returns Whether the value carries a catalog
 */
function isSchema(value: unknown): value is { readonly catalog: Catalog } {
  return (
    typeof value === "object" &&
    value !== null &&
    "catalog" in value &&
    typeof value.catalog === "object" &&
    value.catalog !== null
  );
}

/**
 * @param value - Whatever `add` returned
 * @returns The inserted title and label
 */
function trigramSchema(): string {
  return [
    `import { schema, t, table } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    `import { pgTrgm } from ${JSON.stringify(join(root, "src/dialects/pg/ext/pg-trgm.ts"))};`,
    'const trigram = pgTrgm({ schema: "extensions" });',
    "export default schema({",
    '  tables: [table("docs", { id: t.id(), body: t.text() }, { indexes: (c) => [trigram.gin(c.body.name)] })],',
    "  extensions: [trigram],",
    "});",
    "",
  ].join("\n");
}

async function withCliProject(
  schemaBody: string,
  body: (context: { cwd: string; sql: ReturnType<typeof openPostgres> }) => Promise<void>,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-ext-schema-"));
  const sql = openPostgres(database.url);
  try {
    const ready = await sql<{ ok: boolean }[]>`
      select
        exists (select 1 from pg_available_extensions where name = 'ltree')
        and exists (select 1 from pg_available_extensions where name = 'pg_trgm') as ok
    `;
    if (ready[0]?.ok !== true) throw new Error("ltree and pg_trgm must be available");
    writeFileSync(join(cwd, "schema.ts"), rewriteImports(schemaBody));
    const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${migrate};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        '  migrations: "./migrations",',
        `  database: ${JSON.stringify(database.url)},`,
        "});",
        "",
      ].join("\n"),
    );
    await body({ cwd, sql });
  } finally {
    await sql.end({ timeout: 5 });
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}

function queryOf(sql: ReturnType<typeof openPostgres>): CatalogQuery {
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

function insertedRow(value: unknown): { readonly title: string; readonly label: string } {
  if (typeof value !== "object" || value === null) throw new Error("insert returned nothing");
  const row = value as Record<string, unknown>;
  if (typeof row.title !== "string" || typeof row.label !== "string") {
    throw new Error(`insert returned ${JSON.stringify(value)}`);
  }
  return { title: row.title, label: row.label };
}
