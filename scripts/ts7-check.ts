/**
 * Typechecks the public entry files with the TypeScript 7 native preview.
 *
 * The package is `@typescript/native-preview` (`tsgo`). It is not a
 * dependency. This script is not part of `bun run check` and it is not a
 * required CI status. When the package is not on npm, the script prints
 * why and exits 0. The note lives in `docs/compatibility.md`.
 *
 *   bun ./scripts/ts7-check.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { API_ENTRIES } from "./api-surface.js";
import { repoRoot } from "./root.js";

/**
 * Whether `@typescript/native-preview` can be resolved from the registry.
 *
 * A network failure and a missing package both count as not published for
 * this optional check.
 *
 * @returns The published version, or `undefined` when it cannot be read
 */
export function nativePreviewVersion(): string | undefined {
  const proc = spawnSync("bunx", ["npm", "view", "@typescript/native-preview", "version"], {
    encoding: "utf8",
  });
  if (proc.status !== 0) return undefined;
  const line = proc.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => /^\d+\.\d+\.\d+/.test(entry));
  return line;
}

if (import.meta.main) {
  const version = nativePreviewVersion();
  if (version === undefined) {
    console.log(
      "ts7-check: @typescript/native-preview is not published. See docs/compatibility.md. Skipping.",
    );
    process.exit(0);
  }
  const root = repoRoot();
  const dir = mkdtempSync(join(tmpdir(), "okm-ts7-"));
  const config = join(dir, "tsconfig.json");
  const files = API_ENTRIES.map((entry) => join(root, entry.file));
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2023",
          skipLibCheck: true,
          types: ["bun"],
        },
        files,
      },
      null,
      2,
    )}\n`,
  );
  try {
    const proc = spawnSync(
      "bunx",
      ["--package", `@typescript/native-preview@${version}`, "tsgo", "-p", config],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    if (proc.stdout.length > 0) process.stdout.write(proc.stdout);
    if (proc.stderr.length > 0) process.stderr.write(proc.stderr);
    if (proc.status !== 0) {
      console.error(`ts7-check: tsgo ${version} exited ${String(proc.status)}`);
      process.exit(proc.status ?? 1);
    }
    console.log(`ts7-check: tsgo ${version} accepted the public entries`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
