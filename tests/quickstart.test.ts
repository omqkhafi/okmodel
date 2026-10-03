/**
 * The quickstart docs and the README are the commands this test runs.
 *
 * A fence that drifts from what the test requires fails here. The project is
 * a fresh install of the packed tarball. npm shows the README, so its fences
 * run too.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

type QuickstartDoc = {
  /** Markdown file whose fences are the project. */
  readonly path: string;
  /** The generate line that file must contain. */
  readonly generate: string;
  /** When true, `run.ts` must include, call `safe`, and use `OkmError`. */
  readonly requireHandling?: boolean;
};

test("quickstart docs and the readme run from the packed tarball", async () => {
  const root = repoRoot();
  if (!existsSync(join(root, "dist", "okm.js"))) {
    throw new Error("dist/okm.js is missing. bun run build writes it.");
  }
  const tarball = pack(root);
  try {
    const docs = await listenPostgres();
    try {
      await runQuickstart(tarball, docs.url, {
        path: join(root, "docs/quickstart.md"),
        generate: "bunx okm generate init",
      });
    } finally {
      await docs.close();
    }
    const readme = await listenPostgres();
    try {
      await runQuickstart(tarball, readme.url, {
        path: join(root, "README.md"),
        generate: "bunx okm generate",
        requireHandling: true,
      });
    } finally {
      await readme.close();
    }
  } finally {
    rmSync(tarball, { force: true });
  }
}, 300_000);

async function runQuickstart(tarball: string, url: string, doc: QuickstartDoc): Promise<void> {
  const markdown = readFileSync(doc.path, "utf8");
  const fences = markdownFences(markdown);
  const commands = fences
    .filter((fence) => fence.lang === "sh")
    .flatMap((fence) => shellCommands(fence.code));
  expect(commands).toContain("bunx okm build");
  expect(commands).toContain(doc.generate);
  expect(commands).toContain("bunx okm migrate apply");
  const install = commands.find((line) => line.startsWith("bun add "));
  if (install === undefined || !install.split(/\s+/).includes("okmodel")) {
    throw new Error(`${doc.path} install command does not add okmodel`);
  }
  if (commands.some((line) => line.includes(".sql"))) {
    throw new Error(`${doc.path} applies SQL by hand`);
  }

  const files = new Map<string, string>();
  for (const fence of fences) {
    if (fence.lang !== "ts") continue;
    const name = fenceFileName(fence.label);
    if (name === undefined) throw new Error(`a TypeScript fence has no file name: ${fence.label}`);
    files.set(name, fence.code);
  }
  for (const name of FILES) {
    if (!files.has(name)) throw new Error(`${doc.path} does not define ${name}`);
  }
  if (doc.requireHandling === true) {
    const run = files.get("run.ts") ?? "";
    if (!run.includes("include:")) throw new Error(`${doc.path} find has no include`);
    if (!run.includes("safe(")) throw new Error(`${doc.path} does not call safe`);
    if (!run.includes("OkmError")) throw new Error(`${doc.path} does not use OkmError`);
  }

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
    const env = { DATABASE_URL: url };
    for (const line of commands) {
      if (line.startsWith("bun add ")) continue;
      await command(dir, line.split(/\s+/), env);
    }
    await command(dir, ["bun", "run.ts"], env);
  } finally {
    removeProject(dir);
  }
}
