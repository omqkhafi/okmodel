/**
 * A packed stray file, then a postinstall script, each fail the pack contract.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manifestProblems, packNpmArgs, packedTarballFromJson } from "../scripts/pack-contract.js";

test("a stray packed file, then a postinstall script, fails the pack contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "okm-pack-contract-"));
  const repo = join(import.meta.dir, "..");
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "ok.js"), "export const ok = 1;\n");
    writeManifest(root, {});
    const updated = await run(repo, root, ["--update"]);
    expect(updated.code, updated.stderr).toBe(0);
    const clean = await run(repo, root, []);
    expect(clean.code, clean.stderr).toBe(0);

    writeFileSync(join(root, "src", "leak.test.ts"), "export const leak = 1;\n");
    const stray = await run(repo, root, []);
    expect(stray.code).not.toBe(0);
    expect(stray.stderr).toContain("src/leak.test.ts");
    expect(stray.stderr).not.toContain("--update");

    rmSync(join(root, "src", "leak.test.ts"));
    writeManifest(root, { postinstall: "echo pwned" });
    const hooked = await run(repo, root, []);
    expect(hooked.code).not.toBe(0);
    expect(hooked.stderr).toContain("postinstall");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("optional and bundled dependencies fail, and both npm pack JSON shapes parse", () => {
  expect(packNpmArgs()).toEqual(["bunx", "npm@11.15.0", "pack", "--dry-run", "--json"]);
  const base = { name: "okm-pack-fixture", version: "0.0.0", files: ["src"] };
  expect(manifestProblems({ ...base, optionalDependencies: { leftpad: "1.0.0" } })).toEqual([
    "pack-contract: optionalDependencies is not empty (leftpad)",
  ]);
  expect(manifestProblems({ ...base, optionalDependencies: {} })).toEqual([]);
  expect(manifestProblems({ ...base, bundleDependencies: ["leftpad"] })).toEqual([
    "pack-contract: bundleDependencies is not empty (leftpad)",
  ]);
  expect(manifestProblems({ ...base, bundledDependencies: ["leftpad"] })).toEqual([
    "pack-contract: bundledDependencies is not empty (leftpad)",
  ]);
  expect(manifestProblems({ ...base, bundleDependencies: [] })).toEqual([]);
  const entry = {
    files: [{ path: "package.json" }, { path: "dist/ok.js" }],
    size: 10,
  };
  const packed = { files: ["dist/ok.js", "package.json"], bytes: 10 };
  expect(packedTarballFromJson([entry])).toEqual(packed);
  expect(packedTarballFromJson({ okmodel: entry })).toEqual(packed);
  expect(packedTarballFromJson(entry)).toEqual(packed);
});

test("bin and main are snapshotted and their file contents are not", async () => {
  const root = mkdtempSync(join(tmpdir(), "okm-pack-bin-"));
  const repo = join(import.meta.dir, "..");
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "ok.js"), "export const ok = 1;\n");
    writeManifest(root, {}, { bin: { okm: "./src/ok.js" }, main: "./src/ok.js" });
    const updated = await run(repo, root, ["--update"]);
    expect(updated.code, updated.stderr).toBe(0);
    const snapshot = JSON.parse(readFileSync(join(root, "pack-contract.snap.json"), "utf8")) as {
      bin: unknown;
      main: unknown;
    };
    expect(snapshot.bin).toEqual({ okm: "./src/ok.js" });
    expect(snapshot.main).toBe("./src/ok.js");

    writeFileSync(join(root, "src", "ok.js"), "export const ok = 2;\n");
    const edited = await run(repo, root, []);
    expect(edited.code, edited.stderr).toBe(0);

    writeManifest(root, {}, { bin: { okm: "./src/other.js" }, main: "./src/ok.js" });
    const moved = await run(repo, root, []);
    expect(moved.code).not.toBe(0);
    expect(moved.stderr).toContain("bin differs");
    expect(moved.stderr).toContain("bun ./scripts/pack-contract.ts --update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("a new or removed chunk passes, and a public declaration change fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "okm-pack-chunk-"));
  const repo = join(import.meta.dir, "..");
  const shared = join(root, "dist", "shared");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "ok.js"), "export const ok = 1;\n");
    writeFileSync(join(root, "src", "ok.d.ts"), "export declare const ok: number;\n");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "aaaaaaaa.js"), "export const a = 1;\n");
    writeFileSync(join(shared, "bbbbbbbb.js"), "export const b = 1;\n");
    writeFileSync(join(root, "dist", "index.js"), "export const ok = 1;\n");
    writeManifest(
      root,
      {},
      {
        exports: { ".": { types: "./src/ok.d.ts", import: "./src/ok.js" } },
      },
    );
    const updated = await run(repo, root, ["--update"]);
    expect(updated.code, updated.stderr).toBe(0);
    const snapshot = await Bun.file(join(root, "pack-contract.snap.json")).text();
    expect(snapshot).not.toContain("dist/shared");
    expect(snapshot).not.toContain("aaaaaaaa.js");
    expect(snapshot).toContain("declarations");

    rmSync(join(shared, "aaaaaaaa.js"));
    writeFileSync(join(shared, "cccccccc.js"), "export const a = 1;\n");
    writeFileSync(join(shared, "dddddddd.js"), "export const d = 1;\n");
    const added = await run(repo, root, []);
    expect(added.code, added.stderr).toBe(0);

    rmSync(join(shared, "dddddddd.js"));
    rmSync(join(shared, "bbbbbbbb.js"));
    const removed = await run(repo, root, []);
    expect(removed.code, removed.stderr).toBe(0);

    writeFileSync(join(root, "src", "ok.d.ts"), "export declare const ok: string;\n");
    const edited = await run(repo, root, []);
    expect(edited.code).not.toBe(0);
    expect(edited.stderr).toContain("declaration . differs");
    expect(edited.stderr).toContain("bun ./scripts/pack-contract.ts --update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

/**
 * Writes a fixture manifest. `scripts` is omitted when empty.
 *
 * @param root - Fixture directory
 * @param scripts - Script entries to set
 * @param extra - Further manifest fields, such as `bin` and `main`
 */
function writeManifest(
  root: string,
  scripts: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, unknown>> = {},
): void {
  const manifest: Record<string, unknown> = {
    name: "okm-pack-fixture",
    version: "0.0.0",
    files: ["src", "dist"],
    exports: { ".": { import: "./src/ok.js" } },
    ...extra,
  };
  if (Object.keys(scripts).length > 0) manifest.scripts = scripts;
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Runs the pack contract against a fixture.
 *
 * @param repo - Repository root, so the script path resolves
 * @param root - Fixture package
 * @param args - Extra arguments (`--update`)
 * @returns Exit code and standard error
 */
async function run(
  repo: string,
  root: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stderr: string }> {
  const proc = Bun.spawn(["bun", "./scripts/pack-contract.ts", "--root", root, ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}
