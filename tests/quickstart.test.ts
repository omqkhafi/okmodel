/**
 * The quickstart docs are the commands this test runs.
 *
 * A fence that drifts from what the test requires fails here. The project is
 * a fresh install of the packed tarball.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
} from "./doc-run.js";

const FILES = ["okmodel.config.ts", "schema.ts", "run.ts"] as const;

test("quickstart docs run from the packed tarball", async () => {
  const root = repoRoot();
  if (!existsSync(join(root, "dist", "okm.js"))) {
    throw new Error("dist/okm.js is missing. bun run build writes it.");
  }
  const doc = readFileSync(join(root, "docs/quickstart.md"), "utf8");
  const fences = markdownFences(doc);
  const commands = fences
    .filter((fence) => fence.lang === "sh")
    .flatMap((fence) => shellCommands(fence.code));
  expect(commands).toContain("bunx okm build");
  expect(commands).toContain("bunx okm generate init");
  expect(commands).toContain("bunx okm migrate apply");
  const install = commands.find((line) => line.startsWith("bun add "));
  if (install === undefined || !install.split(/\s+/).includes("okmodel")) {
    throw new Error("the quickstart install command does not add okmodel");
  }
  if (commands.some((line) => line.includes(".sql"))) {
    throw new Error("the quickstart applies SQL by hand");
  }

  const files = new Map<string, string>();
  for (const fence of fences) {
    if (fence.lang !== "ts") continue;
    const name = fenceFileName(fence.label);
    if (name === undefined) throw new Error(`a TypeScript fence has no file name: ${fence.label}`);
    files.set(name, fence.code);
  }
  for (const name of FILES) {
    if (!files.has(name)) throw new Error(`quickstart docs do not define ${name}`);
  }

  const server = await listenPostgres();
  const tarball = pack(root);
  const dir = tempProject("okm-quickstart-");
  try {
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "okm-quickstart", private: true, type: "module" })}\n`,
    );
    for (const name of FILES) writeFileSync(join(dir, name), files.get(name) ?? "");
    await command(
      dir,
      install.split(/\s+/).map((part) => (part === "okmodel" ? tarball : part)),
    );
    const env = { DATABASE_URL: server.url };
    for (const line of commands) {
      if (line.startsWith("bun add ")) continue;
      await command(dir, line.split(/\s+/), env);
    }
    await command(dir, ["bun", "run.ts"], env);
  } finally {
    removeProject(dir, tarball);
    await server.close();
  }
}, 180_000);
