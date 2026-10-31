/**
 * The tree fences on the search-and-trees page run on Postgres.
 *
 * Each fence passes `limit`. The walk returns the rows that limit allows.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";

const root = join(import.meta.dir, "..");
const page = join(root, "site/content/docs/queries/search-and-trees.mdx");

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
];

const gate = await loadPostgresGate();

type Row = { readonly name: string };

type Example = {
  readonly app: { readonly catalog: Catalog };
  readonly below?: (url: string, id: string) => Promise<readonly Row[]>;
  readonly above?: (url: string, id: string) => Promise<readonly Row[]>;
};

postgresTest(
  gate,
  "descendants.ts and ancestors.ts return the walked rows",
  async () => {
    const text = readFileSync(page, "utf8");
    expect(text).toContain("limit: 20");
    const down = await load("descendants.ts");
    const up = await load("ancestors.ts");
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    try {
      if (down.app === undefined) throw new Error("descendants.ts exports no app");
      for (const statement of renderCatalog(down.app.catalog, "public")) {
        await admin.unsafe(statement);
      }
      const rootId = await insert(admin, null, "root");
      const childId = await insert(admin, rootId, "child");
      const below = down.below;
      const above = up.above;
      if (below === undefined || above === undefined) throw new Error("fence exports no walk");
      expect((await below(database.url, rootId)).map((item) => item.name)).toEqual(["child"]);
      expect((await above(database.url, childId)).map((item) => item.name)).toEqual(["root"]);
    } finally {
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

/**
 * Inserts one node and returns its identity.
 *
 * @param sql - Admin connection
 * @param parent - Parent id, or null for the root
 * @param name - Node name
 * @returns The new id
 */
async function insert(sql: Sql, parent: string | null, name: string): Promise<string> {
  const rows =
    parent === null
      ? await sql<{ id: string }[]>`insert into "nodes" ("name") values (${name}) returning "id"`
      : await sql<{ id: string }[]>`
          insert into "nodes" ("parentId", "name") values (${parent}, ${name}) returning "id"
        `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("insert returned no id");
  return String(id);
}

/**
 * Imports one TypeScript fence with package imports pointed at `src/`.
 *
 * @param title - Fence title
 * @returns The fence module
 */
async function load(title: string): Promise<Example> {
  const source = readFileSync(page, "utf8");
  const fence = source.match(new RegExp(`\`\`\`ts title="${title}"\\n([\\s\\S]*?)\`\`\``));
  const body = fence?.[1];
  if (body === undefined) throw new Error(`search-and-trees.mdx is missing ${title}`);
  let next = body;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  next += "\nexport { app };\n";
  const dir = mkdtempSync(join(tmpdir(), "okm-docs-tree-"));
  const file = join(dir, title);
  try {
    writeFileSync(file, next);
    return (await import(`${pathToFileURL(file).href}?tree=${title}`)) as Example;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
