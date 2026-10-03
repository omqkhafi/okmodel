/**
 * The per-export tree-shake check fails when one export keeps the barrel.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportNames } from "../scripts/api-surface.js";
import { repoRoot } from "../scripts/root.js";
import { exportShakeProblems } from "../scripts/size.js";

test("okmodel/pg exports do not keep unrelated modules", () => {
  expect(exportShakeProblems(repoRoot())).toEqual([]);
});

test("public barrels do not export the moved helpers", () => {
  const root = repoRoot();
  const pg = exportNames(readFileSync(join(root, "src/dialects/pg/index.ts"), "utf8"));
  const migrate = exportNames(readFileSync(join(root, "src/tooling/migrate/index.ts"), "utf8"));
  expect(pg).not.toContain("compileColumn");
  expect(pg).not.toContain("emitRowTypes");
  expect(pg).not.toContain("mapPostgresError");
  expect(pg).not.toContain("isOperator");
  expect(migrate).toEqual(["MigrateConfig", "TargetInput", "defineConfig"]);
});

test("an export that imports the rest of the barrel fails the shake check", () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-barrel-"));
  try {
    writeFileSync(join(dir, "pulled-search.ts"), "export const search = 1;\n");
    writeFileSync(join(dir, "pulled-geometry.ts"), "export const geometry = 1;\n");
    writeFileSync(join(dir, "pulled-enum.ts"), "export const enumerated = 1;\n");
    writeFileSync(
      join(dir, "only-text.ts"),
      [
        'import { search } from "./pulled-search.ts";',
        'import { geometry } from "./pulled-geometry.ts";',
        'import { enumerated } from "./pulled-enum.ts";',
        "export const text = search + geometry + enumerated;",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "barrel.ts"), 'export { text } from "./only-text.ts";\n');
    const problems = exportShakeProblems(repoRoot(), [
      {
        from: join(dir, "barrel.ts"),
        name: "text",
        keep: "only-text.ts",
        drop: ["pulled-search.ts", "pulled-geometry.ts", "pulled-enum.ts"],
      },
    ]);
    expect(problems.some((problem) => problem.includes("kept pulled-search.ts"))).toBe(true);
    expect(problems.some((problem) => problem.includes("kept pulled-geometry.ts"))).toBe(true);
    expect(problems.some((problem) => problem.includes("kept pulled-enum.ts"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
