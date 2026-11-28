/**
 * The watch handbook fence runs on Postgres.
 *
 * The page is the source. This file only applies it and calls the export.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const root = join(import.meta.dir, "..");
const gate = await loadPostgresGate();

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
];

type Example = {
  readonly app?: { readonly catalog: Catalog };
  readonly seen?: (url: string) => Promise<number>;
  readonly indexed?: (url: string) => Promise<number>;
  readonly noted?: (url: string) => Promise<number>;
};

postgresTest(gate, "the watch page reads the inserted row", async () => {
  const page = readFileSync(join(root, "site/content/docs/queries/watch.mdx"), "utf8");
  const example = await load(fence(page, "wake.ts"));
  if (example.app === undefined || example.seen === undefined) {
    throw new Error("wake.ts exports app and seen");
  }
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(example.app.catalog, "public")) {
      await sql.unsafe(statement);
    }
    expect(await example.seen(database.url)).toBe(1);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "the watch page indexes the inserted product", async () => {
  const page = readFileSync(join(root, "site/content/docs/queries/watch.mdx"), "utf8");
  const example = await load(fence(page, "feed.ts"));
  if (example.app === undefined || example.indexed === undefined) {
    throw new Error("feed.ts exports app and indexed");
  }
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(example.app.catalog, "public")) {
      await sql.unsafe(statement);
    }
    expect(await example.indexed(database.url)).toBe(1);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "the watch page commits the feed cursor with the handler", async () => {
  const page = readFileSync(join(root, "site/content/docs/queries/watch.mdx"), "utf8");
  const example = await load(fence(page, "feed-tx.ts"));
  if (example.app === undefined || example.noted === undefined) {
    throw new Error("feed-tx.ts exports app and noted");
  }
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(example.app.catalog, "public")) {
      await sql.unsafe(statement);
    }
    expect(await example.noted(database.url)).toBe(1);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

function fence(text: string, title: string): string {
  const pattern = /```ts[^\n]*?\btitle="([^"]+)"[^\n]*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] === title) return match[2] ?? "";
  }
  throw new Error(`missing ts fence ${title}`);
}

async function load(source: string): Promise<Example> {
  let next = source;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  const file = join(mkdtempSync(join(tmpdir(), "okm-watch-docs-")), "wake.ts");
  writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`);
  return (await import(`${pathToFileURL(file).href}?t=${String(Date.now())}`)) as Example;
}
