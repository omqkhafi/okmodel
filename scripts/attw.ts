import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

/**
 * Packs with `bun pm pack` and runs arethetypeswrong.
 *
 * The profile is `esm-only` (see `.attw.json`). `attw --pack` shells out to
 * npm, so the tarball is produced with bun instead.
 */
const root = repoRoot();
const before = new Set(readdirSync(root).filter((name) => name.endsWith(".tgz")));
const pack = Bun.spawn(["bun", "pm", "pack"], {
  cwd: root,
  stdout: "pipe",
  stderr: "inherit",
});
const stdout = await new Response(pack.stdout).text();
const packCode = await pack.exited;
if (packCode !== 0) {
  process.exit(packCode);
}

const printed = stdout
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".tgz"))
  .at(-1);
const created = readdirSync(root).find((name) => name.endsWith(".tgz") && !before.has(name));
const name = printed ?? created;
if (name === undefined) {
  console.error("attw: bun pm pack did not write a tarball");
  process.exit(1);
}

const tarball = join(root, name);
let code = 1;
try {
  const attw = Bun.spawn(["bunx", "attw", tarball, "--profile", "esm-only"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  code = await attw.exited;
} finally {
  rmSync(tarball, { force: true });
}
process.exit(code);
