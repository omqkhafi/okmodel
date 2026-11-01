/**
 * Get started examples run on a real Postgres.
 *
 * `okm init` does not connect. The test checks the files it writes.
 * Stdout bytes include the package version and file hashes.
 * Push and the client scripts do connect.
 * Each script is the handbook fence. Its stdout is the fence on the page.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
const root = join(import.meta.dir, "..");
const cli = join(root, "src/tooling/cli.ts");
const install = readFileSync(join(root, "site/content/docs/start/installation.mdx"), "utf8");
const first = readFileSync(join(root, "site/content/docs/start/first-schema.mdx"), "utf8");
const structure = readFileSync(join(root, "site/content/docs/start/project-structure.mdx"), "utf8");
const migration = readFileSync(join(root, "site/content/docs/start/first-migration.mdx"), "utf8");

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
  ["okmodel/migrate", join(root, "src/tooling/migrate/index.ts")],
];

const gate = await loadPostgresGate();

test("okm init writes the project-structure file list", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-start-init-"));
  try {
    writeFileSync(
      join(cwd, "package.json"),
      `${JSON.stringify({ name: "notes", private: true }, null, 2)}\n`,
    );
    writeFileSync(join(cwd, "bun.lock"), "");
    const proc = spawnSync("bun", [cli, "init"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(proc.status).toBe(0);
    expect(proc.stderr).toBe("");
    const wrote = treePaths(fence(structure, "text", "init.tree"));
    expect(
      relativeFiles(cwd)
        .filter((file) => file !== "bun.lock")
        .sort(),
    ).toEqual(wrote.sort());
    const next = fence(structure, "text", "init.next");
    expect(proc.stdout.endsWith(next.endsWith("\n") ? next : `${next}\n`)).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Why OKModel names what you get without a version stamp", () => {
  const page = readFileSync(join(root, "site/content/docs/start/why-okmodel.mdx"), "utf8");
  expect(page).toContain("## What you get");
  expect(page).toContain("## What it will not do");
  expect(page).toContain("## Plain facts");
  expect(page).not.toMatch(/As of \d+\.\d+/);
  expect(page).not.toMatch(/\bD\d+\b/);
});

postgresTest(
  gate,
  "the first migration commands match the handbook output",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-start-migrate-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    try {
      writeFence(cwd, "schema.ts", fence(install, "ts", "schema.ts"));
      writeFence(cwd, "db.ts", fence(install, "ts", "db.ts"));
      writeFence(cwd, "okmodel.config.ts", fence(migration, "ts", "okmodel.config.ts"));

      const planned = cliProc(cwd, ["migrate", "plan", "init"]);
      expect(planned.status, planned.stderr).toBe(0);
      expect(planned.stdout).toBe(fence(migration, "text", "plan-init.out"));

      const generated = cliProc(cwd, ["generate", "init"]);
      expect(generated.status, generated.stderr).toBe(0);
      expect(generated.stdout).toBe(`${join(cwd, "migrations", "0001_init.sql")}\n`);
      expect(readFileSync(join(cwd, "migrations", "0001_init.sql"), "utf8")).toBe(
        fence(migration, "sql", "0001_init.sql"),
      );
      expect(readFileSync(join(cwd, ".gitattributes"), "utf8")).toBe(
        "migrations/*.sql text eol=lf\n*.catalog.json text eol=lf\n.okm/** text eol=lf\n",
      );
      expect(statSync(join(cwd, ".okm", "catalog.json")).isFile()).toBe(true);
      expect(statSync(join(cwd, ".okm", "catalog.hash")).isFile()).toBe(true);
      expect(statSync(join(cwd, ".okm", "types.d.ts")).isFile()).toBe(true);

      const again = cliProc(cwd, ["migrate", "plan", "init"]);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toBe(fence(migration, "text", "plan-init-again.out"));

      const applied = cliProc(cwd, ["migrate", "apply"]);
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toBe(fence(migration, "text", "apply-init.out"));

      const checked = cliProc(cwd, ["check"]);
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout).toBe(fence(migration, "text", "check.out"));

      const inserted = spawnOk(cwd, "insert.ts", fence(migration, "ts", "insert.ts"));
      expect(inserted.stdout).toBe(fence(migration, "text", "insert.out"));

      writeFence(cwd, "schema.ts", fence(migration, "ts", "schema-required.ts"));
      const rejected = cliProc(cwd, ["migrate", "plan", "add-body"]);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe(fence(migration, "text", "plan-body.out"));
      expect(withoutConfig(rejected.stderr)).toBe(fence(migration, "text", "lint.err"));
      const checkedRejected = cliProc(cwd, ["check"]);
      expect(checkedRejected.status).toBe(1);
      expect(withoutConfig(checkedRejected.stderr)).toBe(fence(migration, "text", "lint.err"));
      const generatedBad = cliProc(cwd, ["generate", "add-body"]);
      expect(generatedBad.status).toBe(1);
      expect(generatedBad.stdout).toBe(`${join(cwd, "migrations", "0002_add-body.sql")}\n`);
      expect(generatedBad.stderr).toContain("okm migrate apply will refuse until it is fixed.");
      rmSync(join(cwd, "migrations", "0002_add-body.sql"));
      rmSync(join(cwd, "migrations", "0002_add-body.catalog.json"));

      writeFence(cwd, "schema.ts", fence(migration, "ts", "schema.ts"));
      const accepted = cliProc(cwd, ["migrate", "plan", "add-body"]);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toBe(fence(migration, "text", "plan-body-ok.out"));

      const added = cliProc(cwd, ["generate", "add-body"]);
      expect(added.status, added.stderr).toBe(0);
      expect(added.stdout).toBe(`${join(cwd, "migrations", "0002_add-body.sql")}\n`);
      expect(readFileSync(join(cwd, "migrations", "0002_add-body.sql"), "utf8")).toBe(
        fence(migration, "sql", "0002_add-body.sql"),
      );

      const appliedBody = cliProc(cwd, ["migrate", "apply"]);
      expect(appliedBody.status, appliedBody.stderr).toBe(0);
      expect(appliedBody.stdout).toBe(fence(migration, "text", "apply-body.out"));

      const status = cliProc(cwd, ["migrate", "status"]);
      expect(status.status, status.stderr).toBe(0);
      const catalogHash = readFileSync(join(cwd, ".okm", "catalog.hash"), "utf8").trim();
      expect(status.stdout).toBe(
        fence(migration, "text", "status.out").replaceAll("⟨catalog hash⟩", catalogHash),
      );
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "apply after push reports that notes already exists",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-start-push-apply-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    try {
      writeFence(cwd, "schema.ts", fence(install, "ts", "schema.ts"));
      writeFence(cwd, "okmodel.config.ts", fence(first, "ts", "okmodel.config.ts"));
      const pushed = cliProc(cwd, ["push"]);
      expect(pushed.status, pushed.stderr).toBe(0);
      writeFence(cwd, "okmodel.config.ts", fence(migration, "ts", "okmodel.config.ts"));
      const generated = cliProc(cwd, ["generate", "init"]);
      expect(generated.status, generated.stderr).toBe(0);
      const applied = cliProc(cwd, ["migrate", "apply"]);
      expect(applied.status).toBe(1);
      expect(withoutConfig(applied.stderr)).toBe(fence(migration, "text", "apply-after-push.err"));
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "the first-success scripts match the handbook output",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-start-docs-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    try {
      writeFence(cwd, "schema.ts", fence(install, "ts", "schema.ts"));
      writeFence(cwd, "db.ts", fence(install, "ts", "db.ts"));
      writeFence(cwd, "okmodel.config.ts", fence(first, "ts", "okmodel.config.ts"));
      expect(spawnOk(cwd, "schema.ts").stdout).toBe("");
      const check = spawnOk(cwd, "check.ts", fence(install, "ts", "check.ts"));
      expect(check.stdout).toBe(fence(install, "text", "connected.out"));

      const pushed = cliProc(cwd, ["push"]);
      expect(pushed.status).toBe(0);
      expect(pushed.stdout).toBe(fence(first, "text", "push.out"));
      expect(pushed.stderr).toContain("config: ");
      expect(pushed.stderr).toContain("okmodel.config.ts");
      const again = cliProc(cwd, ["push"]);
      expect(again.status).toBe(0);
      expect(again.stdout).toBe(fence(first, "text", "push-again.out"));

      for (const name of [
        "insert",
        "find",
        "one",
        "count",
        "exists",
        "update",
        "delete",
      ] as const) {
        const ran = spawnOk(cwd, `${name}.ts`, fence(first, "ts", `${name}.ts`));
        expect(ran.stdout, name).toBe(fence(first, "text", `${name}.out`));
      }

      const missingLimit = spawnFile(
        cwd,
        "find-without-limit.ts",
        fence(first, "ts", "find-without-limit.ts"),
      );
      expect(missingLimit.status).not.toBe(0);
      expect(missingLimit.stderr).toContain("OkmError: find() needs a limit.");
      expect(missingLimit.stderr).toContain('code: "OKM1101"');
      expect(missingLimit.stderr).toContain('summary: "Pass a limit."');

      const missingWhere = spawnFile(
        cwd,
        "update-without-where.ts",
        fence(first, "ts", "update-without-where.ts"),
      );
      expect(missingWhere.status).not.toBe(0);
      expect(missingWhere.stderr).toContain(
        "OkmError: update on notes needs a where. Pass a filter.",
      );
      expect(missingWhere.stderr).toContain('code: "OKM1102"');
      expect(missingWhere.stderr).toContain(
        'summary: "Pass a predicate. An undefined-only where is the same as an empty filter."',
      );
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

/**
 * The last fence with this language and title.
 *
 * @param text - Handbook page
 * @param lang - Fence language
 * @param title - Fence title
 */
