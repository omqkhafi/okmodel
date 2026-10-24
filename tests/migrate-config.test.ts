/**
 * Global `--config` (D298).
 *
 * Discovery stays `okmodel.config.ts` in the working directory. `--config`
 * loads another file, including from a different working directory.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { run } from "../src/tooling/migrate/commands.js";
import { status } from "../src/tooling/migrate/api.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

describe("--config", () => {
  test("loads a config from another working directory", async () => {
    const project = mkdtempSync(join(tmpdir(), "okm-config-"));
    const other = mkdtempSync(join(tmpdir(), "okm-other-"));
    try {
      writeProject(project);
      const lines: string[] = [];
      await run(["--config", join(project, "okmodel.config.ts"), "build"], {
        cwd: other,
        stdout: (text) => lines.push(text),
      });
      expect(lines.join("")).toContain(join(project, ".okm"));
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a missing config names okmodel.config.ts and --config", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "okm-missing-"));
    try {
      const error = await rejected(["build"], cwd);
      expect(error.code).toBe("invalid");
      expect(error.message).toContain("okmodel.config.ts");
      expect(error.message).not.toContain("okm.config.ts");
      expect(error.fix?.summary).toContain("--config");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("--config names the path that was passed when that file is missing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "okm-missing-named-"));
    try {
      const error = await rejected(["--config", "nope.config.ts", "build"], cwd);
      expect(error.message).toContain("nope.config.ts");
      expect(error.message).not.toContain("okmodel.config.ts");
      const programmatic = await status({ cwd, config: "nope.config.ts" }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(programmatic).toBeInstanceOf(OkmError);
      if (!(programmatic instanceof OkmError)) return;
      expect(programmatic.message).toContain("nope.config.ts");
      expect(programmatic.message).not.toContain("okmodel.config.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("--config without a path is refused", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "okm-config-flag-"));
    try {
      const error = await rejected(["--config"], cwd);
      expect(error.message).toContain("--config needs a path");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function writeProject(cwd: string): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${pg};`,
      "export const app = schema({",
      '  tables: [table("items", { id: t.integer().primaryKey() })],',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      "});",
      "",
    ].join("\n"),
  );
}

async function rejected(argv: readonly string[], cwd: string): Promise<OkmError> {
  try {
    await run(argv, { cwd, stdout: () => {} });
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error(`${argv.join(" ")} should have failed`);
}
