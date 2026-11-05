import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { weakAllowReason } from "../src/tooling/migrate/allows.js";
import {
  DEFAULT_DROP_REASON,
  terminalConfirm,
  type PlannedDrop,
} from "../src/tooling/migrate/confirm-drop.js";
import { generateProject } from "../src/tooling/migrate/project.js";

const root = join(import.meta.dir, "..");
const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));

let first = "";
let cwd = "";

// Bun keeps a module per path, so the changed schema lives in a second project.
beforeEach(async () => {
  first = project(["email: text()", "uname: text().nullable()"]);
  await generateProject(first, "init", []);
  cwd = project(["email: text()"]);
  cpSync(join(first, "migrations"), join(cwd, "migrations"), { recursive: true });
});

afterEach(() => {
  rmSync(first, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function project(columns: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "okm-confirm-drop-"));
  writeFileSync(
    join(dir, "okmodel.config.ts"),
    `import { defineConfig } from ${migrate};\nexport default defineConfig({ schema: "./schema.ts" });\n`,
  );
  writeFileSync(
    join(dir, "schema.ts"),
    [
      `import { schema, table, text } from ${pg};`,
      `const users = table("users", { ${columns.join(", ")} });`,
      "export const app = schema({ tables: [users] });",
      "",
    ].join("\n"),
  );
  return dir;
}

test("a confirmed drop writes the override above the statement and lints clean", async () => {
  const seen: PlannedDrop[][] = [];
  const written = await generateProject(cwd, "remove", [], (drops) => {
    seen.push([...drops]);
    return Promise.resolve("uname is no longer read");
  });
  expect(seen).toEqual([
    [{ step: 1, code: "OKM1512", sql: 'alter table "public"."users" drop column "uname"' }],
  ]);
  if (written === undefined) throw new Error("generate wrote nothing");
  expect(written.findings.filter((item) => item.severity === "error")).toEqual([]);
  expect(readFileSync(written.path, "utf8")).toContain(
    '-- okm-allow OKM1512: uname is no longer read\nalter table "public"."users" drop column "uname";',
  );
});

test("a declined drop writes no migration and refuses with OKM1510", async () => {
  let caught: unknown;
  try {
    await generateProject(cwd, "remove", [], () => Promise.resolve(undefined));
  } catch (error) {
    caught = error;
  }
  expect(OkmError.from(caught).code).toBe("OKM1510");
  expect(existsSync(join(cwd, "migrations", "0002_remove.sql"))).toBe(false);
  expect(existsSync(join(cwd, "migrations", "0002_remove.catalog.json"))).toBe(false);
});

test("without a confirm callback the drop stays an error finding", async () => {
  const written = await generateProject(cwd, "remove", []);
  if (written === undefined) throw new Error("generate wrote nothing");
  expect(written.findings.map((item) => item.code)).toContain("OKM1512");
  expect(readFileSync(written.path, "utf8")).not.toContain("okm-allow");
});

test("terminal confirm: no declines, an empty reason uses the default", async () => {
  const drops: PlannedDrop[] = [{ step: 1, code: "OKM1512", sql: "alter table t drop column c" }];
  const answers = (...lines: string[]) => {
    const queue = [...lines];
    return (): Promise<string> => Promise.resolve(queue.shift() ?? "");
  };
  let listed = "";
  const write = (text: string): void => {
    listed += text;
  };
  expect(await terminalConfirm(answers("n"), write)(drops)).toBeUndefined();
  expect(await terminalConfirm(answers(""), write)(drops)).toBeUndefined();
  expect(await terminalConfirm(answers("Y", ""), write)(drops)).toBe(DEFAULT_DROP_REASON);
  expect(await terminalConfirm(answers("yes", "column moved to profiles"), write)(drops)).toBe(
    "column moved to profiles",
  );
  expect(listed).toContain("step 1 OKM1512: alter table t drop column c");
  expect(weakAllowReason(DEFAULT_DROP_REASON, "OKM1512")).toBeUndefined();
});