/**
 * Stderr without the `config:` line. That line is an absolute path.
 *
 * @param stderr - Command stderr
 */
function withoutConfig(stderr: string): string {
  const text = stderr
    .split("\n")
    .filter((line) => !line.startsWith("config:"))
    .join("\n");
  return text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
}

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
  let next = body;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  writeFileSync(join(cwd, name), next.endsWith("\n") ? next : `${next}\n`);
}

/**
 * Runs one script and requires exit 0.
 *
 * @param cwd - Project directory
 * @param name - File name
 * @param body - Fence to write first, when the file is not already there
 */
function spawnOk(cwd: string, name: string, body?: string): { stdout: string; stderr: string } {
  const ran = spawnFile(cwd, name, body);
  expect(ran.status, `${name}\n${ran.stderr}`).toBe(0);
  return ran;
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
  body?: string,
): { status: number | null; stdout: string; stderr: string } {
  if (body !== undefined) writeFence(cwd, name, body);
  const proc = spawnSync("bun", [join(cwd, name)], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

/**
 * Runs the local `okm`.
 *
 * @param cwd - Project directory
 * @param argv - Arguments after the program name
 */
/**
 * Files in a directory, relative and using `/`.
 *
 * @param dir - Root to walk
 */
function relativeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      if (statSync(path).isDirectory()) walk(path, relative);
      else out.push(relative);
    }
  };
  walk(dir, "");
  return out;
}

/**
 * File paths in an `init.tree` fence. A deeper next line means a directory.
 *
 * @param text - Tree fence body
 */
function treePaths(text: string): string[] {
  const rows = text
    .split("\n")
    .filter((line) => line.trim() !== "" && line.trim() !== ".")
    .map((line) => {
      const indent = /^(?:│ {3}| {4})*/.exec(line)?.[0].length ?? 0;
      const name = line.replace(/^(?:│ {3}| {4})*[├└]── /, "");
      return { depth: indent / 4, name };
    });
  const files: string[] = [];
  const stack: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    stack.length = row.depth;
    stack[row.depth] = row.name;
    const next = rows[index + 1];
    if (next !== undefined && next.depth > row.depth) continue;
    files.push(stack.join("/"));
  }
  return files;
}

function cliProc(
  cwd: string,
  argv: readonly string[],
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const proc = spawnSync("bun", [cli, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}
