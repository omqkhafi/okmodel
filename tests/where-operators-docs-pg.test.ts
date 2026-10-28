/**
 * The Where operators fences run on a real Postgres.
 *
 * `where.ts` prints the clauses and the refusal messages.
 * `operators.ts` prints one clause per table row, taken from `sql()`.
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
const page = join(root, "site/content/docs/queries/where-operators.mdx");

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg/pg_trgm", join(root, "src/dialects/pg/ext/pg-trgm.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
  ["okmodel", join(root, "src/contracts/index.ts")],
];

const gate = await loadPostgresGate();

type Fence = { readonly lang: string; readonly title: string; readonly body: string };

type Example = {
  readonly app?: { readonly catalog: Catalog };
  readonly built?: (url: string) => Promise<void>;
  readonly operators?: (url: string) => Promise<void>;
};

postgresTest(
  gate,
  "the where operators page applies its examples and the table SQL",
  async () => {
    const text = readFileSync(page, "utf8");
    expect(fences(text).map((fence) => `${fence.lang}:${fence.title}`)).toEqual([
      "ts:where.ts",
      "text:where.out",
      "ts:operators.ts",
    ]);

    const built = await load("where.ts");
    await apply(built, async (url) => {
      const run = built.built;
      if (run === undefined) throw new Error("where.ts exports no built");
      expect(await capture(() => run(url))).toBe(body(text, "text", "where.out"));
    });

    const listed = await load("operators.ts");
    await apply(listed, async (url) => {
      const run = listed.operators;
      if (run === undefined) throw new Error("operators.ts exports no operators");
      const stdout = await capture(() => run(url));
      const rows = operatorRows(text);
      const logged = records(stdout, "ROW");
      expect(rows.map((row) => row.example).sort()).toEqual([...logged.keys()].sort());
      for (const row of rows) {
        expect(logged.get(row.example), row.example).toBe(row.sql);
      }
      const extra = records(stdout, "EXTRA");
      expect([...extra.keys()].sort()).toEqual(["inList([])", "notIn([])", "or([])"]);
      for (const [example, clause] of extra) {
        expect(text).toContain("`" + example + "` writes `" + clause + "`");
      }
      const params = records(stdout, "PARAM");
      expect([...params.keys()].sort()).toEqual([
        'contains("ship")',
        'endsWith("ship")',
        'startsWith("ship")',
      ]);
      for (const value of params.values()) expect(text).toContain("`" + value + "`");
      const messages = stdout
        .split("\n")
        .filter((line) => line.startsWith("MSG\t"))
        .map((line) => line.slice(4));
      expect(messages).toHaveLength(1);
      expect(text).toContain(messages[0] ?? "");
    });
  },
  60_000,
);

/**
 * Applies one fence's catalog, then runs `body` against that database.
 *
 * @param example - Loaded fence
 * @param use - Uses the database URL
 */
async function apply(example: Example, use: (url: string) => Promise<void>): Promise<void> {
  if (example.app === undefined) throw new Error("the fence exports no app");
  const database = await createIsolatedDatabase();
  const admin = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(example.app.catalog, "public")) {
      await admin.unsafe(statement);
    }
    await use(database.url);
  } finally {
    await admin.end({ timeout: 5 });
    await database.close();
  }
}

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
  if (found === undefined) throw new Error(`where-operators.mdx is missing ${title}`);
  return found.body.endsWith("\n") ? found.body : `${found.body}\n`;
}

/**
 * Operator-table rows. The example and the SQL are the code cells.
 *
 * @param text - Handbook page
 * @returns One entry per body row
 */
function operatorRows(text: string): { example: string; sql: string }[] {
  const rows: { example: string; sql: string }[] = [];
  let active = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("| Operator |")) {
      active = true;
      continue;
    }
    if (!active) continue;
    if (line.startsWith("| ---")) continue;
    if (!line.startsWith("|")) {
      active = false;
      continue;
    }
    const cells = line.split("|").slice(1, -1);
    rows.push({ example: code(cells[3] ?? ""), sql: code(cells[4] ?? "") });
  }
  return rows;
}

/**
 * The text inside one markdown code span.
 *
 * @param cell - A table cell
 * @returns The span with its backticks removed
 */
function code(cell: string): string {
  const trimmed = cell.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) return trimmed.slice(1, -1);
  throw new Error(`expected a code cell: ${trimmed}`);
}

/**
 * Tab-separated records of one kind.
 *
 * @param stdout - Printed lines
 * @param kind - `ROW`, `EXTRA`, or `PARAM`
 * @returns Example to the third field
 */
function records(stdout: string, kind: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${kind}\t`)) continue;
    const parts = line.split("\t");
    const example = parts[1];
    const value = parts[2];
    if (example === undefined || value === undefined) throw new Error(line);
    out.set(example, value);
  }
  return out;
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
  const dir = mkdtempSync(join(tmpdir(), "okm-docs-where-"));
  const file = join(dir, title);
  try {
    writeFileSync(file, next);
    return (await import(`${pathToFileURL(file).href}?where=${title}`)) as Example;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
