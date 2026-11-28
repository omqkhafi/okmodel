/**
 * Learning-path, cheat-sheet, and schema examples on a real Postgres.
 *
 * Stdout is the handbook fence. A fence that needs pgvector, pg_cron, an
 * event trigger, or a role the topology does not provide is skipped here.
 * The gate without Docker skips the file.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";

const root = join(import.meta.dir, "..");
const cli = join(root, "src/tooling/cli.ts");
const docs = join(root, "site/content/docs");
const gate = await loadPostgresGate();

const imports = importMap();

postgresTest(
  gate,
  "the learning path and the cheat sheet match the handbook output",
  async () => {
    const query = readFileSync(join(docs, "start/first-query.mdx"), "utf8");
    await runPush(query, "query.ts", "query.out", "push.out");
    const sheet = readFileSync(join(docs, "start/cheat-sheet.mdx"), "utf8");
    await runPush(sheet, "calls.ts", "calls.out");
    await runProduction(readFileSync(join(docs, "start/production.mdx"), "utf8"));
  },
  90_000,
);

postgresTest(
  gate,
  "one complete schema example from each schema page pushes",
  async () => {
    const skipped: string[] = [];
    let applied = 0;
    for (const file of schemaFiles()) {
      const text = readFileSync(file, "utf8");
      const sample = firstPushable(text);
      if (sample === undefined) continue;
      const reason = await pushSample(sample.body);
      if (reason === undefined) {
        applied += 1;
        continue;
      }
      skipped.push(`${file.slice(docs.length + 1)} ${sample.title}: ${reason}`);
    }
    const unexpected = skipped.filter(
      (line) => !/(pgvector|pg_cron|event-trigger|roles|refusal)$/.test(line),
    );
    expect(unexpected).toEqual([]);
    expect(applied).toBeGreaterThan(5);
  },
  180_000,
);

/**
 * Pushes the page schema, runs the script, and compares both outputs.
 *
 * @param page - Handbook source
 * @param script - Script fence title
 * @param scriptOut - Expected stdout fence title
 * @param pushOut - Expected push stdout fence title, when the page has one
 */
