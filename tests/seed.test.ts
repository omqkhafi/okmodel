/**
 * `okm seed` on an unprotected target, and the protected-target refusal (D199).
 *
 * Policy runs before the pool opens. `--allow-protected` is the same flag
 * every other write command uses.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { listenPostgres } from "./doc-run.js";

const root = repoRoot();

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
});

const app = schema({ tables: [notes] });

test("okm seed inserts on an unprotected target and prints the counts", async () => {
  const server = await listenPostgres();
  const cwd = writeProject({ url: server.url, protected: false });
  try {
    await install(server.url);
    const lines: string[] = [];
    await run(["seed", "seed.ts"], { cwd, stdout: (text) => lines.push(text) });
    expect(lines.join("")).toBe("target default\nnotes 1\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await server.close();
  }
});

test("okm seed is refused on a protected target until --allow-protected", async () => {
  const blocked = writeProject({ url: "postgres://localhost:9/none", protected: true });
  try {
    let failure: unknown;
    try {
      await run(["seed", "seed.ts"], { cwd: blocked, stdout: () => undefined });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OkmError);
    if (failure instanceof OkmError) expect(failure.code).toBe("OKM1850");
  } finally {
    rmSync(blocked, { recursive: true, force: true });
  }

  const server = await listenPostgres();
  const cwd = writeProject({ url: server.url, protected: true });
  try {
    await install(server.url);
    const lines: string[] = [];
    await run(["seed", "seed.ts", "--allow-protected"], {
      cwd,
      stdout: (text) => lines.push(text),
    });
    expect(lines.join("")).toBe("target default\nnotes 1\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await server.close();
  }
});

test("okm seed asks for --target when several targets are configured", async () => {
  const cwd = writeProject({ url: "postgres://localhost:9/none", protected: false, several: true });
  try {
    let failure: unknown;
    try {
      await run(["seed", "seed.ts"], { cwd, stdout: () => undefined });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OkmError);
    if (failure instanceof OkmError) expect(failure.code).toBe("OKM1853");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function install(url: string): Promise<void> {
  const pool = open({ url, max: 1 });
  try {
    for (const statement of renderCatalog(app.catalog, "public")) {
      if (statement.trim().length === 0) continue;
      await pool.execute(statement);
    }
  } finally {
    await pool.close();
  }
}

function writeProject(input: {
  readonly url: string;
  readonly protected: boolean;
  readonly several?: boolean;
}): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-seed-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { id, schema, table, text } from ${pg};\nexport const app = schema({ tables: [table("notes", { id: id({ default: "none" }), title: text() })] });\n`,
  );
  writeFileSync(
    join(cwd, "seed.ts"),
    [
      "export default async function seed(t: {",
      "  factories(definitions: {",
      "    notes(x: { words(count: number): string }): { title: string };",
      "  }): { notes: { create(): Promise<unknown> } };",
      "}): Promise<void> {",
      "  const factories = t.factories({ notes: (x) => ({ title: x.words(2) }) });",
      "  await factories.notes.create();",
      "}",
      "",
    ].join("\n"),
  );
  const target = input.several
    ? `targets: { alpha: { url: ${JSON.stringify(input.url)} }, beta: { url: ${JSON.stringify(input.url)} } },`
    : `database: { url: ${JSON.stringify(input.url)}, protected: ${input.protected ? "true" : "false"} },`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      target,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}
