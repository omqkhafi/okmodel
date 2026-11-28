/**
 * Learning-path, cheat-sheet, and schema examples on a real Postgres.
 *
 * Stdout is the handbook fence. Every complete `schema()` program on a
 * schema page is pushed. A fence without `schema()` stays type-checked by
 * the docs code check. A refusal whose OKM code the page names is a pass.
 * pgvector and pg_cron are skipped when the topology image lacks them, and
 * they run at the release candidate. The gate without Docker skips the file.
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
  "every complete schema program on a schema page pushes",
  async () => {
    const extensions = new Map<string, number>();
    const unexpected: string[] = [];
    const refusals: string[] = [];
    let found = 0;
    let applied = 0;
    let refused = 0;
    for (const file of schemaFiles()) {
      const text = readFileSync(file, "utf8");
      const rel = file.slice(docs.length + 1);
      for (const sample of pushableSchemas(text)) {
        found += 1;
        const outcome = await pushSample(sample.body, text);
        if (outcome.kind === "applied") applied += 1;
        else if (outcome.kind === "refused") {
          refused += 1;
          refusals.push(`${rel} ${sample.title} ${outcome.code}`);
        } else if (outcome.kind === "extension") {
          extensions.set(outcome.name, (extensions.get(outcome.name) ?? 0) + 1);
        } else unexpected.push(`${rel} ${sample.title}: ${outcome.detail}`);
      }
    }
    const skipped =
      [...extensions.entries()].map(([name, count]) => `${name}=${String(count)}`).join(", ") ||
      "none";
    console.log(
      `docs schema examples: found ${String(found)} applied ${String(applied)} refused ${String(refused)} (${refusals.join("; ")}) skipped ${skipped}`,
    );
    expect(unexpected).toEqual([]);
    expect(found).toBeGreaterThan(0);
    expect(applied).toBeGreaterThan(5);
  },
  900_000,
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

type PushOutcome =
  | { readonly kind: "applied" }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "extension"; readonly name: "pgvector" | "pg_cron" }
  | { readonly kind: "error"; readonly detail: string };

/**
 * Pushes one schema fence.
 *
 * @param body - Fence source
 * @param page - Page source, used to tell a documented refusal from a surprise
 * @returns Applied, a documented OKM refusal, a missing extension, or an error
 */
async function pushSample(body: string, page: string): Promise<PushOutcome> {
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
    if (pushed.status === 0) return { kind: "applied" };
    const extension = extensionFrom(pushed.stderr);
    if (extension !== undefined) return { kind: "extension", name: extension };
    const code = /OKM\d{4}/.exec(`${pushed.stderr}\n${pushed.stdout}`)?.[0];
    if (code !== undefined && page.includes(code)) return { kind: "refused", code };
    const detail = (pushed.stderr || pushed.stdout || "push failed").slice(0, 500);
    return {
      kind: "error",
      detail: code === undefined ? detail : `unexpected ${code}: ${detail}`,
    };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

/**
 * An extension the local topology image does not install.
 *
 * pgvector and pg_cron run at the release candidate. Any other failure is
 * not an extension skip.
 *
 * @param stderr - Command stderr
 */
function extensionFrom(stderr: string): "pgvector" | "pg_cron" | undefined {
  if (/vector|pgvector/i.test(stderr)) return "pgvector";
  if (/pg_cron/i.test(stderr)) return "pg_cron";
  return undefined;
}

/**
 * Every fence that is a complete `schema()` program.
 *
 * A fragment that never calls `schema()`, or that imports a sibling file or
 * opens a connection, stays with the typecheck and is not pushed.
 *
 * @param text - Page source
 */
function pushableSchemas(text: string): { title: string; body: string }[] {
  const samples: { title: string; body: string }[] = [];
  for (const match of text.matchAll(/```ts([^\n]*)\n([\s\S]*?)```/g)) {
    const header = match[1] ?? "";
    const body = match[2] ?? "";
    if (!body.includes("schema(")) continue;
    if (body.includes("connect(")) continue;
    if (/from\s+["']\.\.?\/|import\s+["']\.\.?\//.test(body)) continue;
    const title = /title="([^"]+)"/.exec(header)?.[1] ?? "schema.ts";
    samples.push({ title, body });
  }
  return samples;
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
    next = next.replaceAll(`import "${specifier}"`, `import ${JSON.stringify(path)}`);
    next = next.replaceAll(`import '${specifier}'`, `import ${JSON.stringify(path)}`);
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
