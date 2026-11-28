/**
 * The pgvector and queues handbook fences run on Postgres.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { registerRawLock } from "../src/dialects/pg/raw-lock.js";
import { ensurePgvector } from "../packages/harness/src/pgvector-install.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { runRawSync } from "../src/tooling/describe/command.js";

const root = join(import.meta.dir, "..");
const gate = await loadPostgresGate();
const vector = ensurePgvector();

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg/pgvector", join(root, "src/dialects/pg/ext/pgvector.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
  ["okmodel/session", join(root, "src/runtime/session/index.ts")],
];

type Example = { readonly app?: { readonly catalog: Catalog } } & Record<string, unknown>;

function rewrite(source: string): string {
  let next = source;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

function body(text: string, title: string): string {
  const pattern = /```ts[^\n]*?\btitle="([^"]+)"[^\n]*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] === title) return match[2] ?? "";
  }
  throw new Error(`missing ts fence ${title}`);
}

async function load(source: string, title: string): Promise<Example> {
  const cwd = mkdtempSync(join(tmpdir(), "okm-pgvector-docs-"));
  const file = join(cwd, title);
  writeFileSync(file, rewrite(source));
  return (await import(`${pathToFileURL(file).href}?t=${String(Date.now())}`)) as Example;
}

async function apply(catalog: Catalog, url: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    for (const statement of renderCatalog(catalog, "public")) await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (!vector.ok) test.skip("the pgvector query example returns the near row", () => {});
else
  postgresTest(
    gate,
    "the pgvector query example returns the near row",
    async () => {
      const page = readFileSync(join(root, "site/content/docs/schema/extensions.mdx"), "utf8");
      const example = await load(body(page, "query.ts"), "query.ts");
      if (example.app === undefined) throw new Error("query.ts exports no app");
      const database = await createIsolatedDatabase(vector.url);
      try {
        await apply(example.app.catalog, database.url);
        const nearest = example.nearest;
        if (typeof nearest !== "function") throw new Error("query.ts exports no nearest");
        const rows = (await nearest(database.url)) as readonly {
          readonly body?: string;
          readonly distance?: number;
        }[];
        expect(rows.map((row) => row.body)).toEqual(["near"]);
        expect(rows[0]?.distance).toBeCloseTo(0, 5);
      } finally {
        await database.close();
      }
    },
    120_000,
  );

if (!vector.ok) test.skip("the queues guide claims, fences, and defaults the clock", () => {});
else
  postgresTest(
    gate,
    "the queues guide claims, fences, and defaults the clock",
    async () => {
      const page = readFileSync(join(root, "site/content/docs/guides/queues-leases.mdx"), "utf8");
      const source = body(page, "jobs.ts");
      const database = await createIsolatedDatabase(vector.url);
      const cwd = mkdtempSync(join(tmpdir(), "okm-queue-"));
      try {
        const schemaFile = join(cwd, "schema.ts");
        writeFileSync(schemaFile, rewrite(source));
        mkdirSync(join(cwd, "src"));
        writeFileSync(join(cwd, "src", "jobs.ts"), source.endsWith("\n") ? source : `${source}\n`);
        writeFileSync(
          join(cwd, "okmodel.config.ts"),
          [
            `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
            `export default defineConfig({ schema: "./schema.ts", database: ${JSON.stringify(database.url)} });`,
            "",
          ].join("\n"),
        );
        const example = (await import(
          `${pathToFileURL(schemaFile).href}?t=${String(Date.now())}`
        )) as Example;
        if (example.app === undefined) throw new Error("jobs.ts exports no app");
        await apply(example.app.catalog, database.url);
        await runRawSync(cwd, false, { allowProtected: false, allowPooler: false });
        registerRawLock(JSON.parse(readFileSync(join(cwd, ".okm/raw.lock.json"), "utf8")));
        const claim = example.claim;
        const fenceLiteral = example.fenceLiteral;
        const fenceParams = example.fenceParams;
        if (
          typeof claim !== "function" ||
          typeof fenceLiteral !== "function" ||
          typeof fenceParams !== "function"
        ) {
          throw new Error("jobs.ts is missing claim or fence");
        }
        const sql = openPostgres(database.url);
        try {
          await sql.unsafe("insert into jobs (payload) values ('pack')");
          const leased = await sql<
            { leased: Date | string }[]
          >`select leased_until as leased from jobs`;
          expect(leased[0]?.leased).toBeTruthy();
        } finally {
          await sql.end({ timeout: 5 });
        }
        const claimed = (await claim(database.url, "worker-a")) as
          | { readonly id: number; readonly fence: number }
          | undefined;
        expect(claimed?.fence).toBe(1);
        const again = await claim(database.url, "worker-b");
        expect(again).toBeUndefined();
        const literal = (await fenceLiteral(database.url, claimed?.id, 1)) as readonly {
          readonly fence: number;
        }[];
        expect(literal[0]?.fence).toBe(2);
        const params = (await fenceParams(database.url, claimed?.id, 2, "worker-c")) as readonly {
          readonly fence: number;
        }[];
        expect(params[0]?.fence).toBe(3);
      } finally {
        registerRawLock(undefined);
        rmSync(cwd, { recursive: true, force: true });
        await database.close();
      }
    },
    180_000,
  );
