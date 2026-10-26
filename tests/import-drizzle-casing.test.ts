/**
 * `okm import drizzle` against drizzle-orm 0.45.4 and 1.0.0-rc.5.
 *
 * Each version is installed in a temp project. The repository does not take
 * a dependency on the release candidate.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { importDrizzle } from "../src/tooling/migrate/import-drizzle.js";

const root = repoRoot();

test("drizzle-orm 0.45.4 global casing, a flag, and a disagreement", async () => {
  const cwd = await install("0.45.4");
  try {
    writeFileSync(join(cwd, "drizzle.config.ts"), 'export default { casing: "snake_case" };\n');
    writeFileSync(
      join(cwd, "schema.ts"),
      `import { integer, pgTable, text } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  id: integer().primaryKey(),
  firstName: text().notNull(),
  getURLs: text(),
});
`,
    );
    const imported = await importDrizzle(cwd, ["schema.ts", "--out", "snake"]);
    expect(imported.text).not.toContain("casing was not detected");
    expect(imported.text).toContain("users.get_ur_ls");
    const text = readFileSync(join(cwd, "snake/tables/users.ts"), "utf8");
    expect(text).toContain("firstName: t.text(),");
    expect(text).toContain('getURLs: t.text().sqlName("get_ur_ls").nullable(),');
    expect(readFileSync(join(cwd, "snake/schema.ts"), "utf8")).toContain('casing: "snake"');
    const names = await columnNames(cwd, "snake");
    expect(names).toEqual(["first_name", "get_ur_ls", "id"]);
    rmSync(join(cwd, "drizzle.config.ts"));

    writeFileSync(
      join(cwd, "plain.ts"),
      `import { integer, pgTable, text } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  id: integer().primaryKey(),
  firstName: text(),
});
`,
    );
    const plain = await importDrizzle(cwd, ["plain.ts", "--out", "plain"]);
    expect(plain.text).toContain("keyAsName column users.firstName");
    expect(readFileSync(join(cwd, "plain/schema.ts"), "utf8")).not.toContain("casing:");
    expect(await columnNames(cwd, "plain")).toEqual(["firstName", "id"]);

    const flagged = await importDrizzle(cwd, [
      "schema.ts",
      "--out",
      "camel",
      "--drizzle-casing",
      "camelCase",
    ]);
    expect(flagged.text).not.toContain("keyAsName");
    expect(readFileSync(join(cwd, "camel/schema.ts"), "utf8")).toContain('casing: "camel"');

    writeFileSync(
      join(cwd, "both.ts"),
      `import { integer, pgTable, text } from "drizzle-orm/pg-core";
export const left = { casing: "snake_case" };
export const right = { casing: "camelCase" };
export const users = pgTable("users", {
  id: integer().primaryKey(),
  firstName: text(),
});
`,
    );
    const both = await importDrizzle(cwd, ["both.ts", "--out", "both"]);
    expect(both.text).toContain("more than one casing");
    expect(both.text).toContain("keyAsName column users.firstName");
    expect(readFileSync(join(cwd, "both/schema.ts"), "utf8")).not.toContain("casing:");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

test("drizzle-orm 1.0.0-rc.5 snakeCase builder imports without Relations", async () => {
  const cwd = await install("1.0.0-rc.5");
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      `import { integer, snakeCase, text } from "drizzle-orm/pg-core";
export const users = snakeCase.table("users", {
  id: integer().primaryKey(),
  firstName: text().notNull(),
  getURLs: text(),
  emailAddress: text("email"),
});
`,
    );
    const imported = await importDrizzle(cwd, ["schema.ts", "--out", "adopted"]);
    expect(imported.text).not.toContain("OKM1856");
    expect(imported.text).toContain("users.get_ur_ls");
    expect(imported.text).toContain("users.email");
    const text = readFileSync(join(cwd, "adopted/tables/users.ts"), "utf8");
    expect(text).toContain("firstName: t.text(),");
    expect(text).toContain('getURLs: t.text().sqlName("get_ur_ls").nullable(),');
    expect(text).toContain('emailAddress: t.text().sqlName("email").nullable(),');
    expect(readFileSync(join(cwd, "adopted/schema.ts"), "utf8")).toContain('casing: "snake"');
    expect(await columnNames(cwd, "adopted")).toEqual(["email", "first_name", "get_ur_ls", "id"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

async function install(version: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "okm-drizzle-"));
  writeFileSync(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "fixture", type: "module" })}\n`,
  );
  const ran = Bun.spawnSync({
    cmd: ["bun", "add", `drizzle-orm@${version}`],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ran.exitCode !== 0) {
    throw new Error(`${ran.stdout.toString()}\n${ran.stderr.toString()}`);
  }
  return cwd;
}

async function columnNames(cwd: string, out: string): Promise<string[]> {
  rewriteImports(join(cwd, out));
  const { loadSchema } = await import("../src/tooling/migrate/project.js");
  const built = await loadSchema(cwd, `./${out}/schema.ts`);
  return built.catalog.objects
    .filter((object) => object.kind === "column")
    .map((object) => object.identity.name)
    .sort();
}

function rewriteImports(directory: string): void {
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) {
      rewriteImports(path);
      continue;
    }
    if (!name.name.endsWith(".ts")) continue;
    let spec = relative(dirname(path), join(root, "src/dialects/pg/index.ts")).replaceAll(
      "\\",
      "/",
    );
    if (!spec.startsWith(".")) spec = `./${spec}`;
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll('from "okmodel/pg"', `from ${JSON.stringify(spec)}`),
    );
  }
}
