/**
 * The quickstart docs and the README are the commands this test runs.
 *
 * A fence that drifts from what the test requires fails here. The project is
 * a fresh install of the packed tarball. npm shows the README, so its fences
 * run too. `REQUIRE_DOCKER=1` runs those paths on the topology and skips the
 * in-process server, which the check job already runs.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { openPostgres } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "../scripts/root.js";
import {
  command,
  fenceFileName,
  listenPostgres,
  markdownFences,
  pack,
  removeProject,
  shellCommands,
  tempProject,
  type MarkdownFence,
} from "./doc-run.js";

const DOCS_FILES = ["okmodel.config.ts", "schema.ts", "run.ts"] as const;
const README_FILES = ["okmodel.config.ts", "schema.ts", "db.ts"] as const;
const UUID_LITERAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const root = repoRoot();
const gate = await loadPostgresGate();
let tarballPath: string | undefined;

afterAll(() => {
  if (tarballPath !== undefined) rmSync(tarballPath, { force: true });
});

if (process.env.REQUIRE_DOCKER !== "1") {
  test("quickstart docs and the readme run from the packed tarball", async () => {
    const tarball = sharedTarball();
    const docs = await listenPostgres();
    try {
      await runDocs(tarball, docs.url);
    } finally {
      await docs.close();
    }
    const push = await listenPostgres();
    const apply = await listenPostgres();
    try {
      await runReadme(tarball, push.url, apply.url);
    } finally {
      await push.close();
      await apply.close();
    }
  }, 360_000);
}

postgresTest(
  gate,
  "quickstart docs and the readme run on postgres",
  async () => {
    const tarball = sharedTarball();
    await withIsolatedDatabases(async (urls) => {
      await runDocs(tarball, urls.docs);
      await runReadme(tarball, urls.push, urls.apply);
    });
  },
  360_000,
);

/**
 * Packs the repository once for every test in this file.
 *
 * @returns Absolute path of the tarball
 */
function sharedTarball(): string {
  if (!existsSync(join(root, "dist", "okm.js"))) {
    throw new Error("dist/okm.js is missing. bun run build writes it.");
  }
  tarballPath ??= pack(root);
  return tarballPath;
}

/**
 * Runs `docs/quickstart.md` against one empty database.
 *
 * @param tarball - Packed package
 * @param url - Postgres URL
 */
async function runDocs(tarball: string, url: string): Promise<void> {
  const path = join(root, "docs/quickstart.md");
  const markdown = readFileSync(path, "utf8");
  expect(markdown).toContain("t.identity()");
  expect(markdown).toContain("PostgreSQL 17");
  expect(markdown).toContain("30 seconds");
  if (UUID_LITERAL.test(markdown)) throw new Error(`${path} hard-codes a UUID`);
  const fences = markdownFences(markdown);
  for (const fence of fences) {
    if (fence.lang === "ts" && fenceFileName(fence.label) === undefined) {
      throw new Error(`${path} has a TypeScript fence with no file name: ${fence.label}`);
    }
  }
  const commands = fences
    .filter((fence) => fence.lang === "sh")
    .flatMap((fence) => shellCommands(fence.code));
  expect(commands).toContain("bunx okm build");
  expect(commands).toContain("bunx okm generate init");
  expect(commands).toContain("bunx okm migrate apply");
  if (commands.some((line) => line.includes(".sql"))) {
    throw new Error(`${path} applies SQL by hand`);
  }
  const files = typescriptFiles(fences, DOCS_FILES, path);
  const installs = commands.filter((line) => line.startsWith("bun add "));
  const rest = commands.filter((line) => !line.startsWith("bun add "));
  await withProject(tarball, files, installs, async (dir) => {
    for (const line of rest) await command(dir, line.split(/\s+/), { DATABASE_URL: url });
    await command(dir, ["bun", "run.ts"], { DATABASE_URL: url });
  });
}

/**
 * Runs the README's push path and its generate-then-apply path on two databases.
 *
 * Push has to run before generate. Generate writes a catalog snapshot, and a
 * later push diffs against that snapshot and applies nothing.
 *
 * @param tarball - Packed package
 * @param pushUrl - Empty database for `okm push`
 * @param applyUrl - Empty database for `okm migrate apply`
 */