async function runPush(
  page: string,
  script: string,
  scriptOut: string,
  pushOut?: string,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-docs-path-"));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;
  try {
    writeFence(cwd, "schema.ts", fence(page, "ts", "schema.ts"));
    writeFence(cwd, "okmodel.config.ts", fence(page, "ts", "okmodel.config.ts"));
    const pushed = cliProc(cwd, ["push"]);
    expect(pushed.status, pushed.stderr).toBe(0);
    if (pushOut !== undefined) expect(pushed.stdout).toBe(fence(page, "text", pushOut));
    const ran = spawnFile(cwd, script, fence(page, "ts", script));
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe(fence(page, "text", scriptOut));
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

/**
 * Generates the first migration, applies it, and checks the target.
 *
 * @param page - Production page source
 */
async function runProduction(page: string): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-docs-prod-"));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;
  try {
    writeFence(cwd, "schema.ts", fence(page, "ts", "schema.ts"));
    writeFence(cwd, "okmodel.config.ts", fence(page, "ts", "okmodel.config.ts"));
    const generated = cliProc(cwd, ["generate", "init"]);
    expect(generated.status, generated.stderr).toBe(0);
    const applied = cliProc(cwd, ["migrate", "apply"]);
    expect(applied.status, applied.stderr).toBe(0);
    const checked = cliProc(cwd, ["check"]);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toBe(fence(page, "text", "check.out"));
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

/**
 * Pushes one schema fence.
 *
 * @param body - Fence source
 * @returns A feature the topology lacks, or undefined when the push applied
 */
async function pushSample(body: string): Promise<string | undefined> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-docs-schema-"));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;
  try {
    writeFence(cwd, "schema.ts", body);
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      rewrite(`import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./schema.ts",
  database: process.env.DATABASE_URL!,
});
`),
    );
    const pushed = cliProc(cwd, ["push"]);
    if (pushed.status === 0) return undefined;
    const need = needFrom(pushed.stderr, body);
    if (need !== undefined) return need;
    if (/OKM\d+/.test(pushed.stderr)) return "refusal";
    throw new Error(pushed.stderr || pushed.stdout);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

/**
 * Feature a failed push is waiting on.
 *
 * @param stderr - Command stderr
 * @param body - Fence source
 */
function needFrom(stderr: string, body: string): string | undefined {
  if (/vector|pgvector/i.test(stderr)) return "pgvector";
  if (/pg_cron/i.test(stderr)) return "pg_cron";
  if (/event trigger/i.test(stderr) && /42501|permission|OKM2209/i.test(stderr))
    return "event-trigger";
  if (
    /role .+ does not exist/i.test(stderr) ||
    (body.includes("grants:") && /OKM19/.test(stderr))
  ) {
    return "roles";
  }
  return undefined;
}

/**
 * The first fence that is a whole schema and does not import a sibling file.
 *
 * @param text - Page source
 */
function firstPushable(text: string): { title: string; body: string } | undefined {
  for (const match of text.matchAll(/```ts([^\n]*)\n([\s\S]*?)```/g)) {
    const header = match[1] ?? "";
    const body = match[2] ?? "";
    if (!body.includes("export default schema")) continue;
    if (body.includes('from "./') || body.includes("from './") || body.includes("connect("))
      continue;
    const title = /title="([^"]+)"/.exec(header)?.[1] ?? "schema.ts";
    return { title, body };
  }
  return undefined;
}

/**
 * Schema handbook files.
 */
function schemaFiles(): string[] {
  return readdirSync(join(docs, "schema"))
    .filter((name: string) => name.endsWith(".mdx"))
    .map((name: string) => join(docs, "schema", name));
}

/**
 * The last fence with this language and title.
 *
 * @param text - Handbook page
 * @param lang - Fence language
 * @param title - Fence title
 */
function fence(text: string, lang: string, title: string): string {
  const pattern = new RegExp(
    `\`\`\`${lang} title="${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\n([\\s\\S]*?)\`\`\``,
    "g",
  );
  let body: string | undefined;
  for (const match of text.matchAll(pattern)) body = match[1];
  if (body === undefined) throw new Error(`missing ${lang} fence ${title}`);
  return body;
}

/**
 * Writes one rewritten fence.
 *
 * @param cwd - Project directory
 * @param name - File name
 * @param body - Fence source
 */
function writeFence(cwd: string, name: string, body: string): void {
  const next = rewrite(body);
  writeFileSync(join(cwd, name), next.endsWith("\n") ? next : `${next}\n`);
}

/**
 * Points `okmodel/…` imports at this checkout.
 *
 * @param body - Source
 */
function rewrite(body: string): string {
  let next = body;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
    next = next.replaceAll(`from '${specifier}'`, `from ${JSON.stringify(path)}`);
  }
  return next;
}

/**
 * Package export to the TypeScript source it publishes.
 */
function importMap(): readonly (readonly [string, string])[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    exports: Record<string, { import?: string }>;
  };
  const pairs: (readonly [string, string])[] = [];
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (key === "." || value.import === undefined) continue;
    const relative = value.import.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    const specifier = key === "." ? "okmodel" : `okmodel/${key.replace(/^\.\//, "")}`;
    pairs.push([specifier, path]);
  }
  pairs.sort((left, right) => right[0].length - left[0].length);
  return pairs;
}

/**
 * Runs the local `okm`.
 *
 * @param cwd - Project directory
 * @param argv - Arguments after the program name
 */
function cliProc(
  cwd: string,
  argv: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync("bun", [cli, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

/**
 * Runs one script.
 *
 * @param cwd - Project directory
 * @param name - File name
 * @param body - Fence to write first
 */
function spawnFile(
  cwd: string,
  name: string,
  body: string,
): { status: number | null; stdout: string; stderr: string } {
  writeFence(cwd, name, body);
  const proc = spawnSync("bun", [join(cwd, name)], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

test("the import map covers the drivers the examples use", () => {
  expect(imports.some(([specifier]) => specifier === "okmodel/pg")).toBe(true);
  expect(imports.some(([specifier]) => specifier === "okmodel/migrate")).toBe(true);
});
