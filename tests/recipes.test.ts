/**
 * Production, preview, and rehearsal commands from the docs.
 *
 * A command is run when CI can run it. The others stay in the docs and this
 * file says why they are not run. A new command that is neither run nor
 * explained fails the test.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import {
  command,
  inlineOkmCommands,
  listenPostgres,
  markdownFences,
  pack,
  removeProject,
  shellCommands,
  tempProject,
  type ListeningPostgres,
} from "./doc-run.js";

const SCHEMA = `import { schema, table, t } from "okmodel/pg";

export const notes = table("notes", {
  id: t.uuid(),
  title: t.text(),
});

export const app = schema({ tables: [notes] });
`;

/** Apply lines CI can execute against a local database. */
const RUN = new Set([
  "okm migrate apply --target production",
  "okm migrate apply --target preview",
]);

/**
 * Apply lines CI does not execute, and why.
 *
 * Rehearsal is apply on a clone of production. This job has no production
 * database to clone.
 */
const SKIP = new Map<string, string>([
  [
    "okm migrate apply --target rehearsal",
    "CI has no clone of a production database. Rehearsal is apply on that clone.",
  ],
]);

/**
 * Steps in the recipes that are not `okm` commands, and why CI skips them.
 */
const NOT_COMMANDS = [
  {
    text: "Infrastructure creates it",
    why: "Creating the preview database is infrastructure: a branch, CREATE DATABASE, or a container.",
  },
  {
    text: "Optionally seed, then deploy",
    why: "0.1 has no seed command, and deploying the application is the pipeline.",
  },
  {
    text: "Deleting the database when the pull request closes is the infrastructure's job",
    why: "OKModel never drops a database.",
  },
  {
    text: "clone or branch the production database",
    why: "CI has no production database to clone or branch.",
  },
] as const;

test("recipe commands that can run in CI do, and the rest say why", async () => {
  const root = repoRoot();
  if (!existsSync(join(root, "dist", "okm.js"))) {
    throw new Error("dist/okm.js is missing. bun run build writes it.");
  }
  const production = readFileSync(join(root, "docs/production.md"), "utf8");
  const environments = readFileSync(join(root, "docs/environments.md"), "utf8");
  for (const item of NOT_COMMANDS) {
    expect(environments, item.why).toContain(item.text);
  }

  const commands = [...recipeCommands(production), ...recipeCommands(environments)];
  expect(commands).toContain("okm migrate apply --target production");
  expect(commands).toContain("okm migrate apply --target preview");
  expect(commands).toContain("okm migrate apply --target rehearsal");
  for (const line of commands) {
    if (RUN.has(line) || SKIP.has(line)) continue;
    throw new Error(`docs command is not run and has no reason: ${line}`);
  }
  for (const [line, why] of SKIP) {
    expect(commands, why).toContain(line);
  }

  const tarball = pack(root);
  try {
    await runRecipe(tarball, production, "okm migrate apply --target production");
    await runRecipe(tarball, environments, "okm migrate apply --target preview");
  } finally {
    rmSync(tarball, { force: true });
  }
}, 180_000);

function recipeCommands(markdown: string): readonly string[] {
  const fenced = markdownFences(markdown)
    .filter((fence) => fence.lang === "sh")
    .flatMap((fence) => shellCommands(fence.code));
  return [...fenced, ...inlineOkmCommands(markdown)];
}

/**
 * Real Postgres when this process is the Docker run. The wire server otherwise.
 *
 * @returns A URL and a close function
 */
async function openDatabase(): Promise<ListeningPostgres> {
  if (process.env.REQUIRE_DOCKER === "1") {
    const database = await createIsolatedDatabase();
    return { url: database.url, close: () => database.close() };
  }
  return listenPostgres();
}

async function runRecipe(tarball: string, markdown: string, line: string): Promise<void> {
  const config = markdownFences(markdown).find(
    (fence) => fence.lang === "ts" && fence.code.includes("defineConfig"),
  );
  if (config === undefined) throw new Error(`${line} has no defineConfig in the docs`);
  const envName = /process\.env\.([A-Z0-9_]+)/.exec(config.code)?.[1];
  if (envName === undefined)
    throw new Error(`${line} config does not read an environment variable`);

  const server = await openDatabase();
  const dir = tempProject("okm-recipe-");
  try {
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "okm-recipe", private: true, type: "module" })}\n`,
    );
    writeFileSync(join(dir, "schema.ts"), SCHEMA);
    writeFileSync(join(dir, "okmodel.config.ts"), config.code);
    const env = {
      [envName]: server.url,
      PATH: `${join(dir, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
    };
    await command(dir, ["bun", "add", tarball, "postgres"]);
    await command(dir, ["bunx", "okm", "build"], env);
    await command(dir, ["bunx", "okm", "generate", "init"], env);
    await command(dir, line.split(/\s+/), env);
  } finally {
    removeProject(dir);
    await server.close();
  }
}
