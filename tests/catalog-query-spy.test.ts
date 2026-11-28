/**
 * A plain query app does not load the catalog compiler.
 *
 * connect, find, and insert on PGlite. The Node loader records every file.
 * `catalog-compile` is absent, including as text inlined into a loaded file.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";

test("connect, find, and insert never load catalog-compile", () => {
  const root = repoRoot();
  mkdirSync(join(root, ".cache"), { recursive: true });
  const dir = mkdtempSync(join(root, ".cache", "okm-query-spy-"));
  try {
    const app = join(dir, "app.ts");
    writeFileSync(
      app,
      [
        `import { open } from ${JSON.stringify(join(root, "src/adapters/pg/pglite.ts"))};`,
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        `import { connect } from ${JSON.stringify(join(root, "src/runtime/pg/pglite.ts"))};`,
        'const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });',
        "const app = schema({ tables: [notes] });",
        "const pool = await open();",
        'await pool.execute("create table notes (id integer primary key, title text)");',
        "const db = await connect(pool, { schema: app });",
        'await db.notes.insert({ id: 1, title: "a" });',
        "const rows = await db.notes.find({ limit: 5 });",
        'if (rows.length !== 1 || rows[0]?.title !== "a") throw new Error("query failed");',
        "await db.close();",
        "",
      ].join("\n"),
    );
    const out = join(dir, "out");
    const built = spawnSync(
      "bun",
      [
        "build",
        app,
        "--target",
        "node",
        "--outdir",
        out,
        "--splitting",
        "--external",
        "@electric-sql/pglite",
        "--external",
        "postgres",
      ],
      { encoding: "utf8" },
    );
    expect(built.status, built.stderr).toBe(0);
    writeFileSync(join(out, "package.json"), '{ "type": "module" }\n');
    const spy = join(dir, "spy.mjs");
    writeFileSync(
      spy,
      [
        'import { registerHooks } from "node:module";',
        'import { readFileSync } from "node:fs";',
        "const loaded = [];",
        "registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });",
        `await import(${JSON.stringify(join(out, "app.js"))});`,
        "const names = loaded.filter((url) => url.startsWith('file:')).map((url) => decodeURIComponent(new URL(url).pathname));",
        "const compiler = names.filter((file) => file.includes('catalog-compile'));",
        "let inlined = false;",
        "for (const file of names) {",
        "  if (!file.endsWith('.js') || file.includes('node_modules')) continue;",
        "  if (readFileSync(file, 'utf8').includes('function compileCatalog')) inlined = true;",
        "}",
        "process.stdout.write(JSON.stringify({ compiler, inlined }));",
        "",
      ].join("\n"),
    );
    const ran = spawnSync("node", [spy], { encoding: "utf8", cwd: out });
    expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    const report = JSON.parse(ran.stdout) as { compiler: string[]; inlined: boolean };
    expect(report.compiler).toEqual([]);
    expect(report.inlined).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