async function runReadme(tarball: string, pushUrl: string, applyUrl: string): Promise<void> {
  const path = join(root, "README.md");
  const markdown = readFileSync(path, "utf8");
  expect(markdown).toContain('t.identity({ as: "number" })');
  expect(markdown).toContain("PostgreSQL 15 to 18");
  expect(markdown).toContain("30 seconds");
  expect(markdown).toContain("pick one per database");
  if (markdown.includes("db.connected")) {
    throw new Error("README.md awaits db.connected. Every call already waits for it.");
  }
  const fences = markdownFences(markdown);
  const commands = fences
    .filter((fence) => fence.lang === "sh")
    .flatMap((fence) => shellCommands(fence.code));
  if (commands.some((line) => line.split(/\s+/).includes("build") && line.includes("okm"))) {
    throw new Error("README.md quickstart runs okm build. generate writes .okm.");
  }
  const files = typescriptFiles(fences, README_FILES, path);
  const script = readmeScript(fences);
  files.set("run.ts", script);
  let generated = false;
  const installs: string[] = [];
  const push: string[] = [];
  const migrate: string[] = [];
  for (const line of commands) {
    if (line.startsWith("bun add ")) {
      installs.push(line);
      continue;
    }
    if (line.startsWith("bunx okm push")) {
      if (generated) {
        throw new Error(
          "README.md runs okm generate before okm push, so push would see no changes.",
        );
      }
      push.push(line);
      continue;
    }
    if (line.startsWith("bunx okm generate")) {
      if (line.split(/\s+/).length < 4) {
        throw new Error("README.md runs okm generate without a migration name.");
      }
      generated = true;
      migrate.push(line);
      continue;
    }
    if (line.startsWith("bunx okm migrate apply")) {
      migrate.push(line);
      continue;
    }
    throw new Error(`README.md has a shell command the test does not run: ${line}`);
  }
  if (installs.length === 0) throw new Error("README.md has no install command");
  if (push.length !== 1) throw new Error("README.md must run okm push once");
  if (!migrate.some((line) => line.startsWith("bunx okm generate"))) {
    throw new Error("README.md does not run okm generate");
  }
  if (!migrate.some((line) => line.startsWith("bunx okm migrate apply"))) {
    throw new Error("README.md does not run okm migrate apply");
  }
  await withProject(tarball, files, installs, async (dir) => {
    const checked = await command(dir, ["bunx", "okm", "check"], { DATABASE_URL: pushUrl });
    expect(checked.trim()).toBe("ok");
    for (const line of push) await command(dir, line.split(/\s+/), { DATABASE_URL: pushUrl });
    await command(dir, ["bun", "run.ts"], { DATABASE_URL: pushUrl });
    for (const line of migrate) await command(dir, line.split(/\s+/), { DATABASE_URL: applyUrl });
    await command(dir, ["bun", "run.ts"], { DATABASE_URL: applyUrl });
  });
}

/**
 * Writes the project, installs each `bun add` line, and runs `body`.
 *
 * @param tarball - Packed package, substituted for the `okmodel` argument
 * @param files - Project sources, including `run.ts`
 * @param installs - `bun add` lines
 * @param body - Commands to run after install
 */
