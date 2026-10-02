import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { linkSelfPackage } from "../scripts/link-package.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("package exports resolve under node and bun", async () => {
  linkSelfPackage();
  const source = [
    'import * as okmodel from "okmodel";',
    'import * as pg from "okmodel/pg";',
    'import * as migrate from "okmodel/migrate";',
    'import * as testing from "okmodel/testing";',
    'import * as postgresjs from "okmodel/pg/postgresjs";',
    'import * as pglite from "okmodel/pg/pglite";',
    "const kinds = [okmodel, pg, migrate, testing, postgresjs, pglite].map((entry) => typeof entry);",
    "if (kinds.some((kind) => kind !== 'object')) throw new Error(kinds.join(','));",
    "console.log('ok');",
  ].join("\n");

  for (const runtime of ["node", "bun"]) {
    const args =
      runtime === "node" ? ["--input-type=module", "--eval", source] : ["--eval", source];
    const proc = Bun.spawn([runtime, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe("ok");
  }
});

test("each export's JavaScript file has a sibling declaration", () => {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.exports)) {
    throw new Error("package.json exports are missing");
  }
  for (const value of Object.values(parsed.exports)) {
    if (!isExport(value)) {
      throw new Error("an export is missing types or import");
    }
    expect(existsSync(join(root, value.import)), value.import).toBe(true);
    expect(existsSync(join(root, value.types)), value.types).toBe(true);
    expect(value.types).toBe(value.import.replace(/\.js$/, ".d.ts"));
  }
});

test("bins print the package version under node and bun", async () => {
  const version = readVersion();
  for (const bin of ["dist/okm.js", "dist/okmodel.js"]) {
    for (const runtime of ["node", "bun"]) {
      const proc = Bun.spawn([runtime, bin, "--version"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      expect(code, stderr).toBe(0);
      expect(stdout.trim()).toBe(version);
    }
  }
});

function readVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error("package.json has no string version");
  }
  return parsed.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExport(value: unknown): value is { readonly import: string; readonly types: string } {
  return isRecord(value) && typeof value.import === "string" && typeof value.types === "string";
}
