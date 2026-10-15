/**
 * The handbook "Create your own" fences apply on a real database.
 *
 * Type-check alone accepted a trigger `when` that names `old` on insert.
 * Postgres rejects that statement. Each `own.ts` and `own-advanced.ts` fence
 * on the four schema pages is planned from an empty catalog and applied.
 * PGlite runs in every `bun test`. It has no contrib extensions, so the
 * extension fences apply only on the topology (`needs: postgres`), together
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
function insertedRow(value: unknown): { readonly title: string; readonly label: string } {
  if (typeof value !== "object" || value === null) throw new Error("insert returned nothing");
  const row = value as Record<string, unknown>;
  if (typeof row.title !== "string" || typeof row.label !== "string") {
    throw new Error(`insert returned ${JSON.stringify(value)}`);
  }
  return { title: row.title, label: row.label };
}