async function withProject(
  tarball: string,
  files: Map<string, string>,
  installs: readonly string[],
  body: (dir: string) => Promise<void>,
): Promise<void> {
  if (!installs.some((line) => line.split(/\s+/).includes("okmodel"))) {
    throw new Error("install command does not add okmodel");
  }
  if (installs.some((line) => line.includes(".sql"))) {
    throw new Error("a quickstart applies SQL by hand");
  }
  const dir = tempProject("okm-quickstart-");
  try {
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "okm-quickstart", private: true, type: "module" })}\n`,
    );
    for (const [name, source] of files) writeFileSync(join(dir, name), source);
    for (const line of installs) {
      await command(
        dir,
        line.split(/\s+/).map((part) => (part === "okmodel" ? tarball : part)),
      );
    }
    await body(dir);
  } finally {
    removeProject(dir);
  }
}

/**
 * File-labeled TypeScript fences.
 *
 * @param fences - Fences in source order
 * @param required - Names the document must define
 * @param path - Document path, for the error
 * @returns Sources keyed by file name
 */
function typescriptFiles(
  fences: readonly MarkdownFence[],
  required: readonly string[],
  path: string,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const fence of fences) {
    if (fence.lang !== "ts") continue;
    const name = fenceFileName(fence.label);
    if (name === undefined) continue;
    files.set(name, fence.code);
  }
  for (const name of required) {
    if (!files.has(name)) throw new Error(`${path} does not define ${name}`);
  }
  return files;
}

/**
 * README usage fences, in order, as one `run.ts`.
 *
 * The loader's first schema export is the default export. `okm check` accepts
 * that module. Ids are identity values the insert returns, and `db.close()`
 * is only the last block.
 *
 * @param fences - README fences
 * @returns The script the test runs
 */
function readmeScript(fences: readonly MarkdownFence[]): string {
  const usage: string[] = [];
  const labeled: string[] = [];
  for (const fence of fences) {
    if (fence.lang !== "ts") continue;
    const name = fenceFileName(fence.label);
    if (name === undefined) usage.push(fence.code);
    else labeled.push(fence.code);
  }
  if (usage.length === 0) throw new Error("README.md has no usage blocks");
  const script = usage.join("\n");
  const sources = [...labeled, script].join("\n");
  if (UUID_LITERAL.test(sources)) throw new Error("README.md hard-codes a UUID");
  if (sources.includes("crypto.randomUUID()")) {
    throw new Error("README.md supplies ids with crypto.randomUUID()");
  }
  if (!sources.includes("t.identity()")) throw new Error("README.md does not use t.identity()");
  if (sources.includes("t.id()")) throw new Error("README.md mentions t.id()");
  if (!sources.includes("t.bigint()")) {
    throw new Error("README.md foreign key is not t.bigint()");
  }
  if (!script.includes('db.authors.insert({ name: "Ada" })')) {
    throw new Error("README.md does not insert an author by name");
  }
  if (!script.includes("include:")) throw new Error("README.md find has no include");
  if (!script.includes("safe(")) throw new Error("README.md does not call safe");
  if (!script.includes("OkmError")) throw new Error("README.md does not use OkmError");
  if (!script.includes("note.id")) throw new Error("README.md does not query note.id");
  if (!sources.includes("export default schema(")) {
    throw new Error("README.md schema is not a default export");
  }
  if (!sources.includes('import schema from "./schema.ts"')) {
    throw new Error("README.md does not import the default schema");
  }
  if (!sources.includes("connect(url, { schema })")) {
    throw new Error("README.md does not pass the default schema to connect");
  }
  const last = usage.at(-1) ?? "";
  if (!last.includes("db.close()")) throw new Error("README.md does not close in the last block");
  if (usage.slice(0, -1).some((block) => block.includes("db.close()"))) {
    throw new Error("README.md closes the client outside the short script");
  }
  return script;
}

/**
 * Creates one empty database per role and drops them afterwards.
 *
 * @param fn - Receives a URL for the docs, push, and apply paths
 * @returns Whatever `fn` returns
 */
async function withIsolatedDatabases(
  fn: (urls: {
    readonly docs: string;
    readonly push: string;
    readonly apply: string;
  }) => Promise<void>,
): Promise<void> {
  const admin = openPostgres();
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const names = {
    docs: `okm_qs_${id}_d`,
    push: `okm_qs_${id}_p`,
    apply: `okm_qs_${id}_a`,
  } as const;
  const created: string[] = [];
  try {
    for (const name of Object.values(names)) {
      await admin.unsafe(`create database ${name}`);
      created.push(name);
    }
    const urlFor = (name: string): string => {
      const url = new URL(primaryUrl());
      url.pathname = `/${name}`;
      return url.href.replace(/\/$/, "");
    };
    await fn({
      docs: urlFor(names.docs),
      push: urlFor(names.push),
      apply: urlFor(names.apply),
    });
  } finally {
    for (const name of created.reverse()) {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
    }
    await admin.end({ timeout: 5 });
  }
}
