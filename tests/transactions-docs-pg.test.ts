/**
 * The Transactions handbook fences run on a real Postgres.
 *
 * Each `ts` fence is imported as written, after its catalog is applied.
 * Each `text` fence is the stdout that fence printed.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import type { Catalog } from "../src/contracts/catalog/types.js";

const root = join(import.meta.dir, "..");
const page = join(root, "site/content/docs/queries/transactions.mdx");

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
];

const gate = await loadPostgresGate();

type Fence = { readonly lang: string; readonly title: string; readonly body: string };

type Example = {
  readonly app?: { readonly catalog: Catalog };
  transfer?(url: string): Promise<void>;
  rollback?(url: string): Promise<void>;
  retry?(url: string): Promise<void>;
};

postgresTest(
  gate,
  "the transactions page applies: transfer, rollback, and a retried serialization failure",
  async () => {
    const text = readFileSync(page, "utf8");
    const found = fences(text);
    const titles = found.map((fence) => `${fence.lang}:${fence.title}`);
    expect(titles).toEqual([
      "ts:transfer.ts",
      "text:transfer.out",
      "ts:rollback.ts",
      "text:rollback.out",
      "ts:retry.ts",
      "text:retry.out",
    ]);
    for (const name of ["transfer", "rollback", "retry"] as const) {
      const database = await createIsolatedDatabase();
      const admin = openPostgres(database.url);
      try {
        const example = await load(`${name}.ts`);
        if (example.app === undefined) throw new Error(`${name}.ts exports no app`);
        for (const statement of renderCatalog(example.app.catalog, "public")) {
          await admin.unsafe(statement);
        }
        const run = example[name];
        if (run === undefined) throw new Error(`${name}.ts exports no ${name}`);
        const actual = await capture(() => run(database.url));
        expect(actual, name).toBe(body(text, "text", `${name}.out`));
      } finally {
        await admin.end({ timeout: 5 });
        await database.close();
      }
    }
  },
  60_000,
);

/**
 * Stdout from `console.log` while `run` is in flight.
 *
 * @param run - The handbook function
 * @returns The printed lines, with a trailing newline
 */
async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const write = console.log;
  console.log = ((...args: readonly unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  }) as typeof console.log;
  try {
    await run();
  } finally {
    console.log = write;
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Every titled fence, in page order.
 *
 * @param text - Handbook page
 * @returns Fences with a title
 */
function fences(text: string): Fence[] {
  const out: Fence[] = [];
  const pattern = /```(\w+) title="([^"]+)"\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    const lang = match[1];
    const title = match[2];
    const body = match[3];
    if (lang === undefined || title === undefined || body === undefined) continue;
    out.push({ lang, title, body });
  }
  return out;
}

/**
 * The body of one titled fence.
 *
 * @param text - Handbook page
 * @param lang - Fence language
 * @param title - Fence title
 * @returns The fence source, with its trailing newline
 */
function body(text: string, lang: string, title: string): string {
  const found = fences(text).find((fence) => fence.lang === lang && fence.title === title);
  if (found === undefined) throw new Error(`transactions.mdx is missing ${title}`);
  return found.body.endsWith("\n") ? found.body : `${found.body}\n`;
}

/**
 * Imports one TypeScript fence with package imports pointed at `src/`.
 *
 * @param title - Fence title
 * @returns The fence module
 */
async function load(title: string): Promise<Example> {
  const source = readFileSync(page, "utf8");
  let next = body(source, "ts", title);
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "okm-docs-tx-"));
  const file = join(dir, title);
  try {
    writeFileSync(file, next);
    return (await import(`${pathToFileURL(file).href}?tx=${title}`)) as Example;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
