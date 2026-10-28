/**
 * CRLF, BOM, and Windows path handling for migration files and config paths.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import {
  catalogFileText,
  catalogHash,
  loadTrustedCatalog,
  parseCatalog,
  serializeCatalog,
} from "../src/contracts/catalog/document.js";
import { sha256 } from "../src/contracts/sha256.js";
import { OkmError } from "../src/contracts/error.js";
import { locationFromLines } from "../src/contracts/location.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { artifactDir } from "../src/runtime/drift.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { loadMigrations, readMigrationPlan } from "../src/tooling/migrate/files.js";
import { lintMigrationDirectory } from "../src/tooling/migrate/lint.js";
import { projectPath } from "../src/tooling/migrate/paths.js";
import { formatPlan, parsePlan, planMigration } from "../src/tooling/migrate/plan.js";
import { MigrationTextError } from "../src/tooling/migrate/text.js";
import { nodeStartupMessage, nodeSupportsConfigTypes } from "../src/tooling/node-version.js";

const HAND = [
  "-- class: contract",
  "-- name: hand",
  "",
  "-- class: contract",
  "-- kind: drop-table",
  "-- action: ddl",
  "-- lock: ACCESS EXCLUSIVE",
  "-- path: unverified",
  "-- behavior: change",
  "-- transactional: false",
  "-- okm-allow OKM1511: reviewed drop",
  '-- backfill table="public"."logs" key="id" batch=10',
  'drop table "public"."logs";',
  "",
].join("\n");

const CASES = [
  HAND,
  "-- name: hand\n\nselect 1;\n\ntruncate logs;\n",
  "-- class: expand\n-- name: hand\n\nselect 1;\n",
  "-- class: expand\n\n-- no steps\n",
  "-- name: hand\n\n-- okm-allow OKM1542: clear the table once\nselect 1;\ntruncate logs;\ndelete from logs;\n",
  "-- name: hand\n\ndo $$\nbegin\n  delete from logs;\n\n  insert into logs values (1);\nend\n$$;\n",
  ["-- name: hand", "", "select 'hello", "", "-- not a header", "world';", ""].join("\n"),
];

function crlf(text: string): string {
  return text.replaceAll("\n", "\r\n");
}

function loneCr(text: string): string {
  return text.replaceAll("\n", "\r");
}

test("parsePlan treats CRLF, lone CR, and a BOM like LF", () => {
  for (const text of CASES) {
    expect(parsePlan(crlf(text))).toEqual(parsePlan(text));
    expect(parsePlan(loneCr(text))).toEqual(parsePlan(text));
    expect(parsePlan(`\uFEFF${crlf(text)}`)).toEqual(parsePlan(text));
  }
  const parsed = parsePlan(crlf(HAND));
  expect(parsed.class).toBe("contract");
  expect(parsed.name).toBe("hand");
  expect(parsed.steps[0]?.lock).toBe("ACCESS EXCLUSIVE");
  expect(parsed.steps[0]?.path).toBe("unverified");
  expect(parsed.steps[0]?.behavior).toBe("change");
  expect(parsed.steps[0]?.transactional).toBe(false);
  expect(parsed.steps[0]?.allows).toEqual([{ code: "OKM1511", reason: "reviewed drop" }]);
  expect(parsed.steps[0]?.backfill).toEqual({
    table: '"public"."logs"',
    key: ['"id"'],
    batch: 10,
  });
});

test("a formatted plan round-trips when the file is CRLF", () => {
  const before = schema({ tables: [table("tasks", { id: t.identity() })] });
  const after = schema({
    tables: [table("tasks", { id: t.identity(), title: t.text() })],
  });
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    name: "title",
  });
  const text = formatPlan(plan);
  expect(parsePlan(crlf(text))).toEqual(parsePlan(text));
  expect(parsePlan(loneCr(text)).steps.map((step) => step.sql)).toEqual(
    plan.steps.map((step) => step.sql),
  );
});

test("reference-app migrations keep their steps when the bytes are CRLF", () => {
  const directory = join(repoRoot(), "packages/reference-app/migrations");
  for (const file of [
    "0001_init.sql",
    "0002_public_id.sql",
    "0003_drop_share_token.sql",
    "0004_sql_names.sql",
  ]) {
    const text = readFileSync(join(directory, file), "utf8");
    expect(parsePlan(crlf(text))).toEqual(parsePlan(text));
    expect(parsePlan(`\uFEFF${text}`)).toEqual(parsePlan(text));
  }
});

test("UTF-16 migration text is refused", () => {
  expect(() => parsePlan("\u0000t\u0000r\u0000")).toThrow(MigrationTextError);
  try {
    parsePlan("truncate\u0000");
    throw new Error("expected UTF-16");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationTextError);
    if (!(error instanceof MigrationTextError)) return;
    expect(error.reason).toBe("utf16");
    expect(error.code).toBe("invalid");
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain("UTF-16");
  }
});

test("a non-empty file with no steps fails, and -- no steps does not", () => {
  const directory = mkdtempSync(join(tmpdir(), "okm-crlf-steps-"));
  const snapshot = serializeCatalog(catalog([]));
  try {
    writeFileSync(join(directory, "0001_note.sql"), crlf("-- just a note\n"));
    writeFileSync(join(directory, "0001_note.catalog.json"), snapshot);
    expect(() => loadMigrations(directory)).toThrow(MigrationTextError);
    try {
      loadMigrations(directory);
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationTextError);
      if (error instanceof MigrationTextError) expect(error.reason).toBe("no-steps");
    }

    writeFileSync(
      join(directory, "0001_note.sql"),
      crlf("-- class: expand\n-- name: empty\n\n-- no steps\n"),
    );
    expect(loadMigrations(directory)[0]?.steps).toEqual([]);

    writeFileSync(
      join(directory, "0001_note.sql"),
      `\uFEFF${crlf("-- name: hand\n\ntruncate logs;\n")}`,
    );
    const loaded = readMigrationPlan(join(directory, "0001_note.sql"));
    expect(loaded.steps.map((step) => step.sql)).toEqual(["truncate logs"]);
    const findings = lintMigrationDirectory(directory);
    expect(findings.map((item) => item.code)).toContain("OKM1542");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("LF and CRLF truncate are the same lint error", () => {
  const directory = mkdtempSync(join(tmpdir(), "okm-crlf-lint-"));
  const snapshot = serializeCatalog(catalog([]));
  const sql = "-- name: hand\n\ntruncate logs;\n";
  try {
    writeFileSync(join(directory, "0001_hand.catalog.json"), snapshot);
    writeFileSync(join(directory, "0001_hand.sql"), sql);
    const lf = lintMigrationDirectory(directory).map((item) => item.code);
    writeFileSync(join(directory, "0001_hand.sql"), crlf(sql));
    expect(lintMigrationDirectory(directory).map((item) => item.code)).toEqual(lf);
    expect(lf).toContain("OKM1542");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an LF catalog hash is unchanged when CR and a BOM are stripped", () => {
  const built = schema({
    tables: [table("tasks", { id: t.identity(), title: t.text() })],
  }).catalog;
  const text = serializeCatalog(built);
  const hash = catalogHash(built);
  expect(sha256(text)).toBe(hash);
  expect(catalogFileText(text)).toBe(text);
  expect(sha256(catalogFileText(text))).toBe(hash);
  const withCarriageReturns = `\uFEFF${text.split("").join("\r")}`;
  expect(catalogFileText(withCarriageReturns)).toBe(text);
  expect(sha256(catalogFileText(withCarriageReturns))).toBe(hash);
  const loaded = loadTrustedCatalog(withCarriageReturns, hash);
  expect(catalogHash(loaded)).toBe(hash);
  expect(serializeCatalog(loaded)).toBe(text);
  expect(parseCatalog(`\uFEFF${crlf(text)}`).objects.length).toBe(built.objects.length);
  expect(() => catalogFileText("{\u0000}")).toThrow(OkmError);
  try {
    catalogFileText("\u0000", "catalog.hash");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1027");
      expect(error.fieldReason).toBe("utf16");
      expect(error.message).toContain("catalog.hash");
    }
  }
});

test("config paths resolve an absolute spec and a parent spec", () => {
  const root = mkdtempSync(join(tmpdir(), "okm-path-"));
  const nested = join(root, "app");
  mkdirSync(nested);
  const absolute = join(root, "schema.ts");
  try {
    expect(projectPath(nested, absolute)).toBe(absolute);
    expect(projectPath(nested, "../schema.ts")).toBe(resolve(nested, "../schema.ts"));
    expect(projectPath(nested, "../schema.ts")).toBe(absolute);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifactDir drops a trailing slash or backslash", () => {
  expect(artifactDir("/proj/.okm/")).toBe("/proj/.okm");
  expect(artifactDir("/proj/.okm///")).toBe("/proj/.okm");
  expect(artifactDir("C:\\proj\\.okm\\")).toBe("C:\\proj\\.okm");
  expect(artifactDir("C:\\proj\\.okm")).toBe("C:\\proj\\.okm");
});

test("artifactDir uses ./.okm when process.cwd is missing or throws", () => {
  const proc = globalThis.process as { cwd?: () => string };
  const previous = proc.cwd;
  try {
    proc.cwd = undefined;
    expect(artifactDir(undefined)).toBe("./.okm");
    proc.cwd = () => {
      throw new Error("edge");
    };
    expect(artifactDir(undefined)).toBe("./.okm");
    expect(artifactDir("/proj/.okm")).toBe("/proj/.okm");
  } finally {
    proc.cwd = previous;
  }
  expect(artifactDir(undefined)).toBe(`${previous()}/.okm`);
});

test("callerLocation reads a backslash frame", () => {
  expect(locationFromLines(["Error", "    at table (C:\\work\\schema.ts:8:2)"], 0)).toBe(
    "schema.ts:8",
  );
  expect(
    locationFromLines(
      ["Error", "    at location.ts:20:5", "    at table (C:\\work\\schema.ts:8:2)"],
      0,
    ),
  ).toBe("schema.ts:8");
  expect(locationFromLines(["Error", "    at table (/work/schema.ts:3:1)"], 0)).toBe("schema.ts:3");
});

test("okm generate init writes .gitattributes once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-gitattributes-"));
  const root = repoRoot();
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'export const app = schema({ tables: [table("tasks", { id: t.identity() })] });',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        'export default defineConfig({ schema: "./schema.ts" });',
        "",
      ].join("\n"),
    );
    await run(["generate", "init"], { cwd, stdout: () => undefined });
    const path = join(cwd, ".gitattributes");
    expect(readFileSync(path, "utf8")).toBe(
      "migrations/*.sql text eol=lf\n*.catalog.json text eol=lf\n.okm/** text eol=lf\n",
    );
    writeFileSync(path, "existing\n");
    await run(["generate", "again"], { cwd, stdout: () => undefined });
    expect(readFileSync(path, "utf8")).toBe("existing\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an existing .gitattributes is not edited by generate init", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-gitattributes-keep-"));
  const root = repoRoot();
  try {
    writeFileSync(join(cwd, ".gitattributes"), "* text=auto\n");
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'export const app = schema({ tables: [table("tasks", { id: t.identity() })] });',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        'export default defineConfig({ schema: "./schema.ts" });',
        "",
      ].join("\n"),
    );
    await run(["generate", "init"], { cwd, stdout: () => undefined });
    expect(readFileSync(join(cwd, ".gitattributes"), "utf8")).toBe("* text=auto\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Node older than 22.18 is told to use bun --bun okm", () => {
  expect(nodeSupportsConfigTypes("v22.18.0")).toBe(true);
  expect(nodeSupportsConfigTypes("v22.17.9")).toBe(false);
  expect(nodeSupportsConfigTypes("v24.0.0")).toBe(true);
  expect(nodeStartupMessage("v22.17.0", false)).toContain("bun --bun okm");
  expect(nodeStartupMessage("v22.17.0", false)).toContain(">=22.18");
  expect(nodeStartupMessage("v22.18.0", false)).toBeUndefined();
  expect(nodeStartupMessage("v22.17.0", true)).toBeUndefined();
});

test("a zero-step file fails status before any connection", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-crlf-status-"));
  const root = repoRoot();
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { schema } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        "export const app = schema({ tables: [] });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        '  database: "postgres://127.0.0.1:1/none",',
        "});",
        "",
      ].join("\n"),
    );
    mkdirSync(join(cwd, "migrations"));
    writeFileSync(join(cwd, "migrations/0001_note.sql"), crlf("-- a comment only\n"));
    writeFileSync(join(cwd, "migrations/0001_note.catalog.json"), serializeCatalog(catalog([])));
    try {
      await run(["migrate", "status"], { cwd, stdout: () => undefined });
      throw new Error("expected no-steps");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationTextError);
      if (error instanceof MigrationTextError) expect(error.reason).toBe("no-steps");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
