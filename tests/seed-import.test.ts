/**
 * `okm seed` import failures name the file and module (not `driver`), and a
 * seed body that throws a driver error still reports `driver`.
 *
 * `bunx okm` loads the seed under Node, so `./x.js` fails when only `x.ts`
 * exists. That case is asserted through `node dist/okm.js`.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { listenPostgres } from "./doc-run.js";

const root = repoRoot();
const gate = await loadPostgresGate();

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
});
const app = schema({ tables: [notes] });

postgresTest(
  gate,
  "okm seed under Node reports invalid when the seed imports ./x.js and only x.ts exists",
  async () => {
    if (!existsSync(join(root, "dist", "okm.js"))) {
      throw new Error("dist/okm.js is missing. bun run build writes it.");
    }
    const database = await createIsolatedDatabase();
    const cwd = writeNodeProject(database.url, {
      seed: [
        'import { value } from "./x.js";',
        "export default async function seed(): Promise<void> {",
        "  void value;",
        "}",
        "",
      ].join("\n"),
      extra: [["x.ts", "export const value = 1;\n"]],
    });
    try {
      await install(database.url);
      const ran = spawnSync("node", [join(root, "dist/okm.js"), "seed", "seed.ts"], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 30_000,
      });
      const text = `${ran.stdout}${ran.stderr}`;
      expect(ran.status, text).not.toBe(0);
      expect(text).toContain("error invalid:");
      expect(text).toContain("seed.ts");
      expect(text).toMatch(/x\.js/);
      expect(text.toLowerCase()).toContain(".ts");
      expect(text).not.toContain("error driver:");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "the seed-tenants handbook fences seed a global tenant and a tenant note",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-seed-tenants-docs-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    const page = await Bun.file(join(root, "site/content/docs/reference/cli/migrate.mdx")).text();
    try {
      writeFence(cwd, "schema-tenants.ts", fence(page, "ts", "schema-tenants.ts"));
      writeFence(cwd, "seed-tenants.ts", fence(page, "ts", "seed-tenants.ts"));
      writeFence(
        cwd,
        "run-seed-tenants.ts",
        [
          'import { open } from "okmodel/pg/postgresjs";',
          'import { testing } from "okmodel/testing";',
          'import { app } from "./schema-tenants.ts";',
          'import seed from "./seed-tenants.ts";',
          "",
          "const url = process.env.DATABASE_URL;",
          'if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");',
          "const harness = await testing(app, { driver: open({ url }) });",
          "try {",
          "  await seed(harness);",
          "  const tenants = await harness.db.tenants.count();",
          "  const notes = await harness.db.for({",
          "    tenantId: (await harness.db.tenants.find({ limit: 1 }))[0]!.id,",
          "  }).notes.count();",
          "  if (tenants !== 1 || notes !== 1) {",
          "    throw new Error(`expected 1 tenant and 1 note, got ${tenants} / ${notes}`);",
          "  }",
          "} finally {",
          "  await harness.close();",
          "}",
          "",
        ].join("\n"),
      );
      spawnOk(cwd, "run-seed-tenants.ts");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

test("okm seed keeps driver when the seed function throws a driver error", async () => {
  const server = await listenPostgres();
  const cwd = writeBunProject(server.url, {
    seed: [
      'import { OkmError } from "okmodel";',
      "export default async function seed(): Promise<void> {",
      '  throw new OkmError("driver", "seed body failed", { kind: "driver" });',
      "}",
      "",
    ]
      .join("\n")
      .replaceAll('from "okmodel"', `from ${JSON.stringify(join(root, "src/contracts/index.ts"))}`),
  });
  try {
    await install(server.url);
    let failure: unknown;
    try {
      await run(["seed", "seed.ts"], { cwd, stdout: () => undefined });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OkmError);
    if (failure instanceof OkmError) {
      expect(failure.code).toBe("driver");
      expect(failure.kind).toBe("driver");
      expect(failure.message).toBe("seed body failed");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await server.close();
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

function writeNodeProject(
  url: string,
  input: { readonly seed: string; readonly extra?: readonly (readonly [string, string])[] },
): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-seed-import-"));
  const pg = JSON.stringify(join(root, "dist/dialects/pg/index.js"));
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { id, schema, table, text } from ${pg};\nexport const app = schema({ tables: [table("notes", { id: id({ default: "none" }), title: text() })] });\n`,
  );
  writeFileSync(join(cwd, "seed.ts"), input.seed.endsWith("\n") ? input.seed : `${input.seed}\n`);
  for (const [name, body] of input.extra ?? []) {
    writeFileSync(join(cwd, name), body.endsWith("\n") ? body : `${body}\n`);
  }
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    `export default { schema: "./schema.ts", database: { url: ${JSON.stringify(url)}, protected: false } };\n`,
  );
  return cwd;
}

function writeBunProject(url: string, input: { readonly seed: string }): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-seed-driver-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { id, schema, table, text } from ${pg};\nexport const app = schema({ tables: [table("notes", { id: id({ default: "none" }), title: text() })] });\n`,
  );
  writeFileSync(join(cwd, "seed.ts"), input.seed.endsWith("\n") ? input.seed : `${input.seed}\n`);
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: { url: ${JSON.stringify(url)}, protected: false },`,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

const fenceImports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/testing", join(root, "src/tooling/testing/index.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
  ["okmodel/tenancy", join(root, "src/runtime/tenancy/index.ts")],
];

function fence(text: string, lang: string, title: string): string {
  const pattern = new RegExp(
    `\`\`\`${lang} title="${title.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\n([\\s\\S]*?)\`\`\``,
  );
  const body = pattern.exec(text)?.[1];
  if (body === undefined) throw new Error(`missing ${lang} fence ${title}`);
  return body;
}

function writeFence(cwd: string, name: string, body: string): void {
  let next = body;
  for (const [specifier, path] of fenceImports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  writeFileSync(join(cwd, name), next.endsWith("\n") ? next : `${next}\n`);
}

function spawnOk(cwd: string, name: string): void {
  const proc = spawnSync("bun", [join(cwd, name)], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  expect(proc.status, `${name}\n${proc.stderr}`).toBe(0);
}
