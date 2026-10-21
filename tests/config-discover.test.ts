/**
 * Nearest `okmodel.config.ts`, and the refusal when two are equally near.
 *
 * No network and no database.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";
import { configDistance, pickNearestConfig } from "../src/tooling/migrate/discover.js";
import { parseWorkspaceAnswer } from "../src/tooling/init/monorepo.js";
import { posixRelative, type WorkspacePackage } from "../src/tooling/workspaces.js";

const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");

test("windows path distance treats two packages as a tie", () => {
  const win = path.win32;
  const cwd = "C:\\repo";
  const api = "C:\\repo\\packages\\api\\okmodel.config.ts";
  const web = "C:\\repo\\packages\\web\\okmodel.config.ts";
  expect(configDistance(cwd, api, win)).toBe(2);
  expect(configDistance(cwd, web, win)).toBe(2);
  const picked = pickNearestConfig(cwd, [api, web], win);
  expect(picked.kind).toBe("many");
  expect(posixRelative("C:\\repo\\packages\\api", "C:\\repo\\okmodel.base.ts", win)).toBe(
    "../../okmodel.base.ts",
  );
});

test("a workspace answer accepts numbers, names, and all", () => {
  const packages = [
    packageAt("/repo/packages/api", "packages/api", "@acme/api"),
    packageAt("/repo/packages/web", "packages/web", "@acme/web"),
  ];
  expect(parseWorkspaceAnswer("1, web", packages)).toEqual({
    ok: true,
    rels: ["packages/api", "packages/web"],
  });
  expect(parseWorkspaceAnswer("*", packages).ok).toBe(true);
  expect(parseWorkspaceAnswer("", packages)).toEqual({ ok: false, reason: "empty" });
  expect(parseWorkspaceAnswer("9", packages).ok).toBe(false);
});

test("two equally near configs fail check and migrate status", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-discover-"));
  try {
    writeConfig(join(cwd, "packages/api"));
    writeConfig(join(cwd, "packages/web"));
    for (const args of [
      ["check", "--json"],
      ["migrate", "status", "--json"],
    ]) {
      const result = run(args, cwd);
      expect(result.code, args.join(" ")).toBe(3);
      const body = JSON.parse(result.stdout) as {
        errors: readonly { code?: string; summary?: string }[];
      };
      expect(body.errors[0]?.code).toBe("OKM1890");
      expect(body.errors[0]?.summary).toContain("packages/api/okmodel.config.ts");
      expect(body.errors[0]?.summary).toContain("packages/web/okmodel.config.ts");
    }
    const picked = run(["check", "--json", "--config", "packages/api/okmodel.config.ts"], cwd);
    expect(`${picked.stdout}\n${picked.stderr}`).not.toContain("OKM1890");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("one config is printed before the check report", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-discover-one-"));
  try {
    writeSchema(cwd);
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        '  migrations: "./migrations",',
        "});",
        "",
      ].join("\n"),
    );
    mkdirSync(join(cwd, "migrations"));
    const result = run(["check"], cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ok\n");
    expect(result.stderr).toBe(`config: ${join(cwd, "okmodel.config.ts")}\n`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function writeConfig(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "okmodel.config.ts"), "export const marker = true;\n");
}

function writeSchema(cwd: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      'export const app = schema({ tables: [table("notes", { id: identity(), title: text() })] });',
      "",
    ].join("\n"),
  );
}

function packageAt(dir: string, rel: string, name: string): WorkspacePackage {
  return { dir, rel, name, dependencies: new Set() };
}

function run(
  args: readonly string[],
  cwd: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const proc = spawnSync("bun", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: 20_000,
  });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}
