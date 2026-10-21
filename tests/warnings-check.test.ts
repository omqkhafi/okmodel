/**
 * `okm check` lists project warning ignores and refuses one without a reason.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");

function project(warnings: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-warn-"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      'const notes = table("notes", { id: identity(), title: text() });',
      "export const app = schema({ tables: [notes] });",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      warnings,
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "migrations"));
  return cwd;
}

function run(
  cwd: string,
  json: boolean,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const args = json ? [cli, "check", "--json"] : [cli, "check"];
  const proc = spawnSync("bun", args, { cwd, encoding: "utf8" });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

test("okm check lists a project ignore with its reason", () => {
  const cwd = project('  warnings: { ignore: [{ rule: "unordered-limit", reason: "one row" }] },');
  const human = run(cwd, false);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("ignore unordered-limit:");
  expect(human.stdout).toContain("one row");
  const json = run(cwd, true);
  expect(json.code).toBe(0);
  const envelope = JSON.parse(json.stdout) as {
    data: {
      ignores?: readonly {
        rule: string;
        reason: {
          untrusted: true;
          origin: string;
          text: string;
          truncated: boolean;
          modified: boolean;
        };
      }[];
    };
    warnings: readonly { summary: string; place?: string; level?: string }[];
  };
  expect(envelope.data.ignores).toEqual([
    {
      rule: "unordered-limit",
      reason: {
        untrusted: true,
        origin: "user.query",
        text: "one row",
        truncated: false,
        modified: false,
      },
    },
  ]);
  expect(
    envelope.warnings.some((item) => item.place === "unordered-limit" && item.level === "hint"),
  ).toBe(true);
});

test("okm check refuses an ignore without a reason", () => {
  const cwd = project('  warnings: { ignore: [{ rule: "deep-offset" }] },');
  const result = run(cwd, true);
  expect(result.code).toBe(2);
  expect(result.stdout).toContain("reason");
});
